-- A pairing reuses its request row, but settlement belongs to one cycle only.
create function public.reset_boat_cycle_settlement()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.cycle_id is distinct from old.cycle_id then
    new.settled_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.reset_boat_cycle_settlement() from public, anon, authenticated;

create trigger boat_requests_reset_cycle_settlement
before update of cycle_id on public.boat_requests
for each row execute function public.reset_boat_cycle_settlement();

-- Repair live cycles that inherited the previous cycle's settlement timestamp.
update public.boat_requests
set settled_at = null, updated_at = now()
where status in ('pending', 'review', 'active')
  and settled_at is not null;