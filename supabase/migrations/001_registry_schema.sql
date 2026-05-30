CREATE TABLE registry_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formspree_id text UNIQUE NOT NULL,
  first_name text,
  last_name text,
  email text,
  country text,
  connection text,
  lineage_notes text,
  newsletter boolean DEFAULT false,
  submitted_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE registry_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid REFERENCES registry_applications(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'new',  -- new | review | approved | denied
  registry_number text,
  notes text,
  decided_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX registry_decisions_app_id ON registry_decisions(application_id);

ALTER TABLE registry_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry_decisions ENABLE ROW LEVEL SECURITY;
