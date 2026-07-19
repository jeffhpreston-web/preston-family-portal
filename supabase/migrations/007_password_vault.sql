-- ============================================================================
-- 007_password_vault.sql
-- Shared credential vault for administrators (Settings → Password Vault).
--
-- Security model:
--   * Passwords are encrypted at rest (pgcrypto pgp_sym_encrypt) with a key
--     generated once at migration time and kept in vault_key — a table with
--     RLS enabled and NO policies, so it is unreachable through the API.
--   * Neither vault table has any RLS policies: the browser can only go
--     through the SECURITY DEFINER functions below, all of which require
--     access_level = 'admin'.
--   * vault_list() never returns passwords. Revealing one requires a separate
--     vault_reveal() call, which is recorded in activity_log — so every
--     password view shows up in Settings → Activity Logs.
--
-- Run in the member-app Supabase project → SQL editor. Safe to re-run.
-- ============================================================================

begin;

create extension if not exists pgcrypto with schema extensions;

-- One-row table holding the vault encryption key. RLS with no policies means
-- no API role can ever read it; only the definer functions below can.
create table if not exists public.vault_key (
  id  boolean primary key default true check (id),
  key text not null
);
alter table public.vault_key enable row level security;

insert into public.vault_key (id, key)
select true, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
where not exists (select 1 from public.vault_key);

create table if not exists public.vault_credentials (
  id           uuid primary key default gen_random_uuid(),
  site         text not null,                      -- 'PSA', 'PCGS', 'Alt', 'Fanatics', ...
  login_name   text,
  email        text,
  password_enc bytea,                              -- pgp_sym_encrypt(password, vault_key.key)
  updated_at   timestamptz not null default now(),
  updated_by   uuid references public.profiles(id)
);
alter table public.vault_credentials enable row level security;
-- (no policies: all access goes through the functions below)

-- ---------------------------------------------------------------------------
-- List credentials — everything EXCEPT the password.
-- ---------------------------------------------------------------------------
create or replace function public.vault_list()
returns table (id uuid, site text, login_name text, email text,
               has_password boolean, updated_at timestamptz, updated_by_name text)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if public.current_access_level() <> 'admin' then
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
grant execute on function public.vault_list() to authenticated;

-- ---------------------------------------------------------------------------
-- Create or update a credential. Pass p_id = null to create.
-- An empty p_password on update keeps the existing password.
-- ---------------------------------------------------------------------------
create or replace function public.vault_save(
  p_id uuid, p_site text, p_login_name text, p_email text, p_password text
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key text;
  v_id  uuid;
begin
  if public.current_access_level() <> 'admin' then
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
grant execute on function public.vault_save(uuid, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Reveal a password. Every call is written to activity_log.
-- ---------------------------------------------------------------------------
create or replace function public.vault_reveal(p_id uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key  text;
  v_site text;
  v_pw   text;
begin
  if public.current_access_level() <> 'admin' then
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
grant execute on function public.vault_reveal(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Delete a credential.
-- ---------------------------------------------------------------------------
create or replace function public.vault_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_site text;
begin
  if public.current_access_level() <> 'admin' then
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
grant execute on function public.vault_delete(uuid) to authenticated;

commit;
