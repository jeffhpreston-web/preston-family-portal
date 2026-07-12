-- ============================================================================
-- 005_more_categories.sql
-- Add four collection categories. Additive; safe to re-run.
-- Run in the member-app Supabase project → SQL editor.
-- ============================================================================

insert into public.archive_categories (slug, name, display_order) values
  ('photography-posters', 'Photography & Posters', 130),
  ('film-movies',         'Film & Movies',         140),
  ('family-archives',     'Family Archives',       150),
  ('trade-sports-cards',  'Trade & Sports Cards',  160)
on conflict (slug) do nothing;
