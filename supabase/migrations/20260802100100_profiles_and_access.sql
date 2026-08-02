-- Only the two approved roles exist in this rebuild: admin and viewer.

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
