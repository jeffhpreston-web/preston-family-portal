-- ============================================================================
-- 004_archive_documents.sql
-- Document attachments for archive items (appraisals, provenance papers,
-- certificates, receipts, insurance, correspondence, ...).
--
-- Files live in the SAME private 'archive' Storage bucket as photos, under
-- documents/<item_id>/..., so the storage policies from 003 already cover them.
-- Run in the member-app Supabase project → SQL editor. Safe to re-run.
-- ============================================================================

begin;

create table if not exists public.archive_documents (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references public.archive_items(id) on delete cascade,
  storage_path  text not null,          -- e.g. 'documents/<item_id>/appraisal.pdf'
  title         text,
  doc_type      text,                   -- appraisal | provenance | certificate
                                         -- | receipt | insurance | correspondence | other
  bytes         bigint,
  content_type  text,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now()
);
create index if not exists archive_documents_item_idx on public.archive_documents(item_id);

alter table public.archive_documents enable row level security;

-- Members read (documents can be sensitive → never exposed to the public,
-- unlike photos); admins write. Mirrors archive_valuations.
drop policy if exists docs_read on public.archive_documents;
create policy docs_read on public.archive_documents for select
  using (public.current_access_level() is not null);

drop policy if exists docs_write on public.archive_documents;
create policy docs_write on public.archive_documents for all
  using (public.is_archivist()) with check (public.is_archivist());

commit;
