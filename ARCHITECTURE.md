# The Preston Collection — System Architecture

_Last updated: 2026-07-11_

This document describes the current stack, the target architecture for the
**archival record system**, and the API surface designed for future integrations.

---

## 1. Systems inventory

| Layer | System | Role | Notes |
|---|---|---|---|
| Public site | **WordPress.com** (`prestoncollection.net`) | Marketing/brochure site: History, Collections, Acquiring, Contact | Atomic/WordPress.com host, Jetpack forms, Gutenberg |
| Family portal (org) | **WordPress** (`clanpreston.org`, page 72) | Seanchaidh admin: map locations + registry | Calls Supabase anon key + Netlify functions from the browser |
| Member app | **`index.html`** (Netlify + GitHub Pages) | "Family Access" login → collections, contributions, historical locations, member directory | Supabase Auth + Storage; **currently double-hosted** |
| Backend (registry) | **Supabase** `jkmqyncnkyglymvspnmk` | registry_applications, registry_decisions, clan_map_locations, site_settings | Serves clanpreston.org |
| Backend (member/archive) | **Supabase** `witvlkcjvzxxajdwzdep` | profiles, collections, contributions, historical_locations, + **new archive_\*** | Serves the member app; **system of record for the archive** |
| Functions | **Netlify** (`vermillion-bonbon-d04317`) | Serverless API; holds service-role key & secrets | `/api/*` → `/.netlify/functions/*` |
| CRM | **HubSpot** (portal 242409609) | Manual acquisition tracker: deals = individual acquisitions, contacts/companies = dealers & auction houses | **Not wired to the site** today |
| Cert lookup | **PSA API** (`psa-lookup.js`) | Card certification lookups | Generalized by `archive_certifications` |
| Form intake | **Formspree** (`mdajkzkk`) + Jetpack | Registry applications / contact | |

### Key observation
There are **two Supabase projects** and the member app is **deployed twice**
(Netlify + GitHub Pages). This is the largest structural inefficiency. The
target is to make the `witvlkcjvzxxajdwzdep` project the **system of record for
the collection** and pick a single host for the member app.

---

## 2. Archival record system (new)

Migration `supabase/migrations/003_archive_schema.sql`. Deploy to the
**member-app project** (auth + storage already there).

```
archive_categories ──┐
                     │
archive_items ───────┼─< archive_photos        (Storage bucket 'archive', private)
   │                 ├─< archive_provenance     (custody/event chain)
   │                 ├─< archive_valuations     (value over time)
   │                 ├─< archive_certifications (PSA/PCGS/NGC/…)
   │                 └─< archive_external_refs  (HubSpot deal, auction lot, …)
   │
   └── view: archive_public_items  (published, no financials — the ONLY anon surface)
```

**Why this shape**
- `archive_items` is the master catalog record — rich enough for art, coins,
  jewelry, manuscripts, and memorabilia in one table (category + free-form
  attributes + structured year range for sorting/search).
- **Photos** are a first-class child table backed by a private Storage bucket.
  Bytes travel browser → Storage directly via signed upload URLs; the DB only
  stores paths + metadata. One primary photo per item is enforced by a partial
  unique index and mirrored onto `archive_items.primary_photo_path` for fast lists.
- **Provenance** and **valuations** are append-only histories — essential for a
  multi-generational archive and for insurance/appraisal.
- **`archive_external_refs`** is the future-proofing hook: any external system
  attaches to an item with no schema change (see §4).
- **RLS** is on from day one: anon sees only `archive_public_items`; members
  read the catalog; only `access_level='admin'` writes.

---

## 3. API layer

All under `/api/*` (Netlify). Auth helper: `netlify/functions/_lib/auth.js`.

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/archive-items` | GET | none (read) | Public list/detail from `archive_public_items` (filters: category, tag, featured, id, paging) |
| `/api/archive-admin` | POST | **admin JWT** | Upsert/delete items, photos, provenance, valuations, certs, external refs |
| `/api/archive-photo-sign` | GET | member JWT _or_ public item | Short-lived signed **download** URL |
| `/api/archive-photo-sign` | POST | **admin JWT** | Signed **upload** URL (browser → Storage direct) |

**Auth model.** Admin write endpoints verify a **Supabase Auth JWT** and check
`profiles.access_level='admin'` — the same session the member app already
issues. No static secrets in the browser. This is the pattern the existing
registry admin functions should migrate to (see Security report).

---

## 4. Designing for future API integrations

The integration contract is `archive_external_refs (item_id, system, ref_type,
ref_id, url, data, synced_at)` with a uniqueness key of `(system, ref_type,
ref_id)`. To add an integration:

1. Write a Netlify function `integrations/<system>.js` that pulls/pushes the
   external data using a secret in Netlify env.
2. Upsert a row via `archive-admin` action `extref.upsert` (or directly with the
   service key) linking the external record to the item; cache the payload in `data`.
3. Optionally schedule it (Netlify scheduled function / cron) for periodic sync.

Ready-to-slot integrations:

| System | ref_type | Direction | Value |
|---|---|---|---|
| **HubSpot** | `deal` | pull | Attach each acquisition deal (price, source, dealer) to its item — unifies the CRM acquisition tracker with the catalog |
| **PSA / PCGS / NGC** | `cert` | pull | Store grading payloads in `archive_certifications` (PSA path already exists) |
| **Auction houses / eBay** | `lot` | pull | Comparable sales feeding `archive_valuations` |
| **Insurance / appraisal** | `policy`/`appraisal` | push | Export scheduled-item lists with current valuations |
| **WordPress** | `post` | push | Publish `is_public` items to `prestoncollection.net/collections` |

---

## 5. Recommended target state

1. **Consolidate hosting** of the member app to one origin (Netlify, so security
   headers + functions live together); retire the GitHub Pages copy or make it a
   redirect.
2. **One system of record** for the collection: `witvlkcjvzxxajdwzdep` + the
   `archive_*` schema. Keep the registry project as-is or fold it in later.
3. **Move Seanchaidh admin behind Supabase Auth** (JWT), replacing browser-side
   service access, using the `_lib/auth.js` pattern.
4. **Wire HubSpot → archive** via `archive_external_refs` so acquisitions,
   provenance, and the public catalog are one connected graph.
