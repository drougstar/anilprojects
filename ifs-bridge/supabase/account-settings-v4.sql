-- Account preferences only. Run AFTER personal-mfa-v3.sql; this additive
-- migration leaves the existing record-sync RPC and schema version 3 intact.
-- No settings, records, connections or accounts are moved or uploaded by SQL.
-- Browser saves use explicit revisions; ownership always comes from auth.uid().
begin;

do $$
begin
  if to_regprocedure('public.ifsbridge_schema_version()') is null then
    raise exception 'Run workspaces-v2.sql and personal-mfa-v3.sql first.';
  end if;
  if public.ifsbridge_schema_version() <> 3 then
    raise exception 'Account settings require Personal MFA schema version 3.';
  end if;
  if to_regprocedure('public.ifsbridge_settings_schema_version()') is not null then
    if public.ifsbridge_settings_schema_version() <> 4 then
      raise exception 'A different account settings schema is installed. Do not replace it.';
    end if;
  end if;
end $$;

create table if not exists public.ifsbridge_account_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id text not null check (workspace_id in ('work','personal','account')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 1048576),
  revision bigint not null check (revision between 1 and 9007199254740991),
  last_operation_id text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, workspace_id)
);
alter table public.ifsbridge_account_settings enable row level security;
revoke all on table public.ifsbridge_account_settings from public, anon, authenticated;
grant select on table public.ifsbridge_account_settings to authenticated;

drop policy if exists "read owned settings" on public.ifsbridge_account_settings;
create policy "read owned settings" on public.ifsbridge_account_settings
  for select to authenticated using (user_id = auth.uid());
-- Restrictive owner + MFA checks remain effective if another permissive policy
-- is later added. Direct client mutations remain revoked entirely.
drop policy if exists "settings owner and Personal authenticator" on public.ifsbridge_account_settings;
create policy "settings owner and Personal authenticator" on public.ifsbridge_account_settings
  as restrictive for all to authenticated
  using (user_id = auth.uid() and (workspace_id in ('work','account') or coalesce(auth.jwt()->>'aal','aal1') = 'aal2'))
  with check (user_id = auth.uid() and (workspace_id in ('work','account') or coalesce(auth.jwt()->>'aal','aal1') = 'aal2'));

create or replace function public.ifsbridge_settings_schema_version()
returns integer language sql security invoker set search_path = '' as $$ select 4 $$;

