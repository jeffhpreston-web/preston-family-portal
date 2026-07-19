-- ============================================================================
-- 009_vault_categories.sql
-- Password Vault: add Collection Category (references archive_categories),
-- Account Category (fixed list) and free-text Notes.
--
-- vault_list / vault_save are dropped and recreated because their signatures
-- change (return columns / parameters). Guards keep the coalesce() fix from
-- 008. Run in the member-app Supabase project → SQL editor. Safe to re-run.
-- ============================================================================

begin;

alter table public.vault_credentials
  add column if not exists collection_category_id uuid references public.archive_categories(id) on delete set null,
  add column if not exists account_category text,
  add column if not exists notes text;

alter table public.vault_credentials drop constraint if exists vault_account_category_chk;
alter table public.vault_credentials add constraint vault_account_category_chk
  check (account_category is null or account_category in
    ('Collector','Grader','Vault','Auction House','Retailer','Re-shipper','Submitter'));

-- ── vault_list: now returns the category fields and notes ──────────────────
drop function if exists public.vault_list();
create function public.vault_list()
returns table (id uuid, site text,
               collection_category_id uuid, collection_category text,
               account_category text, login_name text, email text,
               has_password boolean, notes text,
               updated_at timestamptz, updated_by_name text)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(public.current_access_level(), '') <> 'admin' then
    raise exception 'Admin access required';
  end if;
  return query
    select c.id, c.site,
           c.collection_category_id, ac.name as collection_category,
           c.account_category, c.login_name, c.email,
           (c.password_enc is not null) as has_password,
           c.notes,
           c.updated_at,
           coalesce(p.full_name, p.email) as updated_by_name
    from public.vault_credentials c
    left join public.archive_categories ac on ac.id = c.collection_category_id
    left join public.profiles p on p.id = c.updated_by
    order by lower(c.site), c.updated_at desc;
end $$;
grant execute on function public.vault_list() to authenticated;

-- ── vault_save: accepts the new fields ─────────────────────────────────────
drop function if exists public.vault_save(uuid, text, text, text, text);
drop function if exists public.vault_save(uuid, text, text, text, text, uuid, text, text);
create function public.vault_save(
  p_id uuid, p_site text, p_login_name text, p_email text, p_password text,
  p_collection_category_id uuid default null,
  p_account_category text default null,
  p_notes text default null
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key text;
  v_id  uuid;
begin
  if coalesce(public.current_access_level(), '') <> 'admin' then
    raise exception 'Admin access required';
  end if;
  if p_site is null or btrim(p_site) = '' then
    raise exception 'Site is required';
  end if;
  select k.key into v_key from public.vault_key k limit 1;

  if p_id is null then
    insert into public.vault_credentials
      (site, login_name, email, password_enc,
       collection_category_id, account_category, notes,
       updated_at, updated_by)
    values (btrim(p_site),
            nullif(btrim(coalesce(p_login_name,'')), ''),
            nullif(btrim(coalesce(p_email,'')), ''),
            case when coalesce(p_password,'') <> '' then pgp_sym_encrypt(p_password, v_key) end,
            p_collection_category_id,
            nullif(btrim(coalesce(p_account_category,'')), ''),
            nullif(btrim(coalesce(p_notes,'')), ''),
            now(), auth.uid())
    returning vault_credentials.id into v_id;
    insert into public.activity_log (user_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'vault_credential_added', 'vault_credential', v_id,
            jsonb_build_object('site', btrim(p_site)));
  else
    update public.vault_credentials c set
      site                   = btrim(p_site),
      login_name             = nullif(btrim(coalesce(p_login_name,'')), ''),
      email                  = nullif(btrim(coalesce(p_email,'')), ''),
      password_enc           = case when coalesce(p_password,'') <> ''
                                    then pgp_sym_encrypt(p_password, v_key)
                                    else c.password_enc end,
      collection_category_id = p_collection_category_id,
      account_category       = nullif(btrim(coalesce(p_account_category,'')), ''),
      notes                  = nullif(btrim(coalesce(p_notes,'')), ''),
      updated_at             = now(),
      updated_by             = auth.uid()
    where c.id = p_id
    returning c.id into v_id;
    if v_id is null then
      raise exception 'Credential not found';
    end if;
    insert into public.activity_log (user_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'vault_credential_updated', 'vault_credential', v_id,
            jsonb_build_object('site', btrim(p_site),
                               'password_changed', coalesce(p_password,'') <> ''));
  end if;
  return v_id;
end $$;
grant execute on function public.vault_save(uuid, text, text, text, text, uuid, text, text) to authenticated;

commit;
