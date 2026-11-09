create table public.ai_request_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  request_times timestamptz[] not null default '{}'
);
alter table public.ai_request_limits enable row level security;
revoke all on table public.ai_request_limits from public, anon, authenticated;

create function public.consume_ai_request(p_user_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  recent timestamptz[];
  v_now timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 91273));
  v_now := clock_timestamp();
  insert into public.ai_request_limits (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select coalesce(array_agg(request_time), '{}'::timestamptz[])
  into recent
  from public.ai_request_limits limits,
    unnest(limits.request_times) as request_time
  where limits.user_id = p_user_id
    and request_time > v_now - interval '1 hour';
  if cardinality(recent) >= 30 then return false; end if;
  update public.ai_request_limits
  set request_times = array_append(recent, v_now)
  where user_id = p_user_id;
  return true;
end;
$$;
revoke all on function public.consume_ai_request(uuid) from public, anon, authenticated;
grant execute on function public.consume_ai_request(uuid) to service_role;