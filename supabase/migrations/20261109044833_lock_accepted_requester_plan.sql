create function public.lock_reviewed_requester_plan()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.status = 'review' and new.cycle_id = old.cycle_id then
    if new.status = 'active' then
      if (new.requester_plan - 'mode') is distinct from (old.requester_plan - 'mode')
        or new.requester_plan ->> 'mode' is distinct from 'inferno' then
        raise exception 'The requester plan cannot be changed after the partner responds. Cancel and send a new request.';
      end if;
    elsif new.requester_plan is distinct from old.requester_plan then
      raise exception 'The requester plan cannot be changed after the partner responds. Cancel and send a new request.';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.lock_reviewed_requester_plan() from public, anon, authenticated;

create trigger boat_requests_lock_reviewed_requester_plan
before update on public.boat_requests
for each row execute function public.lock_reviewed_requester_plan();