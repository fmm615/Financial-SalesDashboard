-- Clean-slate consolidated migration (Task 1 of 4): extensions, shared enums,
-- the generic updated_at trigger, and the profiles/roles/approved_users/
-- profile_roles access model. Every other domain migration depends on the
-- enums and functions created here and must be applied after this one.
--
-- Deliberately NOT included here (handled by a final cross-cutting sweep
-- migration once every domain's tables exist, mirroring how the original
-- schema always treated this as a late step):
--   * audit trigger attachment (public.write_audit_event(), owned by the
--     Finance/Targets/Reports/Audit domain) on approved_users/profile_roles
--   * schema-wide blanket grants/revokes (`grant select on all tables in
--     schema public to authenticated`, etc.)

create extension if not exists pgcrypto;
create extension if not exists citext;

create type public.access_role as enum ('admin', 'viewer');
create type public.review_flag_type as enum (
  'refunded',
  'failed',
  'possible_duplicate',
  'unmapped_product',
  'needs_follow_up',
  'needs_fx_review'
);
create type public.review_flag_status as enum ('open', 'resolved', 'dismissed');
create type public.backfill_status as enum ('not_started', 'partial', 'complete', 'unavailable');
create type public.integration_status as enum ('pending', 'processing', 'completed', 'failed', 'cancelled');
create type public.report_type as enum ('monthly', 'quarterly', 'annual', 'ad_hoc');
create type public.report_job_status as enum ('pending', 'processing', 'completed', 'failed', 'cancelled');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- Only the two approved roles exist in this schema: admin and viewer.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email citext not null unique,
  display_name text not null check (char_length(trim(display_name)) > 0),
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  code public.access_role not null unique,
  description text not null,
  created_at timestamptz not null default timezone('utc', now())
);

insert into public.roles (code, description)
values
  ('admin', 'Full access. All application writes require this role.'),
  ('viewer', 'Read-only access to approved dashboard and traceability data.');

create table public.approved_users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  display_name text not null check (char_length(trim(display_name)) > 0),
  default_role_id uuid not null references public.roles(id),
  enabled boolean not null default true,
  approved_at timestamptz not null default timezone('utc', now()),
  approved_by uuid references public.profiles(id),
  disabled_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check ((enabled and disabled_at is null) or (not enabled and disabled_at is not null))
);

-- A profile has exactly one active role. The allowlist holds the intended role until
-- a user completes an approved Google login and receives their profile.
create table public.profile_roles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  role_id uuid not null references public.roles(id),
  assigned_at timestamptz not null default timezone('utc', now()),
  assigned_by uuid references public.profiles(id)
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  approved_role_id uuid;
  user_email citext;
  user_name text;
begin
  user_email := lower(trim(new.email))::citext;
  user_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    split_part(new.email, '@', 1)
  );

  insert into public.profiles (id, email, display_name, avatar_url)
  values (new.id, user_email, user_name, new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do update
    set email = excluded.email,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        updated_at = timezone('utc', now());

  select default_role_id into approved_role_id
  from public.approved_users
  where email = user_email and enabled = true;

  if approved_role_id is not null then
    insert into public.profile_roles (profile_id, role_id)
    values (new.id, approved_role_id)
    on conflict (profile_id) do update set role_id = excluded.role_id;
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

create or replace function public.current_profile_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select auth.uid();
$$;

-- Security-definer predicates avoid RLS recursion. They expose only a boolean and
-- run with a fixed search path; no client is granted table-bypass privileges.
create or replace function public.is_approved_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles profile
    join public.approved_users approved on approved.email = profile.email
    where profile.id = auth.uid()
      and approved.enabled
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_approved_user()
    and exists (
      select 1
      from public.profile_roles profile_role
      join public.roles role on role.id = profile_role.role_id
      where profile_role.profile_id = auth.uid()
        and role.code = 'admin'
    );
$$;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();
create trigger set_approved_users_updated_at
  before update on public.approved_users
  for each row execute procedure public.set_updated_at();

-- RLS: every table here has it enabled and only the policies below.
alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.approved_users enable row level security;
alter table public.profile_roles enable row level security;

create policy profiles_read_approved on public.profiles for select to authenticated using (public.is_approved_user());
create policy roles_read_approved on public.roles for select to authenticated using (public.is_approved_user());
create policy profile_roles_read_own_or_admin on public.profile_roles for select to authenticated
  using (profile_id = auth.uid() or public.is_admin());
create policy approved_users_read_admin on public.approved_users for select to authenticated using (public.is_admin());

create policy approved_users_insert_admin on public.approved_users for insert to authenticated with check (public.is_admin());
create policy approved_users_update_admin on public.approved_users for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy profile_roles_insert_admin on public.profile_roles for insert to authenticated with check (public.is_admin());
create policy profile_roles_update_admin on public.profile_roles for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy profile_roles_delete_admin on public.profile_roles for delete to authenticated using (public.is_admin());

-- Table-specific grants (the schema-wide `grant select on all tables in schema
-- public to authenticated` baseline is applied once, later, by the final
-- cross-cutting sweep migration after every domain's tables exist).
grant insert, update on table public.approved_users to authenticated;
grant insert, update, delete on table public.profile_roles to authenticated;

revoke all on function public.handle_new_auth_user() from public;
grant execute on function public.current_profile_id(), public.is_approved_user(), public.is_admin() to authenticated;
