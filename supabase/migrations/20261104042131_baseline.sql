SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";

CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";

COMMENT ON SCHEMA "public" IS 'standard public schema';

CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";

CREATE OR REPLACE FUNCTION "public"."block_delete_of_boat_plan"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if current_user = 'authenticated' and exists (
    select 1 from public.boat_requests r
    where r.status in ('pending', 'review', 'active')
      and old.id::text in (r.requester_plan ->> 'id', r.partner_plan ->> 'id')
  ) then
    raise exception 'This plan is on a boat that has not finished yet';
  end if;
  return old;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."boat_stake_outcome"("p_request_id" "text") RETURNS TABLE("settled" boolean, "requester_action" "text", "partner_action" "text", "reason" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  req public.boat_requests;
  r_at timestamptz;
  p_at timestamptz;
  r_ok boolean;
  p_ok boolean;
  expired boolean;
  r_act text;
  p_act text;
  why text;
begin
  select * into req from public.boat_requests where id = p_request_id and status = 'active';
  if not found then raise exception 'No active boat found'; end if;

  select max(t.updated_at) into r_at
  from public.planner_tasks t
  where t.plan_id = (req.requester_plan ->> 'id')::uuid
  having bool_and(t.completed);
  select max(t.updated_at) into p_at
  from public.planner_tasks t
  where t.plan_id = (req.partner_plan ->> 'id')::uuid
  having bool_and(t.completed);

  r_ok := r_at is not null and r_at <= req.deadline_at;
  p_ok := p_at is not null and p_at <= req.deadline_at;
  expired := now() >= req.deadline_at;

  if req.stake_mode = 'racing' then
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

SET default_tablespace = '';

SET default_table_access_method = "heap";

CREATE TABLE IF NOT EXISTS "public"."boat_stakes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "request_id" "text" NOT NULL,
    "cycle_id" "uuid" NOT NULL,
    "user_uid" "uuid" NOT NULL,
    "amount_cents" integer NOT NULL,
    "paypal_order_id" "text" NOT NULL,
    "authorization_id" "text",
    "payer_email" "text",
    "status" "text" DEFAULT 'created'::"text" NOT NULL,
    "authorized_at" timestamp with time zone,
    "reauthorized_at" timestamp with time zone,
    "at_risk" boolean DEFAULT false NOT NULL,
    "payout_status" "text",
    "payout_attempts" integer DEFAULT 0 NOT NULL,
    "payout_failed_at" timestamp with time zone,
    "payout_batch_id" "text",
    "capture_id" "text",
    "planned_action" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "boat_stakes_amount_cents_check" CHECK ((("amount_cents" >= 1) AND ("amount_cents" <= 50000))),
    CONSTRAINT "boat_stakes_payout_status_check" CHECK (("payout_status" = ANY (ARRAY['sent'::"text", 'skipped'::"text", 'failed'::"text", 'refunded'::"text"]))),
    CONSTRAINT "boat_stakes_planned_action_check" CHECK (("planned_action" = ANY (ARRAY['capture'::"text", 'void'::"text"]))),
    CONSTRAINT "boat_stakes_status_check" CHECK (("status" = ANY (ARRAY['created'::"text", 'authorized'::"text", 'captured'::"text", 'voided'::"text", 'failed'::"text", 'unpaid'::"text", 'refunded'::"text"])))
);

CREATE OR REPLACE FUNCTION "public"."boat_stakes_to_release"() RETURNS SETOF "public"."boat_stakes"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select s.* from public.boat_stakes s
  where s.status in ('created', 'authorized')
    and not exists (
      select 1 from public.boat_requests r
      where r.id = s.request_id and r.cycle_id = s.cycle_id
        and r.status in ('pending', 'review', 'active')
    );
$$;

