alter table public.planner_tasks add column completed_at timestamptz;

-- Existing completions on active boats cannot be dated reliably.
update public.planner_tasks t
set completed_at = statement_timestamp()
where t.completed and not exists (
  select 1 from public.boat_requests r
  where r.status = 'active'
    and t.plan_id::text in (r.requester_plan ->> 'id', r.partner_plan ->> 'id')
);

create function public.record_task_completion_time()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.completed_at := case when new.completed then statement_timestamp() else null end;
  elsif new.completed is distinct from old.completed then
    new.completed_at := case when new.completed then statement_timestamp() else null end;
  else
    new.completed_at := old.completed_at;
  end if;
  return new;
end;
$$;

revoke all on function public.record_task_completion_time() from public, anon, authenticated;
create trigger planner_tasks_record_completion_time
before insert or update on public.planner_tasks
for each row execute function public.record_task_completion_time();

create or replace function public.boat_stake_outcome(p_request_id text)
returns table(settled boolean, requester_action text, partner_action text, reason text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  req public.boat_requests;
  r_at timestamptz;
  p_at timestamptz;
  r_unknown boolean;
  p_unknown boolean;
  r_ok boolean;
  p_ok boolean;
  expired boolean;
  r_act text;
  p_act text;
  why text;
begin
  select * into req from public.boat_requests where id = p_request_id and status = 'active';
  if not found then raise exception 'No active boat found'; end if;

  select max(t.completed_at), coalesce(bool_or(t.completed_at is null), false)
  into r_at, r_unknown
  from public.planner_tasks t
  where t.plan_id = (req.requester_plan ->> 'id')::uuid
  having bool_and(t.completed);
  select max(t.completed_at), coalesce(bool_or(t.completed_at is null), false)
  into p_at, p_unknown
  from public.planner_tasks t
  where t.plan_id = (req.partner_plan ->> 'id')::uuid
  having bool_and(t.completed);

  if (coalesce(r_unknown, false) or coalesce(p_unknown, false))
    and not (req.requester_forfeited_at is not null and req.partner_forfeited_at is not null) then
    raise exception 'Cannot settle boat: an existing completion time is unknown; manual review required';
  end if;
  r_ok := r_at is not null and r_at <= req.deadline_at;
  p_ok := p_at is not null and p_at <= req.deadline_at;
  expired := now() >= req.deadline_at;

  if req.requester_forfeited_at is not null or req.partner_forfeited_at is not null then
    if req.requester_forfeited_at is not null and req.partner_forfeited_at is not null then
      r_act := 'capture'; p_act := 'capture'; why := 'both_failed';
    elsif req.requester_forfeited_at is not null then
      if p_ok then
        r_act := 'capture'; p_act := 'void'; why := 'partner_finished';
      elsif expired then
        r_act := 'capture'; p_act := 'capture'; why := 'both_failed';
      end if;
    elsif r_ok then
      r_act := 'void'; p_act := 'capture'; why := 'requester_finished';
    elsif expired then
      r_act := 'capture'; p_act := 'capture'; why := 'both_failed';
    end if;
  elsif req.stake_mode = 'racing' then
    if r_ok and p_ok and r_at = p_at then
      r_act := 'void'; p_act := 'void'; why := 'tie';
    elsif r_ok and (not p_ok or r_at < p_at) then
      r_act := 'void'; p_act := 'capture'; why := 'requester_won';
    elsif p_ok then
      r_act := 'capture'; p_act := 'void'; why := 'partner_won';
    elsif expired then
      r_act := 'capture'; p_act := 'capture'; why := 'both_failed';
    end if;
  elsif r_ok and p_ok then
    r_act := 'void'; p_act := 'void'; why := 'both_finished';
  elsif expired then
    if r_ok then r_act := 'void'; p_act := 'capture'; why := 'requester_finished';
    elsif p_ok then r_act := 'capture'; p_act := 'void'; why := 'partner_finished';
    else r_act := 'capture'; p_act := 'capture'; why := 'both_failed';
    end if;
  end if;

  if r_act is null then
    return query select false, null::text, null::text, 'in_progress'::text;
    return;
  end if;
  if req.requester_bet_cents = 0 then r_act := 'none'; end if;
  if req.partner_bet_cents = 0 then p_act := 'none'; end if;
  return query select true, r_act, p_act, why;
end;
$$;

-- Protect both participants and their payment records until money is settled.
create function public.account_has_unresolved_boat(p_uid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.pairings p
    join public.boat_requests r on r.id = p.id
    where p_uid in (p.owner_uid, p.partner_uid)
      and r.status in ('pending', 'review', 'active')
  ) or exists (
    select 1 from public.boat_stakes s
    where (s.user_uid = p_uid or exists (
      select 1 from public.pairings p
      where p.id = s.request_id and p_uid in (p.owner_uid, p.partner_uid)
    ))
      and (s.status in ('created', 'authorized')
        or (s.status = 'captured' and (s.payout_status is null or s.payout_status = 'failed')))
  );
$$;
revoke all on function public.account_has_unresolved_boat(uuid) from public, anon, authenticated;
grant execute on function public.account_has_unresolved_boat(uuid) to service_role;

create function public.block_unresolved_boat_deletion()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_schema = 'auth' then
    if public.account_has_unresolved_boat(old.id) then
      raise exception 'Account has an unresolved boat or payment';
    end if;
  elsif exists (
    select 1 from public.boat_requests r
    where r.id = old.id and r.status in ('pending', 'review', 'active')
  ) or exists (
    select 1 from public.boat_stakes s
    where s.request_id = old.id
      and (s.status in ('created', 'authorized')
        or (s.status = 'captured' and (s.payout_status is null or s.payout_status = 'failed')))
  ) then
    raise exception 'Pairing has an unresolved boat or payment';
  end if;
  return old;
end;
$$;
revoke all on function public.block_unresolved_boat_deletion() from public, anon, authenticated;
create trigger users_block_unresolved_boat_deletion
before delete on auth.users for each row
execute function public.block_unresolved_boat_deletion();
create trigger pairings_block_unresolved_boat_deletion
before delete on public.pairings for each row
execute function public.block_unresolved_boat_deletion();