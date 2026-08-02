create table public.review_flags (
  id uuid primary key default gen_random_uuid(),
  source_area text not null check (source_area in ('b2c_payment', 'b2c_refund', 'b2b_deal', 'b2b_booking', 'b2b_recognised_sale', 'product_mapping', 'integration')),
  source_record_id uuid not null,
  flag_type public.review_flag_type not null,
  status public.review_flag_status not null default 'open',
  priority smallint not null default 3 check (priority between 1 and 5),
  reason text not null check (char_length(trim(reason)) > 0),
  assigned_to uuid references public.profiles(id),
  created_by uuid references public.profiles(id),
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check ((status = 'open' and resolved_by is null and resolved_at is null)
    or (status in ('resolved', 'dismissed') and resolved_by is not null and resolved_at is not null))
);

create table public.review_flag_resolutions (
  id uuid primary key default gen_random_uuid(),
  flag_id uuid not null unique references public.review_flags(id),
  resolution_status public.review_flag_status not null check (resolution_status in ('resolved', 'dismissed')),
  resolution_note text not null check (char_length(trim(resolution_note)) > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create table public.review_notes (
  id uuid primary key default gen_random_uuid(),
  flag_id uuid not null references public.review_flags(id),
  note text not null check (char_length(trim(note)) > 0),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now())
);

create or replace function public.apply_review_resolution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Review resolutions require an authenticated administrator';
  end if;
  new.created_by := auth.uid();

  update public.review_flags
  set status = new.resolution_status,
      resolved_by = auth.uid(),
      resolved_at = timezone('utc', now())
  where id = new.flag_id
    and status = 'open';

  if not found then
    raise exception 'Only an open review flag can be resolved';
  end if;
  return new;
end;
$$;

create or replace function public.assign_review_note_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Review notes require an authenticated administrator';
  end if;
  new.created_by := auth.uid();
  return new;
end;
$$;

create trigger resolve_review_flag before insert on public.review_flag_resolutions
  for each row execute procedure public.apply_review_resolution();
create trigger assign_review_note_actor before insert on public.review_notes
  for each row execute procedure public.assign_review_note_actor();
create trigger set_review_flags_updated_at before update on public.review_flags
  for each row execute procedure public.set_updated_at();
