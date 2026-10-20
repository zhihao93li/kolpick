-- Projects: everything that differs between projects is configuration here, not code.
CREATE TABLE projects (
  id            serial PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  region        text NOT NULL DEFAULT '',
  language      text NOT NULL DEFAULT '',
  brand_brief   text NOT NULL DEFAULT '',
  writing_guide text NOT NULL DEFAULT '',
  -- Default discovery parameters (keywords, seeds, follower range, ...) prefilled on the job form.
  discovery     jsonb NOT NULL DEFAULT '{}',
  feishu_webhook text NOT NULL DEFAULT '',
  reviewers     text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The shared KOL pool: one row per platform account, whichever project found it.
CREATE TABLE kols (
  id            bigserial PRIMARY KEY,
  platform      text NOT NULL CHECK (platform IN ('instagram', 'youtube', 'tiktok')),
  handle        text NOT NULL, -- normalized: lower case, no leading @
  profile_url   text NOT NULL DEFAULT '',
  name          text NOT NULL DEFAULT '',
  followers     integer,
  is_business   boolean,
  is_private    boolean,
  bio           text NOT NULL DEFAULT '',
  external_url  text NOT NULL DEFAULT '',
  tags          text[] NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, handle)
);

-- Every address found for a KOL, with where and when it was found (kept for compliance).
-- One address can belong to several KOLs (an agency inbox), so it is never used to merge them.
CREATE TABLE kol_emails (
  id            bigserial PRIMARY KEY,
  kol_id        bigint NOT NULL REFERENCES kols(id) ON DELETE CASCADE,
  email         text NOT NULL, -- lower case
  source        text NOT NULL CHECK (source IN ('platform_field', 'bio', 'link_page', 'youtube_hidden', 'import', 'manual')),
  source_url    text NOT NULL DEFAULT '',
  -- discovered -> basic_ok (syntax + MX) | unknown | invalid (hard bounce only)
  check_status  text NOT NULL DEFAULT 'discovered' CHECK (check_status IN ('discovered', 'basic_ok', 'unknown', 'invalid')),
  found_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kol_id, email)
);
CREATE INDEX kol_emails_email ON kol_emails (email);

CREATE TABLE discovery_jobs (
  id            bigserial PRIMARY KEY,
  project_id    integer NOT NULL REFERENCES projects(id),
  platform      text NOT NULL,
  params        jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  created_by    text NOT NULL DEFAULT '',
  message       text NOT NULL DEFAULT '', -- why it stopped early or failed
  spent_usd     numeric(10, 3) NOT NULL DEFAULT 0,
  found         integer NOT NULL DEFAULT 0,
  with_email    integer NOT NULL DEFAULT 0,
  new_to_project integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- Each Apify run a job started. A retried job finds its earlier runs here instead of paying twice.
CREATE TABLE apify_runs (
  id            bigserial PRIMARY KEY,
  job_id        bigint NOT NULL REFERENCES discovery_jobs(id) ON DELETE CASCADE,
  step          text NOT NULL,
  actor         text NOT NULL,
  run_id        text NOT NULL,
  dataset_id    text NOT NULL,
  status        text NOT NULL DEFAULT 'RUNNING',
  items         integer,
  cost_usd      numeric(10, 3),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  UNIQUE (job_id, step)
);

-- A KOL's state within one project.
CREATE TABLE project_kols (
  project_id    integer NOT NULL REFERENCES projects(id),
  kol_id        bigint NOT NULL REFERENCES kols(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'candidate'
                CHECK (status IN ('candidate', 'approved', 'rejected', 'contacted', 'replied', 'agreed', 'declined')),
  discovered_by text NOT NULL DEFAULT '',
  job_id        bigint REFERENCES discovery_jobs(id) ON DELETE SET NULL,
  notes         text NOT NULL DEFAULT '',
  custom        jsonb NOT NULL DEFAULT '{}', -- project-specific low-risk fields (quote, collaboration type, ...)
  reviewed_by   text NOT NULL DEFAULT '',
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, kol_id)
);
CREATE INDEX project_kols_status ON project_kols (project_id, status);

-- Unsubscribes, refusals and complaints. Re-scraping or importing never clears these.
CREATE TABLE do_not_contact (
  id            bigserial PRIMARY KEY,
  email         text, -- lower case
  platform      text,
  handle        text,
  project_id    integer REFERENCES projects(id), -- null = all projects
  reason        text NOT NULL,
  source        text NOT NULL DEFAULT '',
  created_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR (platform IS NOT NULL AND handle IS NOT NULL))
);
CREATE INDEX do_not_contact_email ON do_not_contact (email);