CREATE OR REPLACE FUNCTION "public"."boats_to_settle"() RETURNS TABLE("id" "text", "cycle_id" "uuid", "requester_uid" "uuid", "partner_uid" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select r.id, r.cycle_id, r.requester_uid, r.partner_uid
  from public.boat_requests r
  where r.status = 'active' and r.settled_at is null;
$$;

CREATE OR REPLACE FUNCTION "public"."cancel_boat_request"("p_request_id" "text", "p_cycle_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  update public.boat_requests set status = 'cancelled', updated_at = now()
  where id = p_request_id and cycle_id = p_cycle_id and requester_uid = auth.uid() and status in ('pending', 'review');
  if not found then raise exception 'This request can no longer be cancelled'; end if;
end;
$$;

CREATE TABLE IF NOT EXISTS "public"."boat_requests" (
    "id" "text" NOT NULL,
    "cycle_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "requester_uid" "uuid" NOT NULL,
    "partner_uid" "uuid" NOT NULL,
    "status" "text" NOT NULL,
    "requester_plan" "jsonb" NOT NULL,
    "partner_plan" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "stake_mode" "text" DEFAULT 'collaborate'::"text" NOT NULL,
    "deadline_at" timestamp with time zone,
    "requester_bet_cents" integer DEFAULT 0 NOT NULL,
    "partner_bet_cents" integer DEFAULT 0 NOT NULL,
    "settled_at" timestamp with time zone,
    CONSTRAINT "boat_requests_check" CHECK (("requester_uid" <> "partner_uid")),
    CONSTRAINT "boat_requests_partner_bet_cents_check" CHECK ((("partner_bet_cents" >= 0) AND ("partner_bet_cents" <= 50000))),
    CONSTRAINT "boat_requests_requester_bet_cents_check" CHECK ((("requester_bet_cents" >= 0) AND ("requester_bet_cents" <= 50000))),
    CONSTRAINT "boat_requests_stake_mode_check" CHECK (("stake_mode" = ANY (ARRAY['collaborate'::"text", 'racing'::"text"]))),
    CONSTRAINT "boat_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'review'::"text", 'active'::"text", 'completed'::"text", 'denied'::"text", 'cancelled'::"text"])))
);

CREATE OR REPLACE FUNCTION "public"."create_boat_request"("p_pairing_id" "text", "p_requester_plan" "jsonb") RETURNS "public"."boat_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  paired public.pairings;
  current_request public.boat_requests;
  created public.boat_requests;
  requester_plan_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if coalesce(jsonb_typeof(p_requester_plan -> 'tasks'), '') <> 'array' then
    raise exception 'A plan needs at least one step to be on a boat';
  end if;
  if jsonb_array_length(p_requester_plan -> 'tasks') < 1 then
    raise exception 'A plan needs at least one step to be on a boat';
  end if;

  requester_plan_id := (p_requester_plan ->> 'id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended(p_pairing_id, 0));
  select * into paired from public.pairings where id = p_pairing_id
    and (owner_uid = auth.uid() or partner_uid = auth.uid()) for update;
  if not found then raise exception 'Pairing not found'; end if;
  if not exists (
    select 1 from public.planner_plans
    where id = requester_plan_id and owner_uid = auth.uid()
  ) then raise exception 'Choose one of your saved plans'; end if;
  if not exists (
    select 1 from public.planner_tasks where plan_id = requester_plan_id
  ) then raise exception 'A plan needs at least one saved step to be on a boat'; end if;

  select * into current_request from public.boat_requests where id = p_pairing_id for update;
  if found and current_request.status in ('pending', 'review', 'active') then
    raise exception 'This pair already has an active boat request';
  end if;
  insert into public.boat_requests (id, requester_uid, partner_uid, status, requester_plan)
  values (
    p_pairing_id, auth.uid(),
    case when paired.owner_uid = auth.uid() then paired.partner_uid else paired.owner_uid end,
    'pending', p_requester_plan
  )
  on conflict (id) do update set
    cycle_id = gen_random_uuid(), requester_uid = excluded.requester_uid,
    partner_uid = excluded.partner_uid, status = excluded.status,
    requester_plan = excluded.requester_plan, partner_plan = null,
    created_at = now(), updated_at = now()
  returning * into created;
  return created;
end;
$$;

CREATE TABLE IF NOT EXISTS "public"."pairing_invites" (
    "code" "text" NOT NULL,
    "owner_uid" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pairing_invites_code_check" CHECK (("code" ~ '^[A-HJ-NP-Z2-9]{12}$'::"text"))
);

CREATE OR REPLACE FUNCTION "public"."create_pairing_invite"("p_code" "text") RETURNS "public"."pairing_invites"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare created public.pairing_invites;
begin
  if auth.uid() is null or p_code !~ '^[A-HJ-NP-Z2-9]{12}$' then
    raise exception 'Invalid invite request';
  end if;
  delete from public.pairing_invites where owner_uid = auth.uid() and created_at <= now() - interval '5 minutes';
  insert into public.pairing_invites (code, owner_uid)
  values (p_code, auth.uid())
  returning * into created;
  return created;
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."decide_boat_request"("p_request_id" "text", "p_cycle_id" "uuid", "p_decision" "text", "p_requester_plan" "jsonb" DEFAULT NULL::"jsonb") RETURNS "public"."boat_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  current_request public.boat_requests;
  updated public.boat_requests;
  v_requester_plan jsonb;
  requester_plan_id uuid;
  partner_plan_id uuid;
  requester_saved_plan public.planner_plans;
  requester_saved_tasks jsonb;
  partner_saved_plan public.planner_plans;
  partner_saved_tasks jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_decision not in ('accept', 'deny') then raise exception 'Invalid request decision'; end if;
  if p_decision = 'deny' then
    update public.boat_requests set
      status = 'denied',
      updated_at = now()
    where id = p_request_id
      and cycle_id = p_cycle_id
      and (
        (status = 'pending' and partner_uid = auth.uid())
        or (
          status = 'review'
          and (requester_uid = auth.uid() or partner_uid = auth.uid())
        )
      )
    returning * into updated;
    if not found then
      raise exception 'This boat request can no longer be denied';
    end if;
    return updated;
  end if;

  select * into current_request
  from public.boat_requests
  where id = p_request_id
    and cycle_id = p_cycle_id
    and requester_uid = auth.uid()
    and status = 'review'
  for update;
  if not found then
    raise exception 'This proposal is no longer waiting for your decision';
  end if;
  if current_request.partner_plan is null then
    raise exception 'The partner has not submitted a plan';
  end if;

  v_requester_plan := coalesce(p_requester_plan, current_request.requester_plan);
  if coalesce(jsonb_typeof(v_requester_plan -> 'tasks'), '') <> 'array'
    or jsonb_array_length(v_requester_plan -> 'tasks') < 1 then
    raise exception 'A plan needs at least one step to be on a boat';
  end if;
  if coalesce(jsonb_typeof(current_request.partner_plan -> 'tasks'), '') <> 'array'
    or jsonb_array_length(current_request.partner_plan -> 'tasks') < 1 then
    raise exception 'A plan needs at least one step to be on a boat';
  end if;

  requester_plan_id := (v_requester_plan ->> 'id')::uuid;
  partner_plan_id := (current_request.partner_plan ->> 'id')::uuid;

  select * into requester_saved_plan
  from public.planner_plans
  where id = requester_plan_id and owner_uid = current_request.requester_uid
  for update;
  if not found then raise exception 'Choose one of your saved plans'; end if;

  select jsonb_agg(
    jsonb_build_object(
      'id', task.id,
      'title', task.title,
      'estimatedMinutes', task.estimated_minutes,
      'category', task.category,
      'dependsOn', task.depends_on
    )
    order by task.position
  )
  into requester_saved_tasks
  from public.planner_tasks task
  where task.plan_id = requester_plan_id;
  if requester_saved_tasks is null
    or requester_saved_tasks is distinct from (v_requester_plan -> 'tasks')
    or requester_saved_plan.title is distinct from (v_requester_plan ->> 'title')
    or requester_saved_plan.description is distinct from (v_requester_plan ->> 'description')
    or requester_saved_plan.total_estimated_minutes is distinct from
      ((v_requester_plan ->> 'totalEstimatedMinutes')::integer)
    or requester_saved_plan.mode is distinct from (v_requester_plan ->> 'mode') then
    raise exception 'Your plan changed after AI review. Review it again before accepting.';
  end if;

  select * into partner_saved_plan
  from public.planner_plans
  where id = partner_plan_id and owner_uid = current_request.partner_uid
  for update;
  if not found then
    raise exception 'The partner plan is no longer available';
  end if;
  select jsonb_agg(
    jsonb_build_object(
      'id', task.id,
      'title', task.title,
      'estimatedMinutes', task.estimated_minutes,
      'category', task.category,
      'dependsOn', task.depends_on
    )
    order by task.position
  )
  into partner_saved_tasks
  from public.planner_tasks task
  where task.plan_id = partner_plan_id;
  if partner_saved_tasks is null
    or partner_saved_tasks is distinct from (current_request.partner_plan -> 'tasks')
    or partner_saved_plan.title is distinct from
      (current_request.partner_plan ->> 'title')
    or partner_saved_plan.description is distinct from
      (current_request.partner_plan ->> 'description')
    or partner_saved_plan.total_estimated_minutes is distinct from
      ((current_request.partner_plan ->> 'totalEstimatedMinutes')::integer)
    or partner_saved_plan.mode is distinct from
      (current_request.partner_plan ->> 'mode') then
    raise exception 'The partner plan changed after AI review. Ask them to submit it again.';
  end if;

  perform set_config('app.allow_boat_inferno_promotion', 'true', true);
  update public.planner_plans
  set mode = 'inferno', updated_at = now()
  where id = requester_plan_id and owner_uid = current_request.requester_uid;
  update public.planner_plans
  set mode = 'inferno', updated_at = now()
  where id = partner_plan_id and owner_uid = current_request.partner_uid;

  update public.boat_requests set
    requester_plan = jsonb_set(v_requester_plan, '{mode}', '"inferno"', true),
    partner_plan = jsonb_set(
      current_request.partner_plan,
      '{mode}',
      '"inferno"',
      true
    ),
    status = 'active',
    updated_at = now()
  where id = p_request_id
    and cycle_id = p_cycle_id
    and requester_uid = auth.uid()
    and status = 'review'
  returning * into updated;
  if not found then raise exception 'This proposal is no longer waiting for your decision'; end if;
  return updated;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."delete_planner_task"("p_plan_id" "uuid", "p_task_id" "text", "p_owner_uid" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare target public.planner_tasks;
begin
  if auth.uid() is null or auth.uid() <> p_owner_uid then raise exception 'Not authorized'; end if;
  perform 1 from public.planner_plans where id = p_plan_id and owner_uid = auth.uid() for update;
  if not found then raise exception 'Plan not found'; end if;
  select * into target from public.planner_tasks where plan_id = p_plan_id and id = p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  update public.planner_plans set total_estimated_minutes = total_estimated_minutes - target.estimated_minutes,
    updated_at = now() where id = p_plan_id and mode = 'casual';
  if not found then raise exception 'Only casual plans can be edited'; end if;
  delete from public.planner_tasks where plan_id = p_plan_id and id = p_task_id;
  update public.planner_tasks set depends_on = array_remove(depends_on, p_task_id), updated_at = now()
  where plan_id = p_plan_id and p_task_id = any(depends_on);
end;
$$;

CREATE OR REPLACE FUNCTION "public"."enforce_one_boat_per_plan"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare pid uuid;
begin
  if new.status not in ('pending', 'review', 'active') then return new; end if;
  foreach pid in array array_remove(
    array[(new.requester_plan ->> 'id')::uuid, (new.partner_plan ->> 'id')::uuid], null
  ) loop
    perform pg_advisory_xact_lock(hashtextextended(pid::text, 1));
    if exists (
      select 1 from public.boat_requests r
      where r.id <> new.id and r.status in ('pending', 'review', 'active')
        and pid::text in (r.requester_plan ->> 'id', r.partner_plan ->> 'id')
    ) or exists (
      select 1 from public.boat_used_plans u
      where u.plan_id = pid and u.cycle_id <> new.cycle_id
    ) then
      raise exception 'A plan can only be on one boat';
    end if;
    if new.status = 'active' then
      insert into public.boat_used_plans (plan_id, request_id, cycle_id)
      values (pid, new.id, new.cycle_id)
      on conflict (plan_id) do nothing;
    end if;
  end loop;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."guard_boat_request_plan_readiness"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  requester_plan_id uuid;
  partner_plan_id uuid;
begin
  if new.status in ('pending', 'review', 'active')
    and (new.requester_plan ->> 'boatReady') is distinct from 'true' then
    raise exception 'The requester plan must be approved as boat-ready by the planner AI';
  end if;

  requester_plan_id := (new.requester_plan ->> 'id')::uuid;
  if new.status in ('pending', 'review', 'active') and not exists (
    select 1
    from public.planner_plans plan
    where plan.id = requester_plan_id
      and plan.owner_uid = new.requester_uid
      and plan.boat_ready
  ) then
    raise exception 'The requester plan must be approved as boat-ready by the planner AI';
  end if;

  if new.status in ('review', 'active') then
    if (new.partner_plan ->> 'boatReady') is distinct from 'true' then
      raise exception 'The partner plan must be approved as boat-ready by the planner AI';
    end if;
    partner_plan_id := (new.partner_plan ->> 'id')::uuid;
    if not exists (
      select 1
      from public.planner_plans plan
      where plan.id = partner_plan_id
        and plan.owner_uid = new.partner_uid
        and plan.boat_ready
    ) then
      raise exception 'The partner plan must be approved as boat-ready by the planner AI';
    end if;
  end if;

  if new.status = 'active' and (
    not exists (
      select 1
      from public.planner_plans plan
      where plan.id = requester_plan_id
        and plan.owner_uid = new.requester_uid
        and plan.mode = 'inferno'
    )
    or not exists (
      select 1
      from public.planner_plans plan
      where plan.id = partner_plan_id
        and plan.owner_uid = new.partner_uid
        and plan.mode = 'inferno'
    )
  ) then
    raise exception 'Both approved plans must become Inferno when the boat is accepted';
  end if;

  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."guard_boat_stake_terms"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
declare uid uuid := (select auth.uid());
begin
  if uid is null or current_user not in ('authenticated') then return new; end if;
  if (new.stake_mode, new.deadline_at, new.requester_bet_cents, new.partner_bet_cents)
     is distinct from
     (old.stake_mode, old.deadline_at, old.requester_bet_cents, old.partner_bet_cents) then
    if old.status <> 'pending' then raise exception 'Boat terms are locked'; end if;
    if uid = old.partner_uid and
       (new.stake_mode, new.deadline_at, new.requester_bet_cents)
       is distinct from (old.stake_mode, old.deadline_at, old.requester_bet_cents) then
      raise exception 'Only the requester can change the mode, deadline or their bet';
    end if;
    if uid = old.requester_uid and new.partner_bet_cents is distinct from old.partner_bet_cents
       and new.partner_bet_cents <> 0 then
      raise exception 'Only the partner can set their bet';
    end if;
    if new.deadline_at > old.created_at + interval '3 days'
       and greatest(new.requester_bet_cents, new.partner_bet_cents) > 5000 then
      raise exception 'Boats longer than 3 days allow bets up to $50';
    end if;
    if (uid = old.requester_uid and new.requester_bet_cents > 0
        or uid = old.partner_uid and new.partner_bet_cents > 0)
       and exists (
         select 1 from public.boat_stakes
         where user_uid = uid and status = 'unpaid'
       ) then
      raise exception 'You have an unpaid stake, so you can only bet $0';
    end if;
  end if;
  return new;
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."guard_planner_plan_boat_readiness"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.boat_ready then
      raise exception 'Only the planner AI can grant boat readiness';
    end if;
    if new.mode = 'inferno' then
      raise exception 'A plan must be boat-ready before becoming Inferno';
    end if;
    return new;
  end if;

  if new.boat_ready and not old.boat_ready
    and current_setting('app.allow_boat_readiness_grant', true) is distinct from 'true' then
    raise exception 'Only the planner AI can grant boat readiness';
  end if;

  if new.mode = 'inferno' and old.mode is distinct from 'inferno'
    and not old.boat_ready
    and current_setting('app.allow_boat_inferno_promotion', true) is distinct from 'true' then
    raise exception 'A plan must be boat-ready before becoming Inferno';
  end if;

  if new.title is distinct from old.title
    or new.description is distinct from old.description
    or new.total_estimated_minutes is distinct from old.total_estimated_minutes
    or new.mode is distinct from old.mode then
    if new.mode = 'inferno'
      and (
        current_setting('app.allow_boat_inferno_promotion', true) = 'true'
        or (
          old.boat_ready
          and new.title is not distinct from old.title
          and new.description is not distinct from old.description
          and new.total_estimated_minutes is not distinct from old.total_estimated_minutes
        )
      ) then
      return new;
    end if;
    new.boat_ready := false;
  end if;

  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
        nullif(new.email, ''),
        'Guest Account'
      ),
      254
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."has_unpaid_stake"("p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (select 1 from public.boat_stakes where user_uid = p_uid and status = 'unpaid');
$$;

CREATE OR REPLACE FUNCTION "public"."invalidate_boat_readiness_for_task_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare affected_plan_id uuid;
begin
  if tg_op = 'DELETE' then
    update public.planner_plans
    set boat_ready = false
    where id = old.plan_id and boat_ready;
    return old;
  end if;

  affected_plan_id := new.plan_id;
  if tg_op = 'INSERT'
    or new.title is distinct from old.title
    or new.estimated_minutes is distinct from old.estimated_minutes
    or new.category is distinct from old.category
    or new.depends_on is distinct from old.depends_on
    or new.position is distinct from old.position then
    update public.planner_plans
    set boat_ready = false
    where id = affected_plan_id and boat_ready;
  end if;

  if tg_op = 'UPDATE' and old.plan_id is distinct from new.plan_id then
    update public.planner_plans
    set boat_ready = false
    where id = old.plan_id and boat_ready;
  end if;

  return new;
end;
$$;

CREATE TABLE IF NOT EXISTS "public"."pairings" (
    "id" "text" NOT NULL,
    "code" "text" NOT NULL,
    "owner_uid" "uuid" NOT NULL,
    "partner_uid" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "paired_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pairings_check" CHECK (("owner_uid" <> "partner_uid"))
);

CREATE OR REPLACE FUNCTION "public"."redeem_pairing_invite"("p_code" "text") RETURNS "public"."pairings"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  invite public.pairing_invites;
  pairing public.pairings;
  first_uid text;
  second_uid text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into invite from public.pairing_invites where code = p_code for update;
  if not found or invite.created_at <= now() - interval '5 minutes' or invite.owner_uid = auth.uid() then
    raise exception 'The pairing invite is invalid or expired';
  end if;
  first_uid := least(invite.owner_uid::text, auth.uid()::text);
  second_uid := greatest(invite.owner_uid::text, auth.uid()::text);
  insert into public.pairings (id, code, owner_uid, partner_uid)
  values (first_uid || '_' || second_uid, invite.code, invite.owner_uid, auth.uid())
  returning * into pairing;
  delete from public.pairing_invites where code = invite.code;
  return pairing;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."require_boat_deadline"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if new.status = 'review' and new.deadline_at is null then
    raise exception 'The requester did not set a deadline. Cancel and resend the request.';
  end if;
  if new.status = 'active' and old.status <> 'active'
     and (new.deadline_at is null or new.deadline_at <= now()) then
    raise exception 'The deadline has already passed. Cancel and resend the request.';
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."require_boat_stakes_authorized"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if new.status = 'active' and old.status <> 'active' then
    if new.requester_bet_cents > 0 and not exists (
      select 1 from public.boat_stakes s
      where s.request_id = new.id and s.cycle_id = new.cycle_id
        and s.user_uid = new.requester_uid and s.status = 'authorized'
        and s.amount_cents = new.requester_bet_cents
    ) then
      raise exception 'The requester must authorize their bet with PayPal first';
    end if;
    if new.partner_bet_cents > 0 and not exists (
      select 1 from public.boat_stakes s
      where s.request_id = new.id and s.cycle_id = new.cycle_id
        and s.user_uid = new.partner_uid and s.status = 'authorized'
        and s.amount_cents = new.partner_bet_cents
    ) then
      raise exception 'The partner must authorize their bet with PayPal first';
    end if;
  end if;
  if new.status = 'active' and old.status <> 'active' then
    if new.requester_bet_cents = 0 and new.partner_bet_cents > 0 and not exists (
      select 1 from public.boat_payout_emails e
      where e.request_id = new.id and e.cycle_id = new.cycle_id and e.user_uid = new.requester_uid
    ) then
      raise exception 'The requester must add a PayPal payout email first';
    end if;
    if new.partner_bet_cents = 0 and new.requester_bet_cents > 0 and not exists (
      select 1 from public.boat_payout_emails e
      where e.request_id = new.id and e.cycle_id = new.cycle_id and e.user_uid = new.partner_uid
    ) then
      raise exception 'The partner must add a PayPal payout email first';
    end if;
  end if;
  return new;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."save_plan_and_tasks"("p_plan_id" "uuid", "p_plan" "jsonb", "p_tasks" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare saved_id uuid;
begin
  if auth.uid() is null or jsonb_typeof(p_plan) <> 'object' or jsonb_typeof(p_tasks) <> 'array' then
    raise exception 'Invalid plan data';
  end if;
  if jsonb_array_length(p_tasks) > 50 then raise exception 'A plan can have at most 50 tasks'; end if;
  if p_plan_id is null then
    insert into public.planner_plans (owner_uid, title, description, total_estimated_minutes, mode)
    values (
      auth.uid(), p_plan ->> 'title', p_plan ->> 'description',
      (p_plan ->> 'totalEstimatedMinutes')::integer, p_plan ->> 'mode'
    ) returning id into saved_id;
  else
    update public.planner_plans set
      title = p_plan ->> 'title',
      description = p_plan ->> 'description',
      total_estimated_minutes = (p_plan ->> 'totalEstimatedMinutes')::integer,
      mode = p_plan ->> 'mode',
      updated_at = now()
    where id = p_plan_id and owner_uid = auth.uid()
    returning id into saved_id;
    if not found then raise exception 'Plan not found'; end if;
  end if;
  delete from public.planner_tasks task
  where task.plan_id = saved_id
    and not exists (
      select 1 from jsonb_array_elements(p_tasks) item
      where item ->> 'id' = task.id
    );
  insert into public.planner_tasks (
    plan_id, id, title, estimated_minutes, category, depends_on,
    position, completed
  )
  select saved_id, item.id, item.title, item.estimated_minutes, item.category,
    item.depends_on, item.position, item.completed
  from jsonb_to_recordset(p_tasks) as item(
    id text, title text, estimated_minutes integer, category text,
    depends_on text[], position integer, completed boolean
  )
  on conflict (plan_id, id) do update set
    title = excluded.title,
    estimated_minutes = excluded.estimated_minutes,
    category = excluded.category,
    depends_on = excluded.depends_on,
    position = excluded.position,
    completed = excluded.completed,
    updated_at = now();
  return saved_id;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."set_boat_partner_bet"("p_request_id" "text", "p_cycle_id" "uuid", "p_bet_cents" integer) RETURNS "public"."boat_requests"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
declare updated public.boat_requests;
begin
  if p_bet_cents is null or p_bet_cents not between 0 and 50000 then
    raise exception 'A bet must be between $0 and $500';
  end if;
  update public.boat_requests set partner_bet_cents = p_bet_cents, updated_at = now()
  where id = p_request_id and cycle_id = p_cycle_id
    and partner_uid = (select auth.uid()) and status = 'pending'
  returning * into updated;
  if not found then raise exception 'This request is no longer waiting for your bet'; end if;
  return updated;
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."set_boat_terms"("p_request_id" "text", "p_cycle_id" "uuid", "p_mode" "text", "p_deadline" timestamp with time zone, "p_bet_cents" integer) RETURNS "public"."boat_requests"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
declare updated public.boat_requests;
begin
  if p_mode not in ('collaborate', 'racing') then raise exception 'Invalid boat mode'; end if;
  if p_deadline is null or p_deadline <= now() + interval '1 hour' then
    raise exception 'The deadline must be at least one hour away';
  end if;
  if p_deadline > now() + interval '29 days' then
    raise exception 'The deadline can be at most 29 days away';
  end if;
  if p_bet_cents is null or p_bet_cents not between 0 and 50000 then
    raise exception 'A bet must be between $0 and $500';
  end if;
  update public.boat_requests set
    stake_mode = p_mode, deadline_at = p_deadline,
    requester_bet_cents = p_bet_cents, partner_bet_cents = 0, updated_at = now()
  where id = p_request_id and cycle_id = p_cycle_id
    and requester_uid = (select auth.uid()) and status = 'pending'
  returning * into updated;
  if not found then raise exception 'This request can no longer be changed'; end if;
  return updated;
end;
$_$;

CREATE OR REPLACE FUNCTION "public"."set_plan_boat_readiness"("p_plan_id" "uuid", "p_snapshot" "jsonb", "p_ready" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  saved_plan public.planner_plans;
  saved_tasks jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if jsonb_typeof(p_snapshot) <> 'object' or p_ready is null then
    raise exception 'Invalid boat readiness review';
  end if;

  select * into saved_plan
  from public.planner_plans
  where id = p_plan_id and owner_uid = auth.uid()
  for update;
  if not found then raise exception 'Plan not found'; end if;

  select jsonb_agg(
    jsonb_build_object(
      'id', task.id,
      'title', task.title,
      'estimatedMinutes', task.estimated_minutes,
      'category', task.category,
      'dependsOn', task.depends_on,
      'position', task.position
    )
    order by task.position
  )
  into saved_tasks
  from public.planner_tasks task
  where task.plan_id = p_plan_id;

  if saved_plan.title is distinct from (p_snapshot ->> 'title')
    or saved_plan.description is distinct from (p_snapshot ->> 'description')
    or saved_plan.mode is distinct from (p_snapshot ->> 'mode')
    or saved_plan.total_estimated_minutes is distinct from
      ((p_snapshot ->> 'totalEstimatedMinutes')::integer)
    or saved_tasks is distinct from (p_snapshot -> 'tasks') then
    raise exception 'The plan changed during AI review. Ask the planner AI to review it again.';
  end if;
  if p_ready and (saved_plan.mode = 'inferno' or coalesce(jsonb_array_length(saved_tasks), 0) = 0) then
    raise exception 'This plan is not eligible for boat readiness review';
  end if;

  perform set_config('app.allow_boat_readiness_grant', 'true', true);
  update public.planner_plans
  set boat_ready = p_ready, updated_at = now()
  where id = p_plan_id and owner_uid = auth.uid();
end;
$$;

CREATE OR REPLACE FUNCTION "public"."submit_partner_plan"("p_request_id" "text", "p_cycle_id" "uuid", "p_partner_plan" "jsonb") RETURNS "public"."boat_requests"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  current_request public.boat_requests;
  updated public.boat_requests;
  requester_plan_id uuid;
  partner_plan_id uuid;
  requester_saved_plan public.planner_plans;
  requester_saved_tasks jsonb;
  partner_saved_plan public.planner_plans;
  partner_saved_tasks jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if coalesce(jsonb_typeof(p_partner_plan -> 'tasks'), '') <> 'array' then
    raise exception 'A plan needs at least one step to be on a boat';
  end if;
  if jsonb_array_length(p_partner_plan -> 'tasks') < 1 then
    raise exception 'A plan needs at least one step to be on a boat';
  end if;
  partner_plan_id := (p_partner_plan ->> 'id')::uuid;

  select * into current_request
  from public.boat_requests
  where id = p_request_id
    and cycle_id = p_cycle_id
    and partner_uid = auth.uid()
    and status = 'pending'
  for update;
  if not found then
    raise exception 'This request is no longer waiting for your response';
  end if;

  requester_plan_id := (current_request.requester_plan ->> 'id')::uuid;
  select * into requester_saved_plan
  from public.planner_plans
  where id = requester_plan_id
    and owner_uid = current_request.requester_uid
  for update;
  if not found then
    raise exception 'The saved plan of the requester is no longer available';
  end if;
  select jsonb_agg(
    jsonb_build_object(
      'id', task.id,
      'title', task.title,
      'estimatedMinutes', task.estimated_minutes,
      'category', task.category,
      'dependsOn', task.depends_on
    )
    order by task.position
  )
  into requester_saved_tasks
  from public.planner_tasks task
  where task.plan_id = requester_plan_id;
  if requester_saved_tasks is null
    or requester_saved_tasks is distinct from (current_request.requester_plan -> 'tasks')
    or requester_saved_plan.title is distinct from (current_request.requester_plan ->> 'title')
    or requester_saved_plan.description is distinct from (current_request.requester_plan ->> 'description')
    or requester_saved_plan.total_estimated_minutes is distinct from
      ((current_request.requester_plan ->> 'totalEstimatedMinutes')::integer) then
    raise exception 'The requester changed their plan. Cancel and resend the request before responding.';
  end if;
  if not exists (
    select 1 from public.planner_plans
    where id = partner_plan_id and owner_uid = auth.uid()
  ) then
    raise exception 'Choose one of your saved plans';
  end if;
  select * into partner_saved_plan
  from public.planner_plans
  where id = partner_plan_id and owner_uid = auth.uid()
  for update;
  select jsonb_agg(
    jsonb_build_object(
      'id', task.id,
      'title', task.title,
      'estimatedMinutes', task.estimated_minutes,
      'category', task.category,
      'dependsOn', task.depends_on
    )
    order by task.position
  )
  into partner_saved_tasks
  from public.planner_tasks task
  where task.plan_id = partner_plan_id;
  if partner_saved_tasks is null
    or partner_saved_tasks is distinct from (p_partner_plan -> 'tasks')
    or partner_saved_plan.title is distinct from (p_partner_plan ->> 'title')
    or partner_saved_plan.description is distinct from (p_partner_plan ->> 'description')
    or partner_saved_plan.total_estimated_minutes is distinct from
      ((p_partner_plan ->> 'totalEstimatedMinutes')::integer) then
    raise exception 'Your plan changed after review. Review it again before submitting.';
  end if;

  update public.boat_requests set
    partner_plan = p_partner_plan,
    status = 'review',
    updated_at = now()
  where id = p_request_id and cycle_id = p_cycle_id
  returning * into updated;
  return updated;
end;
$$;

CREATE TABLE IF NOT EXISTS "public"."boat_payout_emails" (
    "request_id" "text" NOT NULL,
    "cycle_id" "uuid" NOT NULL,
    "user_uid" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "boat_payout_emails_email_check" CHECK (("length"("email") <= 254))
);

-- A user's default PayPal payout email, copied to a boat when they bet $0.
CREATE TABLE IF NOT EXISTS "public"."user_payout_emails" (
    "user_uid" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "user_payout_emails_email_check" CHECK (("length"("email") <= 254))
);

-- Append-only money history, written only by the trigger below.
CREATE TABLE IF NOT EXISTS "public"."stake_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "stake_id" "uuid" NOT NULL,
    "user_uid" "uuid" NOT NULL,
    "request_id" "text" NOT NULL,
    "amount_cents" integer NOT NULL,
    "event" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "stake_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stake_events_user_uid_fkey" FOREIGN KEY ("user_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE
);

CREATE INDEX "stake_events_user_idx" ON "public"."stake_events" USING "btree" ("user_uid", "created_at" DESC);

ALTER TABLE "public"."stake_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own stake events" ON "public"."stake_events" FOR SELECT TO "authenticated" USING (("user_uid" = ( SELECT "auth"."uid"() AS "uid")));

REVOKE ALL ON TABLE "public"."stake_events" FROM "anon", "authenticated";
GRANT SELECT ON TABLE "public"."stake_events" TO "authenticated";
GRANT ALL ON TABLE "public"."stake_events" TO "service_role";

CREATE OR REPLACE FUNCTION "public"."log_stake_event"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if new.status is distinct from old.status and new.status <> 'created' then
    insert into public.stake_events (stake_id, user_uid, request_id, amount_cents, event)
    values (new.id, new.user_uid, new.request_id, new.amount_cents, new.status);
  end if;
  if new.payout_status is distinct from old.payout_status and new.payout_status is not null then
    insert into public.stake_events (stake_id, user_uid, request_id, amount_cents, event)
    values (new.id, new.user_uid, new.request_id, new.amount_cents, 'payout_' || new.payout_status);
  end if;
  return new;
end;
$$;

CREATE OR REPLACE TRIGGER "boat_stakes_log_event" AFTER UPDATE OF "status", "payout_status" ON "public"."boat_stakes" FOR EACH ROW EXECUTE FUNCTION "public"."log_stake_event"();

CREATE TABLE IF NOT EXISTS "public"."boat_used_plans" (
    "plan_id" "uuid" NOT NULL,
    "request_id" "text" NOT NULL,
    "cycle_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."pair_chat_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pairing_id" "text" NOT NULL,
    "sender_uid" "uuid" NOT NULL,
    "text" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pair_chat_messages_text_check" CHECK ((("length"("btrim"("text")) >= 1) AND ("length"("btrim"("text")) <= 2000)))
);

CREATE TABLE IF NOT EXISTS "public"."planner_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_uid" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text" NOT NULL,
    "total_estimated_minutes" integer DEFAULT 0 NOT NULL,
    "mode" "text" DEFAULT 'casual'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "boat_ready" boolean DEFAULT false NOT NULL,
    CONSTRAINT "planner_plans_description_check" CHECK ((("length"("btrim"("description")) >= 1) AND ("length"("btrim"("description")) <= 2000))),
    CONSTRAINT "planner_plans_mode_check" CHECK (("mode" = ANY (ARRAY['casual'::"text", 'fire'::"text", 'inferno'::"text"]))),
    CONSTRAINT "planner_plans_title_check" CHECK ((("length"("btrim"("title")) >= 1) AND ("length"("btrim"("title")) <= 200))),
    CONSTRAINT "planner_plans_total_estimated_minutes_check" CHECK ((("total_estimated_minutes" >= 0) AND ("total_estimated_minutes" <= 100000)))
);

CREATE TABLE IF NOT EXISTS "public"."planner_tasks" (
    "id" "text" NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "estimated_minutes" integer NOT NULL,
    "category" "text" NOT NULL,
    "depends_on" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "position" integer NOT NULL,
    "completed" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "planner_tasks_category_check" CHECK ((("length"("btrim"("category")) >= 1) AND ("length"("btrim"("category")) <= 100))),
    CONSTRAINT "planner_tasks_depends_on_check" CHECK (("cardinality"("depends_on") <= 8)),
    CONSTRAINT "planner_tasks_estimated_minutes_check" CHECK ((("estimated_minutes" >= 1) AND ("estimated_minutes" <= 10000))),
    CONSTRAINT "planner_tasks_id_check" CHECK (("id" ~ '^[a-zA-Z0-9_-]{1,80}$'::"text")),
    CONSTRAINT "planner_tasks_position_check" CHECK ((("position" >= 0) AND ("position" <= 999999))),
    CONSTRAINT "planner_tasks_title_check" CHECK ((("length"("btrim"("title")) >= 1) AND ("length"("btrim"("title")) <= 500)))
);

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "display_name" "text" DEFAULT 'Guest Account'::"text" NOT NULL,
    "avatar_path" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_check" CHECK ((("avatar_path" IS NULL) OR ("avatar_path" ~ (('^'::"text" || ("id")::"text") || '/[A-Za-z0-9._-]{1,80}$'::"text")))),
    CONSTRAINT "profiles_display_name_length_check" CHECK (("length"("display_name") <= 254))
);

ALTER TABLE ONLY "public"."boat_payout_emails"
    ADD CONSTRAINT "boat_payout_emails_pkey" PRIMARY KEY ("request_id", "cycle_id", "user_uid");

ALTER TABLE ONLY "public"."boat_requests"
    ADD CONSTRAINT "boat_requests_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."boat_stakes"
    ADD CONSTRAINT "boat_stakes_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."stake_events"
    ADD CONSTRAINT "stake_events_stake_id_fkey" FOREIGN KEY ("stake_id") REFERENCES "public"."boat_stakes"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."boat_stakes"
    ADD CONSTRAINT "boat_stakes_request_id_cycle_id_user_uid_key" UNIQUE ("request_id", "cycle_id", "user_uid");

ALTER TABLE ONLY "public"."boat_used_plans"
    ADD CONSTRAINT "boat_used_plans_pkey" PRIMARY KEY ("plan_id");

ALTER TABLE ONLY "public"."pair_chat_messages"
    ADD CONSTRAINT "pair_chat_messages_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."pairing_invites"
    ADD CONSTRAINT "pairing_invites_owner_uid_key" UNIQUE ("owner_uid");

ALTER TABLE ONLY "public"."pairing_invites"
    ADD CONSTRAINT "pairing_invites_pkey" PRIMARY KEY ("code");

ALTER TABLE ONLY "public"."pairings"
    ADD CONSTRAINT "pairings_code_key" UNIQUE ("code");

ALTER TABLE ONLY "public"."pairings"
    ADD CONSTRAINT "pairings_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."planner_plans"
    ADD CONSTRAINT "planner_plans_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."planner_tasks"
    ADD CONSTRAINT "planner_tasks_pkey" PRIMARY KEY ("plan_id", "id");

ALTER TABLE ONLY "public"."planner_tasks"
    ADD CONSTRAINT "planner_tasks_plan_id_position_key" UNIQUE ("plan_id", "position") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");

CREATE INDEX "boat_stakes_open_idx" ON "public"."boat_stakes" USING "btree" ("status") WHERE ("status" = ANY (ARRAY['created'::"text", 'authorized'::"text"]));

CREATE INDEX "pair_chat_messages_pair_created_idx" ON "public"."pair_chat_messages" USING "btree" ("pairing_id", "created_at");

CREATE INDEX "pairings_partner_uid_idx" ON "public"."pairings" USING "btree" ("partner_uid");

CREATE INDEX "planner_plans_owner_created_idx" ON "public"."planner_plans" USING "btree" ("owner_uid", "created_at" DESC);

CREATE OR REPLACE TRIGGER "boat_requests_guard_stake_terms" BEFORE UPDATE ON "public"."boat_requests" FOR EACH ROW EXECUTE FUNCTION "public"."guard_boat_stake_terms"();

CREATE OR REPLACE TRIGGER "boat_requests_one_boat_per_plan" BEFORE INSERT OR UPDATE OF "status", "requester_plan", "partner_plan" ON "public"."boat_requests" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_one_boat_per_plan"();

CREATE OR REPLACE TRIGGER "boat_requests_require_boat_ready_plans" BEFORE INSERT OR UPDATE ON "public"."boat_requests" FOR EACH ROW EXECUTE FUNCTION "public"."guard_boat_request_plan_readiness"();

CREATE OR REPLACE TRIGGER "boat_requests_require_deadline" BEFORE UPDATE OF "status" ON "public"."boat_requests" FOR EACH ROW EXECUTE FUNCTION "public"."require_boat_deadline"();

CREATE OR REPLACE TRIGGER "boat_requests_require_stakes" BEFORE UPDATE OF "status" ON "public"."boat_requests" FOR EACH ROW EXECUTE FUNCTION "public"."require_boat_stakes_authorized"();

CREATE OR REPLACE TRIGGER "planner_plans_block_delete_on_boat" BEFORE DELETE ON "public"."planner_plans" FOR EACH ROW EXECUTE FUNCTION "public"."block_delete_of_boat_plan"();

CREATE OR REPLACE TRIGGER "planner_plans_guard_boat_readiness" BEFORE INSERT OR UPDATE ON "public"."planner_plans" FOR EACH ROW EXECUTE FUNCTION "public"."guard_planner_plan_boat_readiness"();

CREATE OR REPLACE TRIGGER "planner_tasks_invalidate_boat_readiness" AFTER INSERT OR DELETE OR UPDATE ON "public"."planner_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."invalidate_boat_readiness_for_task_change"();

ALTER TABLE ONLY "public"."boat_payout_emails"
    ADD CONSTRAINT "boat_payout_emails_user_uid_fkey" FOREIGN KEY ("user_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."user_payout_emails"
    ADD CONSTRAINT "user_payout_emails_pkey" PRIMARY KEY ("user_uid");

ALTER TABLE ONLY "public"."user_payout_emails"
    ADD CONSTRAINT "user_payout_emails_user_uid_fkey" FOREIGN KEY ("user_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."boat_requests"
    ADD CONSTRAINT "boat_requests_id_fkey" FOREIGN KEY ("id") REFERENCES "public"."pairings"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."boat_requests"
    ADD CONSTRAINT "boat_requests_partner_uid_fkey" FOREIGN KEY ("partner_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."boat_requests"
    ADD CONSTRAINT "boat_requests_requester_uid_fkey" FOREIGN KEY ("requester_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."boat_stakes"
    ADD CONSTRAINT "boat_stakes_user_uid_fkey" FOREIGN KEY ("user_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."boat_used_plans"
    ADD CONSTRAINT "boat_used_plans_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."planner_plans"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."pair_chat_messages"
    ADD CONSTRAINT "pair_chat_messages_pairing_id_fkey" FOREIGN KEY ("pairing_id") REFERENCES "public"."pairings"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."pair_chat_messages"
    ADD CONSTRAINT "pair_chat_messages_sender_uid_fkey" FOREIGN KEY ("sender_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."pairing_invites"
    ADD CONSTRAINT "pairing_invites_owner_uid_fkey" FOREIGN KEY ("owner_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."pairings"
    ADD CONSTRAINT "pairings_owner_uid_fkey" FOREIGN KEY ("owner_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."pairings"
    ADD CONSTRAINT "pairings_partner_uid_fkey" FOREIGN KEY ("partner_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."planner_plans"
    ADD CONSTRAINT "planner_plans_owner_uid_fkey" FOREIGN KEY ("owner_uid") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."planner_tasks"
    ADD CONSTRAINT "planner_tasks_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."planner_plans"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;

CREATE POLICY "Boat participants can read stake status" ON "public"."boat_stakes" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."boat_requests" "r"
  WHERE (("r"."id" = "boat_stakes"."request_id") AND ("r"."cycle_id" = "boat_stakes"."cycle_id") AND ((( SELECT "auth"."uid"() AS "uid") = "r"."requester_uid") OR (( SELECT "auth"."uid"() AS "uid") = "r"."partner_uid"))))));

CREATE POLICY "Boat participants can see who saved a payout email" ON "public"."boat_payout_emails" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."boat_requests" "r"
  WHERE (("r"."id" = "boat_payout_emails"."request_id") AND ("r"."cycle_id" = "boat_payout_emails"."cycle_id") AND ((( SELECT "auth"."uid"() AS "uid") = "r"."requester_uid") OR (( SELECT "auth"."uid"() AS "uid") = "r"."partner_uid"))))));

CREATE POLICY "Boat participants can set stake terms" ON "public"."boat_requests" FOR UPDATE TO "authenticated" USING ((("status" = 'pending'::"text") AND ((( SELECT "auth"."uid"() AS "uid") = "requester_uid") OR (( SELECT "auth"."uid"() AS "uid") = "partner_uid")))) WITH CHECK ((("status" = 'pending'::"text") AND ((( SELECT "auth"."uid"() AS "uid") = "requester_uid") OR (( SELECT "auth"."uid"() AS "uid") = "partner_uid"))));

CREATE POLICY "Owners manage plan tasks" ON "public"."planner_tasks" TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."planner_plans" "p"
  WHERE (("p"."id" = "planner_tasks"."plan_id") AND ("p"."owner_uid" = ( SELECT "auth"."uid"() AS "uid")))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."planner_plans" "p"
  WHERE (("p"."id" = "planner_tasks"."plan_id") AND ("p"."owner_uid" = ( SELECT "auth"."uid"() AS "uid"))))));

CREATE POLICY "Owners manage plans" ON "public"."planner_plans" TO "authenticated" USING (("owner_uid" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("owner_uid" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "Users read their own payout email" ON "public"."user_payout_emails" FOR SELECT TO "authenticated" USING (("user_uid" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "Owners read their invite" ON "public"."pairing_invites" FOR SELECT TO "authenticated" USING (("owner_uid" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "Owners remove their invite" ON "public"."pairing_invites" FOR DELETE TO "authenticated" USING (("owner_uid" = ( SELECT "auth"."uid"() AS "uid")));

CREATE POLICY "Paired users read chat" ON "public"."pair_chat_messages" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."pairings" "p"
  WHERE (("p"."id" = "pair_chat_messages"."pairing_id") AND (("p"."owner_uid" = ( SELECT "auth"."uid"() AS "uid")) OR ("p"."partner_uid" = ( SELECT "auth"."uid"() AS "uid")))))));

CREATE POLICY "Paired users send chat" ON "public"."pair_chat_messages" FOR INSERT TO "authenticated" WITH CHECK ((("sender_uid" = ( SELECT "auth"."uid"() AS "uid")) AND (EXISTS ( SELECT 1
   FROM "public"."pairings" "p"
  WHERE (("p"."id" = "pair_chat_messages"."pairing_id") AND (("p"."owner_uid" = ( SELECT "auth"."uid"() AS "uid")) OR ("p"."partner_uid" = ( SELECT "auth"."uid"() AS "uid"))))))));

CREATE POLICY "Participants read pairings" ON "public"."pairings" FOR SELECT TO "authenticated" USING ((("owner_uid" = ( SELECT "auth"."uid"() AS "uid")) OR ("partner_uid" = ( SELECT "auth"."uid"() AS "uid"))));

CREATE POLICY "Participants remove pairings" ON "public"."pairings" FOR DELETE TO "authenticated" USING ((("owner_uid" = ( SELECT "auth"."uid"() AS "uid")) OR ("partner_uid" = ( SELECT "auth"."uid"() AS "uid"))));

CREATE POLICY "Profiles are visible to self and paired users" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("id" = ( SELECT "auth"."uid"() AS "uid")) OR (EXISTS ( SELECT 1
   FROM "public"."pairings" "p"
  WHERE ((("p"."owner_uid" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."partner_uid" = "profiles"."id")) OR (("p"."partner_uid" = ( SELECT "auth"."uid"() AS "uid")) AND ("p"."owner_uid" = "profiles"."id")))))));

CREATE POLICY "Request participants read boat requests" ON "public"."boat_requests" FOR SELECT TO "authenticated" USING ((("requester_uid" = ( SELECT "auth"."uid"() AS "uid")) OR ("partner_uid" = ( SELECT "auth"."uid"() AS "uid"))));

CREATE POLICY "Users update their own profile" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = ( SELECT "auth"."uid"() AS "uid"))) WITH CHECK (("id" = ( SELECT "auth"."uid"() AS "uid")));

ALTER TABLE "public"."boat_payout_emails" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."user_payout_emails" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."boat_requests" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."boat_stakes" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."boat_used_plans" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."pair_chat_messages" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."pairing_invites" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."pairings" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."planner_plans" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."planner_tasks" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."boat_requests";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."pair_chat_messages";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."pairing_invites";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."pairings";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."planner_plans";

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."planner_tasks";

GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

GRANT ALL ON FUNCTION "public"."block_delete_of_boat_plan"() TO "anon";
GRANT ALL ON FUNCTION "public"."block_delete_of_boat_plan"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."block_delete_of_boat_plan"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."boat_stake_outcome"("p_request_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."boat_stake_outcome"("p_request_id" "text") TO "service_role";

GRANT ALL ON TABLE "public"."boat_stakes" TO "service_role";

GRANT SELECT("id") ON TABLE "public"."boat_stakes" TO "authenticated";

GRANT SELECT("request_id") ON TABLE "public"."boat_stakes" TO "authenticated";

GRANT SELECT("cycle_id") ON TABLE "public"."boat_stakes" TO "authenticated";

GRANT SELECT("user_uid") ON TABLE "public"."boat_stakes" TO "authenticated";

GRANT SELECT("amount_cents") ON TABLE "public"."boat_stakes" TO "authenticated";

GRANT SELECT("status") ON TABLE "public"."boat_stakes" TO "authenticated";

GRANT SELECT("at_risk") ON TABLE "public"."boat_stakes" TO "authenticated";

GRANT SELECT("payout_status") ON TABLE "public"."boat_stakes" TO "authenticated";

GRANT SELECT("updated_at") ON TABLE "public"."boat_stakes" TO "authenticated";

REVOKE ALL ON FUNCTION "public"."boat_stakes_to_release"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."boat_stakes_to_release"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."boats_to_settle"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."boats_to_settle"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."cancel_boat_request"("p_request_id" "text", "p_cycle_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cancel_boat_request"("p_request_id" "text", "p_cycle_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_boat_request"("p_request_id" "text", "p_cycle_id" "uuid") TO "service_role";

GRANT ALL ON TABLE "public"."boat_requests" TO "service_role";
GRANT SELECT ON TABLE "public"."boat_requests" TO "authenticated";

GRANT UPDATE("updated_at") ON TABLE "public"."boat_requests" TO "authenticated";

GRANT UPDATE("stake_mode") ON TABLE "public"."boat_requests" TO "authenticated";

GRANT UPDATE("deadline_at") ON TABLE "public"."boat_requests" TO "authenticated";

GRANT UPDATE("requester_bet_cents") ON TABLE "public"."boat_requests" TO "authenticated";

GRANT UPDATE("partner_bet_cents") ON TABLE "public"."boat_requests" TO "authenticated";

GRANT UPDATE("settled_at") ON TABLE "public"."boat_requests" TO "service_role";

REVOKE ALL ON FUNCTION "public"."create_boat_request"("p_pairing_id" "text", "p_requester_plan" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_boat_request"("p_pairing_id" "text", "p_requester_plan" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_boat_request"("p_pairing_id" "text", "p_requester_plan" "jsonb") TO "service_role";

GRANT ALL ON TABLE "public"."pairing_invites" TO "service_role";
GRANT SELECT,DELETE ON TABLE "public"."pairing_invites" TO "authenticated";

REVOKE ALL ON FUNCTION "public"."create_pairing_invite"("p_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_pairing_invite"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_pairing_invite"("p_code" "text") TO "service_role";

REVOKE ALL ON FUNCTION "public"."decide_boat_request"("p_request_id" "text", "p_cycle_id" "uuid", "p_decision" "text", "p_requester_plan" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."decide_boat_request"("p_request_id" "text", "p_cycle_id" "uuid", "p_decision" "text", "p_requester_plan" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."decide_boat_request"("p_request_id" "text", "p_cycle_id" "uuid", "p_decision" "text", "p_requester_plan" "jsonb") TO "service_role";

REVOKE ALL ON FUNCTION "public"."delete_planner_task"("p_plan_id" "uuid", "p_task_id" "text", "p_owner_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_planner_task"("p_plan_id" "uuid", "p_task_id" "text", "p_owner_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_planner_task"("p_plan_id" "uuid", "p_task_id" "text", "p_owner_uid" "uuid") TO "service_role";

REVOKE ALL ON FUNCTION "public"."enforce_one_boat_per_plan"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enforce_one_boat_per_plan"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."guard_boat_request_plan_readiness"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_boat_request_plan_readiness"() TO "service_role";

GRANT ALL ON FUNCTION "public"."guard_boat_stake_terms"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_boat_stake_terms"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_boat_stake_terms"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."guard_planner_plan_boat_readiness"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_planner_plan_boat_readiness"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."handle_new_auth_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."has_unpaid_stake"("p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_unpaid_stake"("p_uid" "uuid") TO "service_role";

REVOKE ALL ON FUNCTION "public"."invalidate_boat_readiness_for_task_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."invalidate_boat_readiness_for_task_change"() TO "service_role";

GRANT ALL ON TABLE "public"."pairings" TO "service_role";
GRANT SELECT,DELETE ON TABLE "public"."pairings" TO "authenticated";

REVOKE ALL ON FUNCTION "public"."redeem_pairing_invite"("p_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."redeem_pairing_invite"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."redeem_pairing_invite"("p_code" "text") TO "service_role";

GRANT ALL ON FUNCTION "public"."require_boat_deadline"() TO "anon";
GRANT ALL ON FUNCTION "public"."require_boat_deadline"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."require_boat_deadline"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."require_boat_stakes_authorized"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."require_boat_stakes_authorized"() TO "service_role";

REVOKE ALL ON FUNCTION "public"."save_plan_and_tasks"("p_plan_id" "uuid", "p_plan" "jsonb", "p_tasks" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_plan_and_tasks"("p_plan_id" "uuid", "p_plan" "jsonb", "p_tasks" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_plan_and_tasks"("p_plan_id" "uuid", "p_plan" "jsonb", "p_tasks" "jsonb") TO "service_role";

GRANT ALL ON FUNCTION "public"."set_boat_partner_bet"("p_request_id" "text", "p_cycle_id" "uuid", "p_bet_cents" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."set_boat_partner_bet"("p_request_id" "text", "p_cycle_id" "uuid", "p_bet_cents" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_boat_partner_bet"("p_request_id" "text", "p_cycle_id" "uuid", "p_bet_cents" integer) TO "service_role";

GRANT ALL ON FUNCTION "public"."set_boat_terms"("p_request_id" "text", "p_cycle_id" "uuid", "p_mode" "text", "p_deadline" timestamp with time zone, "p_bet_cents" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."set_boat_terms"("p_request_id" "text", "p_cycle_id" "uuid", "p_mode" "text", "p_deadline" timestamp with time zone, "p_bet_cents" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_boat_terms"("p_request_id" "text", "p_cycle_id" "uuid", "p_mode" "text", "p_deadline" timestamp with time zone, "p_bet_cents" integer) TO "service_role";

REVOKE ALL ON FUNCTION "public"."set_plan_boat_readiness"("p_plan_id" "uuid", "p_snapshot" "jsonb", "p_ready" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_plan_boat_readiness"("p_plan_id" "uuid", "p_snapshot" "jsonb", "p_ready" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_plan_boat_readiness"("p_plan_id" "uuid", "p_snapshot" "jsonb", "p_ready" boolean) TO "service_role";

REVOKE ALL ON FUNCTION "public"."submit_partner_plan"("p_request_id" "text", "p_cycle_id" "uuid", "p_partner_plan" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_partner_plan"("p_request_id" "text", "p_cycle_id" "uuid", "p_partner_plan" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_partner_plan"("p_request_id" "text", "p_cycle_id" "uuid", "p_partner_plan" "jsonb") TO "service_role";

GRANT ALL ON TABLE "public"."boat_payout_emails" TO "service_role";

GRANT SELECT("request_id") ON TABLE "public"."boat_payout_emails" TO "authenticated";

GRANT SELECT("cycle_id") ON TABLE "public"."boat_payout_emails" TO "authenticated";

GRANT SELECT("user_uid") ON TABLE "public"."boat_payout_emails" TO "authenticated";

GRANT ALL ON TABLE "public"."user_payout_emails" TO "service_role";

GRANT SELECT ON TABLE "public"."user_payout_emails" TO "authenticated";

GRANT ALL ON TABLE "public"."boat_used_plans" TO "service_role";

GRANT ALL ON TABLE "public"."pair_chat_messages" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."pair_chat_messages" TO "authenticated";

GRANT ALL ON TABLE "public"."planner_plans" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."planner_plans" TO "authenticated";

GRANT ALL ON TABLE "public"."planner_tasks" TO "service_role";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."planner_tasks" TO "authenticated";

GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."profiles" TO "authenticated";

GRANT UPDATE("display_name") ON TABLE "public"."profiles" TO "authenticated";

GRANT UPDATE("avatar_path") ON TABLE "public"."profiles" TO "authenticated";

GRANT UPDATE("updated_at") ON TABLE "public"."profiles" TO "authenticated";

--
-- Dumped schema changes for auth and storage
--

CREATE OR REPLACE TRIGGER "on_auth_user_created" AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_auth_user"();

CREATE POLICY "Users delete their own avatars" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'burn-the-boat-avatars'::"text") AND (("storage"."foldername"("name"))[1] = ( SELECT ("auth"."uid"())::"text" AS "uid"))));

CREATE POLICY "Users update their own avatars" ON "storage"."objects" FOR UPDATE TO "authenticated" USING ((("bucket_id" = 'burn-the-boat-avatars'::"text") AND (("storage"."foldername"("name"))[1] = ( SELECT ("auth"."uid"())::"text" AS "uid")))) WITH CHECK ((("bucket_id" = 'burn-the-boat-avatars'::"text") AND (("storage"."foldername"("name"))[1] = ( SELECT ("auth"."uid"())::"text" AS "uid"))));

CREATE POLICY "Users upload their own avatars" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'burn-the-boat-avatars'::"text") AND (("storage"."foldername"("name"))[1] = ( SELECT ("auth"."uid"())::"text" AS "uid"))));

CREATE POLICY "Users view their own avatar objects" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'burn-the-boat-avatars'::"text") AND (("storage"."foldername"("name"))[1] = ( SELECT ("auth"."uid"())::"text" AS "uid"))));

-- Function privileges. A dump cannot express these, so they are explicit here.
-- Internal and trigger functions: no access through the Data API.
REVOKE ALL ON FUNCTION "public"."block_delete_of_boat_plan"() FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."boat_stake_outcome"(text) FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."boat_stakes_to_release"() FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."boats_to_settle"() FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."enforce_one_boat_per_plan"() FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."guard_boat_request_plan_readiness"() FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."guard_boat_stake_terms"() FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."guard_planner_plan_boat_readiness"() FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."handle_new_auth_user"() FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."invalidate_boat_readiness_for_task_change"() FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."require_boat_deadline"() FROM PUBLIC, "anon", "authenticated";
REVOKE ALL ON FUNCTION "public"."require_boat_stakes_authorized"() FROM PUBLIC, "anon", "authenticated";
-- Client RPCs: signed-in users only.
REVOKE ALL ON FUNCTION "public"."cancel_boat_request"(text, uuid) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."create_boat_request"(text, jsonb) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."create_pairing_invite"(text) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."decide_boat_request"(text, uuid, text, jsonb) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."delete_planner_task"(uuid, text, uuid) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."redeem_pairing_invite"(text) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."save_plan_and_tasks"(uuid, jsonb, jsonb) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."set_boat_partner_bet"(text, uuid, integer) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."set_boat_terms"(text, uuid, text, timestamp WITH time zone, integer) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."set_plan_boat_readiness"(uuid, jsonb, boolean) FROM PUBLIC, "anon";
REVOKE ALL ON FUNCTION "public"."submit_partner_plan"(text, uuid, jsonb) FROM PUBLIC, "anon";

-- Scheduled jobs live outside the schema dump, so they are kept in their own migration.
-- Both need the Vault secrets project_url and service_role_key (see README).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'cleanup-inactive-guest-accounts',
  '0 3 * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'project_url'
      ) || '/functions/v1/cleanup-inactive-guests',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'service_role_key'
        )
      ),
      body := '{}'::jsonb
    )
    where exists (
      select 1 from vault.decrypted_secrets where name = 'project_url'
    )
      and exists (
        select 1 from vault.decrypted_secrets where name = 'service_role_key'
      );
  $$
);

select cron.schedule(
  'settle-boat-stakes',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'project_url'
      ) || '/functions/v1/settle-boat-stakes',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'service_role_key'
        )
      ),
      body := '{}'::jsonb
    )
    where exists (
      select 1 from vault.decrypted_secrets where name = 'project_url'
    )
      and exists (
        select 1 from vault.decrypted_secrets where name = 'service_role_key'
      );
  $$
);

-- Creates a boat request and saves its terms in one transaction, so invalid
-- terms leave no cancelled request behind. Runs as the caller (same privileges
-- as calling the two functions separately).
create or replace function public.create_boat_request_with_terms(
  p_pairing_id text,
  p_requester_plan jsonb,
  p_mode text,
  p_deadline timestamptz,
  p_bet_cents integer
) returns public.boat_requests
language plpgsql
set search_path = ''
as $$
declare created public.boat_requests;
begin
  created := public.create_boat_request(p_pairing_id, p_requester_plan);
  return public.set_boat_terms(
    created.id, created.cycle_id, p_mode, p_deadline, p_bet_cents
  );
end;
$$;

revoke all on function public.create_boat_request_with_terms(text, jsonb, text, timestamptz, integer) from public, anon;
grant execute on function public.create_boat_request_with_terms(text, jsonb, text, timestamptz, integer) to authenticated, service_role;
