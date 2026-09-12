-- Read-only owner check for the hosted Work/Personal schema.
-- Run this whole file in the Supabase SQL editor. It reads definitions, grants,
-- policies and the receipts bucket's privacy flag, never user records or keys.
-- No grants are changed. authenticated EXECUTE on the guarded sync RPC is needed.
-- The explicit read-only transaction also prevents an unexpected version
-- function definition from making a write while it is being inspected.
begin read only;

-- Expected: 3. Missing function means the workspace migration is not installed.
select public.ifsbridge_schema_version() as installed_schema_version;

-- Hashes match the tested personal-mfa-v3.sql function bodies. Line endings are
-- normalized so copying between Windows and the SQL editor is harmless.
-- A false body_matches_tested_v3 needs review of the definition below; it does
-- not prove a vulnerability by itself (even a comment edit changes the hash).
with expected(signature, body_md5, should_be_definer) as (values
  ('public.ifsbridge_apply_changes(text,jsonb)', '883532e33eacbd255b49640c46d1ea6e', true),
  ('public.ifsbridge_schema_version()', '2645ded8d962eebe8104370a3d5ac219', false)
)
select e.signature,
  p.oid is not null as function_exists,
  pg_catalog.pg_get_userbyid(p.proowner) as function_owner,
  p.prosecdef as security_definer,
  p.prosecdef = e.should_be_definer as expected_execution_mode,
  p.proconfig as function_settings,
  coalesce('search_path=""' = any(p.proconfig), false) as empty_search_path,
  pg_catalog.md5(pg_catalog.regexp_replace(p.prosrc, E'\r\n?', E'\n', 'g')) as body_md5,
  pg_catalog.md5(pg_catalog.regexp_replace(p.prosrc, E'\r\n?', E'\n', 'g')) = e.body_md5 as body_matches_tested_v3,
  case when p.oid is not null then pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') end as anon_can_execute,
  case when p.oid is not null then pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') end as authenticated_can_execute
from expected e left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(e.signature)
order by e.signature;

-- These are readable checkpoints, not a substitute for the exact body comparison.
-- In particular, the Personal AAL2 guard must run before the first record read.
select
  pg_catalog.strpos(p.prosrc, 'v_user uuid := auth.uid()') > 0 as takes_owner_from_signed_in_user,
  pg_catalog.strpos(p.prosrc, 'if v_user is null then') > 0 as rejects_missing_identity,
  pg_catalog.strpos(p.prosrc, 'p_workspace = ''personal'' and coalesce(auth.jwt()->>''aal'',''aal1'') <> ''aal2''') > 0 as has_personal_aal2_guard,
  pg_catalog.strpos(p.prosrc, 'p_workspace = ''personal'' and coalesce(auth.jwt()->>''aal'',''aal1'') <> ''aal2''') > 0
    and pg_catalog.strpos(p.prosrc, 'p_workspace = ''personal'' and coalesce(auth.jwt()->>''aal'',''aal1'') <> ''aal2''')
      < pg_catalog.strpos(p.prosrc, 'select to_jsonb(r)') as personal_guard_precedes_conflict_read,
  pg_catalog.strpos(p.prosrc, 'where user_id=$1 and workspace_id=$2 and id=$3') > 0 as conflict_read_binds_owner_and_workspace,
  pg_catalog.strpos(p.prosrc, 'using v_id, v_user, p_workspace') > 0 as write_binds_owner_and_workspace,
  pg_catalog.strpos(p.prosrc, 'Unsupported table.') > 0 as has_table_allowlist,
  pg_catalog.strpos(p.prosrc, 'pg_advisory_xact_lock') > 0 as has_workspace_transaction_lock
from pg_catalog.pg_proc p
where p.oid = pg_catalog.to_regprocedure('public.ifsbridge_apply_changes(text,jsonb)');

-- Include every overload and effective ACL entry so unexpected legacy overloads
-- or PUBLIC grants are visible. Expected grantees are the owner + authenticated;
-- a service-role grant is also normal in a Supabase project.
select p.oid::regprocedure::text as signature,
  case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end as grantee,
  a.privilege_type, a.is_grantable
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
where n.nspname = 'public' and p.proname in ('ifsbridge_apply_changes','ifsbridge_schema_version')
order by signature, grantee;

-- Expected: all seven tables exist, have RLS, and expose SELECT only to clients.
-- TRUNCATE is included because it bypasses RLS and is never needed by this app.
with expected(name) as (values ('sheets'),('trips'),('expenses'),('weeks'),('templates'),('budgets'),('inbox'))
select e.name as table_name, c.oid is not null as table_exists,
  pg_catalog.pg_get_userbyid(c.relowner) as table_owner,
  c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced_for_owner,
  pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_select_privilege,
  pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
  pg_catalog.has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_insert,
  pg_catalog.has_table_privilege('authenticated', c.oid, 'UPDATE') as authenticated_update,
  pg_catalog.has_table_privilege('authenticated', c.oid, 'DELETE') as authenticated_delete,
  pg_catalog.has_table_privilege('authenticated', c.oid, 'TRUNCATE') as authenticated_truncate
from expected e left join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass('public.' || e.name)
order by e.name;

-- Ownership SELECT policy and restrictive Personal AAL2 policy should both be
-- present on every data table. Check unexpected policies as well as named ones.
select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_catalog.pg_policies
where (schemaname = 'public' and tablename in ('sheets','trips','expenses','weeks','templates','budgets','inbox'))
  or (schemaname = 'storage' and tablename = 'objects')
order by schemaname, tablename, policyname;

-- Must be present and private. Public bucket downloads bypass Storage RLS.
-- This reads bucket metadata only; it never lists receipt object names.
select exists(select 1 from storage.buckets where id = 'receipts') as receipts_bucket_exists,
  (select not public from storage.buckets where id = 'receipts') as receipts_bucket_is_private;

-- Read the actual installed definitions if a hash, permission or guard differs.
-- These functions contain application SQL, not account data or credentials.
select p.oid::regprocedure::text as signature, pg_catalog.pg_get_functiondef(p.oid) as installed_definition
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('ifsbridge_apply_changes','ifsbridge_schema_version')
order by signature;

commit;
