-- ============================================================================
-- 008_admin_guard_fix.sql  — SECURITY FIX, run immediately after 007.
--
-- Problem: current_access_level() returns NULL for anonymous callers (no
-- profiles row for auth.uid()). In SQL, NULL <> 'admin' evaluates to NULL,
-- not TRUE — so guards written as
--     if public.current_access_level() <> 'admin' then raise/return; end if;
-- never fire for anonymous requests, letting anyone holding the public anon
-- key call the vault functions (007) and read integration status (006).
--
-- Fix: coalesce the access level so the comparison is always TRUE/FALSE.
-- This replaces all five affected functions. Safe to re-run.
-- ============================================================================

begin;

-- ── 006: integration_status ────────────────────────────────────────────────
create or replace function public.integration_status()
returns table (key text, label text, category text, notes text, is_set boolean, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(public.current_access_level(), '') <> 'admin' then return; end if;
  return query
    select s.key, s.label, s.category, s.notes,
           (s.value is not null and s.value <> '') as is_set, s.updated_at
    from public.integration_settings s
    order by s.category nulls last, s.label;
end $$;

-- ── 007: vault_list ────────────────────────────────────────────────────────
create or replace function public.vault_list()
returns table (id uuid, site text, login_name text, email text,
               has_password boolean, updated_at timestamptz, updated_by_name text)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(public.current_access_level(), '') <> 'admin' then
    raise exception 'Admin access required';
  end if;
  return query
    select c.id, c.site, c.login_name, c.email,
           (c.password_enc is not null) as has_password,
           c.updated_at,
           coalesce(p.full_name, p.email) as updated_by_name
    from public.vault_credentials c
    left join public.profiles p on p.id = c.updated_by
    order by lower(c.site), c.updated_at desc;
end $$;

-- ── 007: vault_save ────────────────────────────────────────────────────────
create or replace function public.vault_save(
  p_id uuid, p_site text, p_login_name text, p_email text, p_password text
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
    insert into public.vault_credentials (site, login_name, email, password_enc, updated_at, updated_by)
    values (btrim(p_site),
            nullif(btrim(coalesce(p_login_name,'')), ''),
            nullif(btrim(coalesce(p_email,'')), ''),
            case when coalesce(p_password,'') <> '' then pgp_sym_encrypt(p_password, v_key) end,
            now(), auth.uid())
    returning vault_credentials.id into v_id;
    insert into public.activity_log (user_id, action, entity_type, entity_id, details)
    values (auth.uid(), 'vault_credential_added', 'vault_credential', v_id,
            jsonb_build_object('site', btrim(p_site)));
  else
    update public.vault_credentials c set
      site         = btrim(p_site),
      login_name   = nullif(btrim(coalesce(p_login_name,'')), ''),
      email        = nullif(btrim(coalesce(p_email,'')), ''),
      password_enc = case when coalesce(p_password,'') <> ''
                          then pgp_sym_encrypt(p_password, v_key)
                          else c.password_enc end,
      updated_at   = now(),
      updated_by   = auth.uid()
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

-- ── 007: vault_reveal ──────────────────────────────────────────────────────
create or replace function public.vault_reveal(p_id uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key  text;
  v_site text;
  v_pw   text;
begin
  if coalesce(public.current_access_level(), '') <> 'admin' then
    raise exception 'Admin access required';
  end if;
  select k.key into v_key from public.vault_key k limit 1;
  select c.site, case when c.password_enc is not null
                      then pgp_sym_decrypt(c.password_enc, v_key) end
    into v_site, v_pw
  from public.vault_credentials c where c.id = p_id;
  if v_site is null then
    raise exception 'Credential not found';
  end if;
  insert into public.activity_log (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'vault_password_viewed', 'vault_credential', p_id,
          jsonb_build_object('site', v_site));
  return v_pw;
end $$;

-- ── 007: vault_delete ──────────────────────────────────────────────────────
create or replace function public.vault_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_site text;
begin
  if coalesce(public.current_access_level(), '') <> 'admin' then
    raise exception 'Admin access required';
  end if;
  delete from public.vault_credentials c where c.id = p_id
  returning c.site into v_site;
  if v_site is null then
    raise exception 'Credential not found';
  end if;
  insert into public.activity_log (user_id, action, entity_type, entity_id, details)
  values (auth.uid(), 'vault_credential_deleted', 'vault_credential', p_id,
          jsonb_build_object('site', v_site));
end $$;

commit;
