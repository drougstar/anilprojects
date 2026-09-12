-- IFS Bridge private-owner Work/Personal migration, schema version 2.
-- Run this entire file in the Supabase SQL editor. No migration is run by the app.
-- Existing records become Work records; no records are deleted or moved between users.
-- Direct client table writes are revoked: all writes use the revision-checked RPC.
-- Docs: https://supabase.com/docs/guides/database/functions
-- https://supabase.com/docs/guides/database/postgres/row-level-security
-- https://postgrest.org/en/stable/references/transactions.html
begin;

-- Re-running this older file must not replace a newer, MFA-protected RPC.
-- This check runs before any schema, policy or function changes.
do $$
begin
  if to_regprocedure('public.ifsbridge_schema_version()') is not null then
    if public.ifsbridge_schema_version() > 2 then
      raise exception 'A newer workspace schema is already installed. Do not rerun workspaces-v2.sql; use the current Personal MFA migration if an update is needed.';
    end if;
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['sheets','trips','expenses','weeks','templates','budgets','inbox'] loop
    execute format('create table if not exists public.%I (
      id uuid not null,
      user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
      workspace_id text not null default ''work'',
      updated_at timestamptz not null default now(),
      deleted boolean not null default false,
      data jsonb not null default ''{}''::jsonb,
      revision bigint not null default 0
    )', t);
    execute format('alter table public.%I add column if not exists workspace_id text not null default ''work''', t);
    execute format('alter table public.%I add column if not exists revision bigint not null default 0', t);
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_pkey');
    execute format('alter table public.%I add constraint %I primary key (user_id, workspace_id, id)', t, t || '_pkey');
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_workspace_check');
    execute format('alter table public.%I add constraint %I check (workspace_id in (''work'', ''personal''))', t, t || '_workspace_check');
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('drop policy if exists "own workspace records" on public.%I', t);
    execute format('create policy "own workspace records" on public.%I for select to authenticated using (user_id = auth.uid())', t);
    execute format('revoke insert, update, delete on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

create or replace function public.ifsbridge_schema_version()
returns integer language sql stable security invoker set search_path = ''
as $$ select 2; $$;
revoke all on function public.ifsbridge_schema_version() from public, anon;
grant execute on function public.ifsbridge_schema_version() to authenticated;

-- SECURITY DEFINER is intentional: clients cannot write the tables directly.
-- This function checks auth.uid(), permits only the listed tables, qualifies every
-- table name, and restricts every row to that user and the requested workspace.
-- One workspace lock covers the whole validation+write transaction. A concurrent
-- device must recheck revisions after the earlier transaction commits.
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

insert into storage.buckets (id,name,public) values ('receipts','receipts',false) on conflict(id) do nothing;
drop policy if exists "own receipts" on storage.objects;
drop policy if exists "read own workspace receipts" on storage.objects;
drop policy if exists "write own workspace receipts" on storage.objects;
create policy "read own workspace receipts" on storage.objects for select to authenticated
  using (bucket_id='receipts' and (storage.foldername(name))[1]=auth.uid()::text
    and (array_length(storage.foldername(name),1)=1 or (storage.foldername(name))[2] in ('work','personal')));
create policy "write own workspace receipts" on storage.objects for all to authenticated
  using (bucket_id='receipts' and (storage.foldername(name))[1]=auth.uid()::text
    and array_length(storage.foldername(name),1)=2 and (storage.foldername(name))[2] in ('work','personal'))
  with check (bucket_id='receipts' and (storage.foldername(name))[1]=auth.uid()::text
    and array_length(storage.foldername(name),1)=2 and (storage.foldername(name))[2] in ('work','personal'));

notify pgrst, 'reload schema';
commit;
