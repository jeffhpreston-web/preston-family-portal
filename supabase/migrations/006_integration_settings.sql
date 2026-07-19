-- ============================================================================
-- 006_integration_settings.sql
-- Admin-managed API tokens / integration credentials.
--
-- Security model:
--   * Admins can INSERT/UPDATE (set or replace a token) but there is NO SELECT
--     policy for the browser — so the stored secret can never be read back into
--     the portal (write-only from the UI).
--   * The portal reads only a "configured / not" status via integration_status(),
--     which returns booleans, never values.
--   * Server-side Netlify functions read the actual values with the service-role
--     key (which bypasses RLS). The service-role key stays in Netlify; every
--     other integration token is managed here.
--
-- Run in the member-app Supabase project → SQL editor. Safe to re-run.
-- ============================================================================

begin;

create table if not exists public.integration_settings (
  key         text primary key,        -- 'psa_api_token', 'hubspot_token', ...
  label       text not null,           -- display name in the UI
  value       text,                    -- the secret (null = not set)
  category    text,                    -- 'grading' | 'crm' | 'other'
  notes       text,
  updated_at  timestamptz default now(),
  updated_by  uuid references public.profiles(id)
);

alter table public.integration_settings enable row level security;

-- Admins may write, but NOT read (no select policy → values never leave the DB
-- to the browser). Separate per-command policies so SELECT is deliberately absent.
drop policy if exists intset_insert on public.integration_settings;
create policy intset_insert on public.integration_settings
  for insert with check (public.is_archivist());

drop policy if exists intset_update on public.integration_settings;
create policy intset_update on public.integration_settings
  for update using (public.is_archivist()) with check (public.is_archivist());

drop policy if exists intset_delete on public.integration_settings;
create policy intset_delete on public.integration_settings
  for delete using (public.is_archivist());

-- Safe status view for the UI: which keys are set, never the values. Admin-only.
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
grant execute on function public.integration_status() to authenticated;

-- Seed the planned integrations (values null until an admin sets them).
insert into public.integration_settings (key, label, category, notes) values
  ('psa_api_token',  'PSA API Token',              'grading', 'Public API token from api.psacard.com. Used by cert verification.'),
  ('pcgs_api_key',   'PCGS API Key',               'grading', 'Public API key from PCGS. Enables PCGS cert verification.'),
  ('ngc_api_key',    'NGC API Key',                'grading', 'NGC has no open public API yet — placeholder for when available.'),
  ('hubspot_token',  'HubSpot Private App Token',  'crm',     'Private-app token with CRM scopes, for deal / provenance sync.')
on conflict (key) do nothing;

commit;