create or replace function public.ifsbridge_read_settings(p_workspace text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_user uuid := auth.uid(); v_result jsonb;
begin
  if v_user is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if p_workspace is null or p_workspace not in ('work','personal','account') then raise exception 'Invalid settings workspace.'; end if;
  if p_workspace = 'personal' and coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then
    raise exception 'Verify your authenticator before reading Personal settings.' using errcode = '42501';
  end if;
  select jsonb_build_object('revision',r.revision,'payload',r.payload,'updated_at',r.updated_at)
    into v_result from public.ifsbridge_account_settings r
    where r.user_id = v_user and r.workspace_id = p_workspace;
  return v_result;
end $$;

create or replace function public.ifsbridge_write_settings(
  p_workspace text, p_expected_revision bigint, p_payload jsonb, p_operation_id text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_current public.ifsbridge_account_settings%rowtype;
  v_row jsonb;
  v_allowed text[];
  v_count integer := 0;
  v_item record;
begin
  if v_user is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if p_workspace is null or p_workspace not in ('work','personal','account') then raise exception 'Invalid settings workspace.'; end if;
  -- Guard before both conflict reads and writes, not merely in table RLS.
  if p_workspace = 'personal' and coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then
    raise exception 'Verify your authenticator before saving Personal settings.' using errcode = '42501';
  end if;
  if p_expected_revision is not null and (p_expected_revision < 1 or p_expected_revision >= 9007199254740991) then raise exception 'Invalid settings revision.'; end if;
  if p_operation_id is null or p_operation_id !~ '^[a-zA-Z0-9-]{16,128}$' then raise exception 'Invalid settings operation.'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text) > 1048576 then raise exception 'Settings must be an object smaller than 1 MB.'; end if;
  v_allowed := case p_workspace
    when 'account' then array['theme','timeZone']
    when 'personal' then array['settingsListsVersion','timeZone','defaultCurrency','currencies','expenseCodes']
    else array['settingsListsVersion','timeCalculationMode','timeCodeMappingsVersion','timeZone','regularHours','travelAfterHours','topUpMinimum','roundStep','roundMode','holidays','tags','travelKeyword','codes','codeDescriptions','timeCodeMappings','timeCodeCatalog','identity','template','defaultCurrency','currencies','costObjects','expenseCodes','perDiemCode','expenseTemplate','expenseActivitySuffix','knownShortNames','homeCurrency','rateSource','tcmbField','currRateMode','perDiemDefaults','payRate','payCurrency','restDaysPaid','restDayHours','payMinDay','mapping','workPolicyVersion','workPolicy','workPolicyMigrationWarnings','timeTypes','clockify']
  end;
  if exists (select 1 from jsonb_object_keys(p_payload) as k where not k = any(v_allowed)) then raise exception 'Unsupported settings field for this workspace.'; end if;
  if p_payload ? 'theme' and (jsonb_typeof(p_payload->'theme') <> 'string' or p_payload->>'theme' not in ('light','dark','auto')) then raise exception 'Invalid appearance.'; end if;
  if p_payload ? 'timeZone' and (jsonb_typeof(p_payload->'timeZone') <> 'string' or length(p_payload->>'timeZone') > 100) then raise exception 'Invalid time zone.'; end if;
  if p_payload ? 'clockify' then
    if jsonb_typeof(p_payload->'clockify') <> 'object' then raise exception 'Invalid Clockify connection.'; end if;
    if exists (select 1 from jsonb_each(p_payload->'clockify') as c where c.key not in ('apiKey','workspaceId','userId','userName') or jsonb_typeof(c.value) <> 'string' or length(c.value #>> '{}') > 4096) then raise exception 'Invalid Clockify connection field.'; end if;
  end if;
  -- Reject prototype/session fields at any depth, including future policy roots.
  -- No dynamic SQL and no identifiers or owners come from the payload.
  for v_item in
    with recursive nodes(value,depth) as (
      select p_payload,0
      union all
      select child.value,n.depth+1 from nodes n
      cross join lateral (
        select value from jsonb_each(case when jsonb_typeof(n.value)='object' then n.value else '{}'::jsonb end)
        union all
        select value from jsonb_array_elements(case when jsonb_typeof(n.value)='array' then n.value else '[]'::jsonb end)
      ) child where n.depth <= 20
    ) select value,depth from nodes limit 100001
  loop
    v_count := v_count + 1;
    if v_count > 100000 or v_item.depth > 20 then raise exception 'Settings are too complex.'; end if;
    if jsonb_typeof(v_item.value)='object' and v_item.value ?| array['__proto__','prototype','constructor','access_token','refresh_token','service_role','serviceRoleKey'] then raise exception 'Unsafe settings property.'; end if;
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text || ':settings:' || p_workspace,0));
  select * into v_current from public.ifsbridge_account_settings
    where user_id = v_user and workspace_id = p_workspace for update;
  if v_current.revision is not null then
    v_row := jsonb_build_object('revision',v_current.revision,'payload',v_current.payload,'updated_at',v_current.updated_at);
    if v_current.last_operation_id = p_operation_id then
      if v_current.payload is distinct from p_payload then raise exception 'Settings operation was reused with different data.'; end if;
      return jsonb_build_object('applied',true,'row',v_row);
    end if;
  end if;
  if v_current.revision is distinct from p_expected_revision then
    return jsonb_build_object('applied',false,'row',v_row);
  end if;
  insert into public.ifsbridge_account_settings(user_id,workspace_id,payload,revision,last_operation_id,updated_at)
    values(v_user,p_workspace,p_payload,coalesce(v_current.revision,0)+1,p_operation_id,now())
    on conflict(user_id,workspace_id) do update set payload=excluded.payload,revision=excluded.revision,last_operation_id=excluded.last_operation_id,updated_at=excluded.updated_at
    returning jsonb_build_object('revision',revision,'payload',payload,'updated_at',updated_at) into v_row;
  return jsonb_build_object('applied',true,'row',v_row);
end $$;

revoke execute on function public.ifsbridge_settings_schema_version() from public,anon,authenticated;
revoke execute on function public.ifsbridge_read_settings(text) from public,anon,authenticated;
revoke execute on function public.ifsbridge_write_settings(text,bigint,jsonb,text) from public,anon,authenticated;
grant execute on function public.ifsbridge_settings_schema_version() to authenticated;
grant execute on function public.ifsbridge_read_settings(text) to authenticated;
grant execute on function public.ifsbridge_write_settings(text,bigint,jsonb,text) to authenticated;
notify pgrst, 'reload schema';
commit;
