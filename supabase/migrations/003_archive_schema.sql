-- ============================================================================
-- 003_archive_schema.sql
-- The Preston Collection — Archival Record System
-- ----------------------------------------------------------------------------
-- A museum-grade catalog for the curated family collection (art, jewelry,
-- coins, horology, manuscripts, sports memorabilia, ...). This is the SYSTEM
-- OF RECORD and is intentionally separate from the member-contributed
-- `contributions`/`collections` tables (those stay as-is).
--
-- Deploy target: the MEMBER-APP Supabase project (witvlkcjvzxxajdwzdep — auth +
--   storage already live there). Run in the Supabase Dashboard → SQL editor.
--   The Netlify archive functions read this project via ARCHIVE_* env vars, so
--   the clanpreston.org registry project (jkmqyncnkyglymvspnmk) is untouched.
--
-- Design goals
--   1. Rich, normalized catalog records with full provenance & valuation history
--   2. First-class photo management backed by Supabase Storage
--   3. A generic external-reference table so ANY future API integration
--      (HubSpot deals, PSA/PCGS/NGC certs, auction lots, insurance, appraisal)
--      attaches without a schema change
--   4. RLS from day one: public sees only what is explicitly published;
--      members see the catalog per access level; only admins write.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Helpers
-- ---------------------------------------------------------------------------

-- updated_at auto-touch trigger (idempotent)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Returns the caller's access_level from profiles ('admin' | 'full_member' |
-- 'contributor' | 'view_only' | NULL). Used throughout RLS.
create or replace function public.current_access_level()
returns text language sql stable security definer set search_path = public as $$
  select access_level from public.profiles where id = auth.uid();
$$;

create or replace function public.is_archivist()
returns boolean language sql stable as $$
  select public.current_access_level() = 'admin';
$$;

-- ---------------------------------------------------------------------------
-- 1. Reference data: categories
-- ---------------------------------------------------------------------------
create table if not exists public.archive_categories (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,          -- 'fine-art', 'coins', ...
  name          text not null,
  description   text,
  display_order int  not null default 0,
  icon          text,                           -- optional UI glyph/emoji
  created_at    timestamptz not null default now()
);

insert into public.archive_categories (slug, name, display_order) values
  ('fine-art',          'Fine Art',            10),
  ('jewelry',           'Jewelry',             20),
  ('coins',             'Coins & Numismatics', 30),
  ('horology',          'Horology',            40),
  ('manuscripts',       'Manuscripts',         50),
  ('sports-memorabilia','Sports Memorabilia',  60),
  ('philately',         'Stamps & Philately',  70),
  ('militaria',         'Militaria',           80),
  ('ceramics',          'Ceramics & Glass',    90),
  ('books',             'Rare Books',         100),
  ('furniture',         'Furniture & Decor',  110),
  ('ephemera',          'Ephemera & Documents',120)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Core catalog: archive_items
