-- A generic B2C review resolution must not remove the reportability block on
-- a possible duplicate. A future dedicated workflow must record which source
-- payment is retained and which is excluded before either flag can close.
create or replace function public.resolve_b2c_review_flag(
  p_flag_id uuid,
  p_resolution_status public.review_flag_status,
  p_resolution_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Only an authenticated administrator can resolve a B2C review item';
  end if;
  if p_resolution_status not in ('resolved', 'dismissed') or char_length(trim(p_resolution_note)) = 0 then
    raise exception 'A resolution status and note are required';
  end if;
  if not exists (
    select 1
    from public.review_flags
    where id = p_flag_id
      and source_area in ('b2c_payment', 'b2c_refund')
      and status = 'open'
  ) then
    raise exception 'The B2C review item is unavailable or already resolved';
  end if;
  if exists (
    select 1
    from public.review_flags
    where id = p_flag_id
      and source_area in ('b2c_payment', 'b2c_refund')
      and flag_type = 'possible_duplicate'
      and status = 'open'
  ) then
    raise exception 'Possible duplicates must be decided through the dedicated duplicate workflow';
  end if;

  insert into public.review_flag_resolutions (flag_id, resolution_status, resolution_note)
  values (p_flag_id, p_resolution_status, trim(p_resolution_note));
end;
$$;

revoke all on function public.resolve_b2c_review_flag(uuid, public.review_flag_status, text) from public;
grant execute on function public.resolve_b2c_review_flag(uuid, public.review_flag_status, text) to authenticated;
