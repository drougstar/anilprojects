-- Personal authenticator protection, schema version 3.
-- Run after workspaces-v2.sql in the Supabase SQL editor. The app never runs SQL.
-- No records, settings, accounts or authenticators are created, moved or deleted.
-- Personal requires an AAL2 session; Work remains usable after password sign-in.
-- https://supabase.com/docs/guides/auth/auth-mfa
begin;

do $$
begin
  if to_regprocedure('public.ifsbridge_schema_version()') is null then
    raise exception 'Run workspaces-v2.sql before personal-mfa-v3.sql.';
  end if;
  if public.ifsbridge_schema_version() not in (2,3) then
    raise exception 'Unsupported schema version. Check the Personal MFA migration.';
  end if;
end $$;

-- Restrictive policies are ANDed with existing ownership policies. A permissive
-- policy added later cannot accidentally bypass the Personal authenticator gate.
do $$
declare t text;
begin
  foreach t in array array['sheets','trips','expenses','weeks','templates','budgets','inbox'] loop
    execute format('drop policy if exists "personal requires authenticator" on public.%I', t);
    execute format('create policy "personal requires authenticator" on public.%I as restrictive for all to authenticated
      using (workspace_id = ''work'' or (workspace_id = ''personal'' and coalesce(auth.jwt()->>''aal'',''aal1'') = ''aal2''))
      with check (workspace_id = ''work'' or (workspace_id = ''personal'' and coalesce(auth.jwt()->>''aal'',''aal1'') = ''aal2''))', t);
  end loop;
end $$;

-- SECURITY DEFINER bypasses RLS, so its guard must run before reads (including
-- conflict rows) as well as writes. The revision checks from v2 remain in place.
create or replace function public.ifsbridge_apply_changes(p_workspace text, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  item jsonb;
  t text;
  v_id uuid;
  expected bigint;
  current_row jsonb;
  conflicts jsonb := '[]'::jsonb;
  written jsonb := '[]'::jsonb;
begin
  if v_user is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if p_workspace not in ('work','personal') or p_workspace is null then raise exception 'Invalid workspace.'; end if;
  if p_workspace = 'personal' and coalesce(auth.jwt()->>'aal','aal1') <> 'aal2' then
    raise exception 'Verify your authenticator before syncing Personal.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'Changes must be an array.'; end if;
  if jsonb_array_length(p_changes) > 5000 then raise exception 'Sync at most 5000 records at once.'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_changes) c
    group by c->>'table', c->>'id' having count(*) > 1
  ) then raise exception 'Duplicate record in change batch.'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text || ':' || p_workspace, 0));
  for item in select value from jsonb_array_elements(p_changes) loop
    t := item->>'table';
    if t is null or t not in ('sheets','trips','expenses','weeks','templates','budgets','inbox') then raise exception 'Unsupported table.'; end if;
    v_id := (item->>'id')::uuid;
    if v_id is null or jsonb_typeof(item->'data') is distinct from 'object' then raise exception 'Invalid record.'; end if;
    if not (item ? 'expected_revision') then raise exception 'Expected revision is required.'; end if;
    expected := (item->>'expected_revision')::bigint;
    if expected < 0 then raise exception 'Invalid expected revision.'; end if;
    execute format('select to_jsonb(r) from public.%I r where user_id=$1 and workspace_id=$2 and id=$3 for update', t)
      into current_row using v_user, p_workspace, v_id;
    if (current_row->>'revision')::bigint is distinct from expected then
      conflicts := conflicts || jsonb_build_array(jsonb_build_object('table',t,'id',v_id,'row',current_row));
    end if;
  end loop;
  if jsonb_array_length(conflicts) > 0 then return jsonb_build_object('applied',false,'conflicts',conflicts); end if;
  -- A Work expense may link to one active Personal charge. Check the projected
  -- whole batch under the same workspace lock, so separate device edits cannot
  -- create duplicates. Old duplicates may remain unchanged or be reduced.
  if p_workspace = 'personal' and exists (
    with changed as (
      select (c->>'id')::uuid as id, c->'data' #>> '{workExpenseLink,expenseId}' as expense_id,
        coalesce((c->>'deleted')::boolean,false) as deleted
      from jsonb_array_elements(p_changes) c where c->>'table' = 'expenses'
    ), existing as (
      select id, data #>> '{workExpenseLink,expenseId}' as expense_id, deleted
      from public.expenses where user_id = v_user and workspace_id = 'personal'
    ), before_counts as (
      select expense_id, count(*) as n from existing
      where not deleted and expense_id is not null and expense_id <> '' group by expense_id
    ), projected as (
      select e.expense_id from existing e
      where not e.deleted and not exists (select 1 from changed c where c.id = e.id)
      union all
      select expense_id from changed where not deleted
    ), after_counts as (
      select expense_id, count(*) as n from projected
      where expense_id is not null and expense_id <> '' group by expense_id
    )
    select 1 from after_counts a left join before_counts b using (expense_id)
    where a.n > 1 and a.n > coalesce(b.n,0)
  ) then
    raise exception 'A Work expense can only be linked to one active Personal transaction. Unlink the other transaction first.' using errcode = '23505';
  end if;

  for item in select value from jsonb_array_elements(p_changes) loop
    t := item->>'table'; v_id := (item->>'id')::uuid;
    execute format('insert into public.%I as target (id,user_id,workspace_id,updated_at,deleted,data,revision)
      values ($1,$2,$3,$4,$5,$6,0)
      on conflict (user_id,workspace_id,id) do update set
        updated_at=excluded.updated_at, deleted=excluded.deleted, data=excluded.data, revision=target.revision+1
      returning to_jsonb(target)', t)
      into current_row using v_id, v_user, p_workspace, (item->>'updated_at')::timestamptz,
        coalesce((item->>'deleted')::boolean,false), (item->'data') - 'dirty' - '_remoteRevision';
    written := written || jsonb_build_array(jsonb_build_object('table',t,'row',current_row));
  end loop;
  return jsonb_build_object('applied',true,'rows',written);
end $$;
revoke all on function public.ifsbridge_apply_changes(text,jsonb) from public, anon;
grant execute on function public.ifsbridge_apply_changes(text,jsonb) to authenticated;

-- The legacy <owner>/<file> layout belongs only to Work. Personal always uses
-- exactly <owner>/personal/<file>, so the legacy fallback cannot expose it.
drop policy if exists "personal receipt authenticator" on storage.objects;
create policy "personal receipt authenticator" on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'receipts' or (
    (storage.foldername(name))[1] = auth.uid()::text
    and (array_length(storage.foldername(name),1) = 1
      or (array_length(storage.foldername(name),1) = 2
        and ((storage.foldername(name))[2] = 'work'
          or ((storage.foldername(name))[2] = 'personal' and coalesce(auth.jwt()->>'aal','aal1') = 'aal2'))))))
  with check (bucket_id <> 'receipts' or (
    (storage.foldername(name))[1] = auth.uid()::text
    and (array_length(storage.foldername(name),1) = 1
      or (array_length(storage.foldername(name),1) = 2
        and ((storage.foldername(name))[2] = 'work'
          or ((storage.foldername(name))[2] = 'personal' and coalesce(auth.jwt()->>'aal','aal1') = 'aal2'))))));

create or replace function public.ifsbridge_schema_version()
returns integer language sql stable security invoker set search_path = ''
as $$ select 3; $$;
revoke all on function public.ifsbridge_schema_version() from public, anon;
grant execute on function public.ifsbridge_schema_version() to authenticated;
notify pgrst, 'reload schema';
commit;
