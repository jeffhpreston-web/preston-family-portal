CREATE TABLE IF NOT EXISTS site_settings (
  key   text PRIMARY KEY,
  value text
);

-- Seed the registry stat keys so they exist for reads before first save
INSERT INTO site_settings (key, value) VALUES
  ('registry_member_count',    '0'),
  ('registry_countries_count', '0')
ON CONFLICT (key) DO NOTHING;