-- ---------------------------------------------------------------------------
create table if not exists public.archive_items (
  id              uuid primary key default gen_random_uuid(),

  -- Human-facing accession number, e.g. 'PC-2026-0042'. Unique when present.
  accession_no    text unique,

  title           text not null,
  category_id     uuid references public.archive_categories(id),
  subcategory     text,

  short_desc      text,                 -- one-line summary for cards
  description     text,                 -- full curatorial description (markdown ok)

  -- Physical / catalog attributes
  maker           text,                 -- artist / mint / manufacturer / author
  origin_country  text,
  date_text       text,                 -- free-form, e.g. 'c. 1780' or '1934'
  year_from       int,                  -- structured for range queries / sorting
  year_to         int,
  medium          text,                 -- 'oil on canvas', 'gold 18k', ...
  dimensions      text,
  weight          text,
  condition       text,                 -- 'Mint','Fine','Fair', or grade string
  edition_info    text,                 -- '9 of 20', 'No. 1 of 10 only', ...

  -- Generational lineage (8+ generations) — which family member held it
  held_by         text,
  generation      int,                  -- 1 = earliest documented generation

  -- Where the object physically is right now (vault, safe, on loan, office).
  -- Intentionally NOT exposed in archive_public_items — do not broadcast the
  -- location of valuable items to the public.
  current_location text,

  -- Curation & visibility
  tags            text[] not null default '{}',
  is_public       boolean not null default false,  -- shown on public site
  is_featured     boolean not null default false,
  status          text not null default 'active',  -- active | deaccessioned | on_loan | lost
  display_order   int  not null default 0,

  -- Financials (private; never exposed via public view)
  acquisition_price   numeric(14,2),
  acquisition_date    date,
  acquisition_source  text,             -- dealer / auction house name
  estimated_value     numeric(14,2),
  currency            text default 'USD',

  -- Denormalized primary image (kept in sync by trigger below) for fast lists
  primary_photo_path  text,

  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists archive_items_category_idx on public.archive_items(category_id);
create index if not exists archive_items_public_idx   on public.archive_items(is_public) where is_public;
create index if not exists archive_items_status_idx   on public.archive_items(status);
create index if not exists archive_items_tags_idx     on public.archive_items using gin(tags);
create index if not exists archive_items_year_idx     on public.archive_items(year_from, year_to);

drop trigger if exists trg_archive_items_touch on public.archive_items;
create trigger trg_archive_items_touch before update on public.archive_items
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Photos — multiple per item, ordered, one primary
--    Files live in the private Storage bucket 'archive' (see section 8).
--    `storage_path` is the object path within that bucket.
-- ---------------------------------------------------------------------------
create table if not exists public.archive_photos (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references public.archive_items(id) on delete cascade,
  storage_path  text not null,          -- e.g. 'items/<item_id>/front.jpg'
  caption       text,
  is_primary    boolean not null default false,
  width         int,
  height        int,
  bytes         bigint,
  content_type  text,
  display_order int not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists archive_photos_item_idx on public.archive_photos(item_id);
-- At most one primary photo per item
create unique index if not exists archive_photos_one_primary
  on public.archive_photos(item_id) where is_primary;

-- Keep archive_items.primary_photo_path in sync with the primary photo row
create or replace function public.sync_primary_photo()
returns trigger language plpgsql as $$
declare
  target_item uuid := coalesce(new.item_id, old.item_id);
  p text;
begin
  select storage_path into p
  from public.archive_photos
  where item_id = target_item
  order by is_primary desc, display_order asc, created_at asc
  limit 1;

  update public.archive_items set primary_photo_path = p where id = target_item;
  return null;
end;
$$;

drop trigger if exists trg_archive_photos_sync on public.archive_photos;
create trigger trg_archive_photos_sync
  after insert or update or delete on public.archive_photos
  for each row execute function public.sync_primary_photo();

-- ---------------------------------------------------------------------------
-- 4. Provenance — the custody / event chain (acquisition, gift, exhibition,
--    appraisal, restoration, deaccession, ...)
-- ---------------------------------------------------------------------------
create table if not exists public.archive_provenance (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references public.archive_items(id) on delete cascade,
  event_type    text not null,          -- acquired | gifted | inherited | exhibited
                                         -- | appraised | restored | loaned | deaccessioned
  event_date    date,
  actor         text,                   -- who (person / institution)
  location      text,
  detail        text,
  sort_key      int not null default 0, -- manual ordering when dates are fuzzy
  created_at    timestamptz not null default now()
);
create index if not exists archive_provenance_item_idx on public.archive_provenance(item_id);

-- ---------------------------------------------------------------------------
-- 5. Valuation history — time series of appraised / market values
-- ---------------------------------------------------------------------------
create table if not exists public.archive_valuations (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references public.archive_items(id) on delete cascade,
  valued_on     date not null default current_date,
  amount        numeric(14,2) not null,
  currency      text not null default 'USD',
  basis         text,                   -- 'auction comp' | 'insurance' | 'appraisal'
  source        text,                   -- appraiser / house / API name
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists archive_valuations_item_idx on public.archive_valuations(item_id, valued_on desc);

-- ---------------------------------------------------------------------------
-- 6. Certifications — third-party grading/authentication (PSA/PCGS/NGC/...)
--    Generalizes the existing PSA cert lookup into a stored, multi-provider record.
-- ---------------------------------------------------------------------------
create table if not exists public.archive_certifications (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references public.archive_items(id) on delete cascade,
  provider      text not null,          -- 'PSA' | 'PCGS' | 'NGC' | 'SGC' | ...
  cert_number   text not null,
  grade         text,
  verified_at   timestamptz,
  raw           jsonb,                  -- full API payload snapshot
  created_at    timestamptz not null default now(),
  unique (provider, cert_number)
);
create index if not exists archive_cert_item_idx on public.archive_certifications(item_id);

-- ---------------------------------------------------------------------------
-- 7. External references — THE future-API hook.
--    Any external system links to an item here with no schema change:
--    HubSpot deal, auction lot URL, insurance policy, WordPress post, etc.
-- ---------------------------------------------------------------------------
create table if not exists public.archive_external_refs (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references public.archive_items(id) on delete cascade,
  system        text not null,          -- 'hubspot' | 'psa' | 'wordpress' | 'ebay' | ...
  ref_type      text,                   -- 'deal' | 'lot' | 'policy' | 'post' | ...
  ref_id        text,                   -- external id
  url           text,
  data          jsonb,                  -- cached payload / metadata
  synced_at     timestamptz,
  created_at    timestamptz not null default now(),
  unique (system, ref_type, ref_id)
);
create index if not exists archive_extref_item_idx on public.archive_external_refs(item_id);
create index if not exists archive_extref_sys_idx  on public.archive_external_refs(system, ref_type);

-- ---------------------------------------------------------------------------
-- 8. Storage bucket for photos (private). Access is via signed URLs issued by
--    the `archive-photo-sign` Netlify function, so RLS on the table controls
--    who can see an item's images.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('archive', 'archive', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 9. Public read view — the ONLY archive surface exposed to anon.
--    Deliberately omits all financial columns.
-- ---------------------------------------------------------------------------
create or replace view public.archive_public_items
with (security_invoker = true) as
  select
    i.id, i.accession_no, i.title, i.short_desc, i.description,
    i.maker, i.origin_country, i.date_text, i.year_from, i.year_to,
    i.medium, i.dimensions, i.condition, i.edition_info,
    i.held_by, i.generation, i.tags, i.is_featured, i.display_order,
    i.primary_photo_path,
    c.slug as category_slug, c.name as category_name
  from public.archive_items i
  left join public.archive_categories c on c.id = i.category_id
  where i.is_public = true and i.status = 'active';

-- ---------------------------------------------------------------------------
-- 10. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.archive_categories     enable row level security;
alter table public.archive_items          enable row level security;
alter table public.archive_photos         enable row level security;
alter table public.archive_provenance     enable row level security;
alter table public.archive_valuations     enable row level security;
alter table public.archive_certifications enable row level security;
alter table public.archive_external_refs  enable row level security;

-- Categories: readable by everyone (safe reference data); admin writes.
drop policy if exists cat_read on public.archive_categories;
create policy cat_read on public.archive_categories for select using (true);
drop policy if exists cat_write on public.archive_categories;
create policy cat_write on public.archive_categories for all
  using (public.is_archivist()) with check (public.is_archivist());

-- Items: authenticated members read the full catalog; anon reads only public
-- rows (via the view, which is security_invoker so this policy still applies).
drop policy if exists items_read_members on public.archive_items;
create policy items_read_members on public.archive_items for select
  using (public.current_access_level() is not null);

drop policy if exists items_read_public on public.archive_items;
create policy items_read_public on public.archive_items for select
  using (is_public = true and status = 'active');

drop policy if exists items_write_admin on public.archive_items;
create policy items_write_admin on public.archive_items for all
  using (public.is_archivist()) with check (public.is_archivist());

-- Child tables: members read rows for items they can read; admin writes.
-- Financial child tables (valuations) are members+admin read only.
do $$
declare t text;
begin
  foreach t in array array['archive_photos','archive_provenance','archive_certifications','archive_external_refs']
  loop
    execute format('drop policy if exists %I_read on public.%I;', t, t);
    execute format($f$create policy %1$I_read on public.%1$I for select
      using (exists (select 1 from public.archive_items i where i.id = %1$I.item_id
             and (public.current_access_level() is not null
                  or (i.is_public and i.status = 'active'))));$f$, t);
    execute format('drop policy if exists %I_write on public.%I;', t, t);
    execute format($f$create policy %1$I_write on public.%1$I for all
      using (public.is_archivist()) with check (public.is_archivist());$f$, t);
  end loop;
end $$;

-- Valuations: members & admin read (never public), admin writes.
drop policy if exists val_read on public.archive_valuations;
create policy val_read on public.archive_valuations for select
  using (public.current_access_level() is not null);
drop policy if exists val_write on public.archive_valuations;
create policy val_write on public.archive_valuations for all
  using (public.is_archivist()) with check (public.is_archivist());

-- Storage: the private 'archive' bucket. Members may read (so signed URLs can
-- be minted); admins may upload/replace/delete. This lets the portal work
-- directly against Supabase with the admin's own JWT — no service-role needed.
drop policy if exists archive_storage_read on storage.objects;
create policy archive_storage_read on storage.objects for select
  using (bucket_id = 'archive' and public.current_access_level() is not null);
drop policy if exists archive_storage_write on storage.objects;
create policy archive_storage_write on storage.objects for all
  using (bucket_id = 'archive' and public.is_archivist())
  with check (bucket_id = 'archive' and public.is_archivist());

commit;

-- ============================================================================
-- Post-deploy notes
--   * The portal (index.html) works DIRECTLY against Supabase using the signed-in
--     admin's JWT — RLS above grants admins full write and members read, so no
--     service-role key or Netlify function is required for day-to-day cataloguing.
--   * The Netlify archive-* functions remain available for EXTERNAL API use
--     (HubSpot/PSA sync, public site) and enforce admin identity themselves.
--   * To publish an item to the public site: set is_public = true.
--   * Photos live in the private 'archive' bucket; the portal mints short-lived
--     signed URLs via POST /storage/v1/object/sign/archive/<path>.
-- ============================================================================
