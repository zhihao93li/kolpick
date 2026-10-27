/**
 * The kolpick tables. One operator, one database per environment (kolpick_test / kolpick_prod), several business
 * projects per database. Each entry runs once, in order, recorded in schema_migrations; never edit a shipped entry,
 * add a new one.
 *
 * Hard rules from docs/design.md §4 that the database itself enforces:
 * - one pending outgoing mail per KOL per project (proposals_one_pending_mail)
 * - one record per incoming mail (messages_unique_mail)
 * - one external action per proposal and kind, so a code is never created twice and a mail never sent twice (actions_once)
 */
export const MIGRATIONS: string[] = [
  `
  create table projects (
    id          serial primary key,
    name        text not null unique,
    -- Rules the operator edits in the console: quotas, follow-up days, cooldown, code defaults… (see settings.ts)
    settings    jsonb not null default '{}',
    paused      boolean not null default false,
    created_at  timestamptz not null default now()
  );

  create table mailboxes (
    id            serial primary key,
    project_id    int not null references projects(id),
    address       text not null,
    enabled       boolean not null default false,
    daily_limit   int not null default 50,
    -- warm-up: the limit starts at warmup_start on warmup_from and grows by warmup_step a day up to daily_limit
    warmup_from   date,
    warmup_start  int,
    warmup_step   int,
    note          text,
    unique (project_id, address)
  );

  create table templates (
    id           serial primary key,
    project_id   int not null references projects(id),
    name         text not null,
    purpose      text not null,
    language     text,
    subject      text,
    body         text not null,
    -- draft: being written or waiting for approval; active: in use; retired: no longer used
    status       text not null default 'draft' check (status in ('draft', 'active', 'retired')),
    -- a draft that will replace this active template once approved
    draft_of     int references templates(id),
    approved_at  timestamptz,
    note         text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
  );

  -- A KOL in one project: profile plus where the conversation stands.
  create table kols (
    id               serial primary key,
    project_id       int not null references projects(id),
    name             text not null,
    handle           text,
    salutation       text,
    platform         text,
    platforms        text[] not null default '{}',
    url              text,
    other_accounts   text,
    email            text,
    other_emails     text,
    followers        int,
    market           text,
    language         text,
    content_type     text,
    tags             text[] not null default '{}',
    invite_angle     text,
    source_batch     text,
    requirements     text,
    notes            text,
    never_contact    boolean not null default false,
    never_reason     text,
    -- conversation
    stage            text not null default 'new'
                     check (stage in ('new', 'invited', 'replied', 'trial', 'report_seen', 'publish_agreed', 'published', 'partner', 'on_hold', 'closed')),
    whose_turn       text check (whose_turn in ('kol', 'us', 'none')),
    level            text,
    demand           text,
    mailbox          text,
    invite_batch     text,
    first_invited_at timestamptz,
    last_contact_at  timestamptz,
    last_inbound_at  timestamptz,
    next_followup_at timestamptz,
    publish_due_at   timestamptz,
    next_step        text,
    close_reason     text,
    deliverables     text[] not null default '{}',
    legacy_profile   text unique,
    legacy_followup  text unique,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
  );
  create index kols_project_email on kols (project_id, lower(email));
  create index kols_project_stage on kols (project_id, stage);

  -- Every mail in or out, and notes the operator or agent keep with the conversation.
  create table messages (
    id           serial primary key,
    project_id   int not null references projects(id),
    kol_id       int references kols(id),
    direction    text not null check (direction in ('in', 'out', 'note')),
    mailbox      text,
    message_id   text,
    thread_id    text,
    subject      text,
    from_addr    text,
    to_addr      text,
    body         text,
    summary      text,
    at           timestamptz not null,
    -- in: waiting for someone to deal with it (unmatched sender, bounce…)
    pending      boolean not null default false,
    bounce       boolean not null default false,
    resolved_at  timestamptz,
    legacy_id    text unique,
    created_at   timestamptz not null default now()
  );
  create unique index messages_unique_mail on messages (project_id, coalesce(mailbox, ''), message_id) where message_id is not null;
  create index messages_kol on messages (kol_id, at);
  create index messages_out_day on messages (project_id, at) where direction = 'out';

  create table codes (
    id               serial primary key,
    project_id       int not null references projects(id),
    kol_id           int not null references kols(id),
    kind             text not null check (kind in ('trial', 'partner')),
    code             text not null,
    max_uses         int,
    used             int,
    expires_at       timestamptz,
    active           boolean,
    ref_link         text,
    ledger_link      text,
    partner_id       text,
    paid_orders      int,
    refunded_orders  int,
    visitors         int,
    last_used_at     timestamptz,
    synced_at        timestamptz,
    created_at       timestamptz not null default now(),
    unique (project_id, kind, code)
  );

  create table posts (
    id            serial primary key,
    project_id    int not null references projects(id),
    kol_id        int not null references kols(id),
    url           text not null,
    platform      text,
    format        text,
    title         text,
    published_at  timestamptz,
    link_placed   boolean,
    -- {"1": {"views": 100, "engagement": 5, "at": "..."}, "3": …, "7": …, "30": …}
    metrics       jsonb not null default '{}',
    notes         text,
    legacy_id     text unique,
    created_at    timestamptz not null default now(),
    unique (project_id, url)
  );

  -- What waits for the operator in the console. A group (invite batch, follow-up group) is a parent row whose
  -- items are rows with parent_id set; the operator can drop single items before approving the group.
  create table proposals (
    id            serial primary key,
    project_id    int not null references projects(id),
    parent_id     int references proposals(id),
    kind          text not null,
    status        text not null default 'pending'
                  check (status in ('drafting', 'pending', 'approved', 'running', 'done', 'failed', 'unknown', 'rejected', 'dropped', 'superseded')),
    kol_id        int references kols(id),
    title         text,
    why           text,
    -- the mail, when this proposal sends one
    mailbox       text,
    to_addr       text,
    subject       text,
    body          text,
    in_reply_to   int references messages(id),
    -- what else to do: {"code": {"action": "create"|"extend"|"partner", …}, "after": {"stage": …, "close_reason": …}, …}
    action        jsonb not null default '{}',
    -- hash of what the card shows; approval is for exactly this version
    content_hash  text,
    approved_hash text,
    approved_at   timestamptz,
    feedback      text,
    result        text,
    legacy_id     text unique,
    legacy        jsonb,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    done_at       timestamptz
  );
  create unique index proposals_one_pending_mail on proposals (project_id, kol_id)
    where kol_id is not null and to_addr is not null and status in ('drafting', 'pending', 'approved', 'running', 'unknown');
  create index proposals_open on proposals (project_id, status);

  -- External actions, one at a time. 'started' rows left behind by a crash become 'unknown' and wait for the operator.
  create table actions (
    id           serial primary key,
    project_id   int not null references projects(id),
    proposal_id  int references proposals(id),
    kind         text not null check (kind in ('send', 'trial_create', 'trial_extend', 'partner_create')),
    status       text not null check (status in ('started', 'succeeded', 'failed', 'unknown')),
    mailbox      text,
    to_addr      text,
    request      jsonb,
    response     jsonb,
    error        text,
    started_at   timestamptz not null default now(),
    finished_at  timestamptz
  );
  create unique index actions_once on actions (proposal_id, kind) where proposal_id is not null and status <> 'failed';
  create index actions_sent_day on actions (project_id, started_at) where kind = 'send';

  -- Work the console hands to the local agent (claude -p / codex exec).
  create table agent_jobs (
    id           serial primary key,
    project_id   int not null references projects(id),
    kind         text not null,
    status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'stuck')),
    proposal_id  int references proposals(id),
    kol_id       int references kols(id),
    message_id   int references messages(id),
    input        jsonb not null default '{}',
    agent        text,
    session_id   text,
    output       text,
    error        text,
    created_at   timestamptz not null default now(),
    started_at   timestamptz,
    finished_at  timestamptz
  );
  create index agent_jobs_open on agent_jobs (status, created_at);

  -- What happened: sends, replies, operator edits, scheduled runs, old 操作日志 and 运行记录.
  create table log (
    id          serial primary key,
    project_id  int not null references projects(id),
    at          timestamptz not null default now(),
    kind        text not null,
    who         text not null default 'operator',
    kol_id      int references kols(id),
    proposal_id int references proposals(id),
    summary     text not null,
    detail      jsonb,
    legacy_id   text unique
  );
  create index log_project_at on log (project_id, at);

  -- Small per-project state: mail catch-up cursors, last run of scheduled jobs.
  create table state (
    project_id  int not null references projects(id),
    key         text not null,
    value       jsonb not null,
    updated_at  timestamptz not null default now(),
    primary key (project_id, key)
  );
  `,
];
