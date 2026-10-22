#!/usr/bin/env node

// src/kolops/cli.ts
import { parseArgs } from "node:util";

// src/kolops/config.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function pluginRoot() {
  if (process.env.KOL_PLUGIN_ROOT) return process.env.KOL_PLUGIN_ROOT;
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith("scripts") ? dirname(here) : join(here, "..", "..", "plugins", "kol-ops");
}
function loadConfig(root = pluginRoot()) {
  return JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
}
function mailboxFor(cfg, channel) {
  return cfg.mailboxes.find((m) => m.channel === channel || m.address === channel);
}

// src/kolops/base.ts
var Base = class {
  constructor(lark, token) {
    this.lark = lark;
    this.token = token;
  }
  records(table, opts) {
    return this.lark.records(table, opts);
  }
  async create(table, rows) {
    const ids = [];
    for (let i = 0; i < rows.length; i += 200) {
      const data = await this.lark.json([
        "base",
        "+record-batch-create",
        "--base-token",
        this.token,
        "--table-id",
        table,
        "--json",
        JSON.stringify({ create_records: rows.slice(i, i + 200) }),
        "--as",
        "user"
      ]);
      noIgnored(table, data);
      ids.push(...recordIds(data));
    }
    return ids;
  }
  async update(table, changes) {
    const entries = Object.entries(changes);
    for (let i = 0; i < entries.length; i += 200) {
      const data = await this.lark.json([
        "base",
        "+record-batch-update",
        "--base-token",
        this.token,
        "--table-id",
        table,
        "--json",
        JSON.stringify({ update_records: Object.fromEntries(entries.slice(i, i + 200)) }),
        "--as",
        "user"
      ]);
      noIgnored(table, data);
    }
  }
};
function noIgnored(table, data) {
  const ignored = data?.ignored_fields ?? [];
  if (ignored.length) throw new Error(`${table} \u6709\u5B57\u6BB5\u6CA1\u5199\u8FDB\u53BB\uFF1A${ignored.map((f) => `${f.name}\uFF08${f.reason}\uFF09`).join("\uFF1B")}`);
}
function recordIds(data) {
  const list = data?.record_id_list ?? data?.record_ids ?? data?.records?.map((r) => r.record_id) ?? [];
  return list.map(String);
}
function text(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => typeof x === "object" && x ? x.name ?? x.text ?? "" : String(x)).join(", ");
  return String(v).trim();
}
function option(v) {
  return Array.isArray(v) ? String(v[0] ?? "") : text(v);
}
function linkIds(v) {
  return Array.isArray(v) ? v.map((x) => String(x?.id ?? x)).filter(Boolean) : [];
}
function day(v, tz = "+08:00") {
  if (!v) return "";
  const t = typeof v === "number" ? v : Date.parse(String(v));
  if (Number.isNaN(t)) return String(v).slice(0, 10);
  return dayOf(t, tz);
}
function dayOf(ms, tz = "+08:00") {
  const sign = tz.startsWith("-") ? -1 : 1;
  const [h, m] = tz.slice(1).split(":").map(Number);
  return new Date(ms + sign * (h * 60 + (m || 0)) * 6e4).toISOString().slice(0, 10);
}
function emailsIn(v) {
  return (text(v).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((e) => e.toLowerCase());
}

// src/kolops/mail.ts
var MailBlocked = class extends Error {
};
var Mail = class {
  constructor(lark) {
    this.lark = lark;
  }
  async list(mailbox, filter, max = 400) {
    const data = await this.lark.json([
      "mail",
      "+triage",
      "--mailbox",
      mailbox,
      "--filter",
      JSON.stringify(filter),
      "--max",
      String(max),
      "--format",
      "json",
      "--as",
      "user"
    ]);
    return (data?.messages ?? []).filter((m) => m.message_id && !m.error);
  }
  /** The newest message this address sent to the mailbox, to reply in the same thread. */
  async latestFrom(mailbox, address) {
    const list = await this.list(mailbox, { from: [address] }, 5);
    return list.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
  }
  async send(o) {
    const args = o.replyTo ? ["mail", "+reply", "--message-id", o.replyTo] : ["mail", "+send", "--to", o.to, "--subject", o.subject];
    args.push("--mailbox", o.mailbox, "--body", o.body, "--confirm-send", "--as", "user");
    if (o.replyTo && o.subject) args.push("--subject", o.subject);
    const data = await this.lark.json(args);
    if (data?.automation_send_disable_reason) {
      throw new MailBlocked(`\u90AE\u7BB1\u8BBE\u7F6E\u62E6\u622A\u4E86\u81EA\u52A8\u53D1\u4FE1\uFF1A${data.automation_send_disable_reason} ${data.automation_send_disable_reference ?? ""}`.trim());
    }
    if (!data?.message_id) throw new Error(`\u53D1\u4FE1\u6CA1\u6709\u8FD4\u56DE message_id\uFF1A${JSON.stringify(data).slice(0, 300)}`);
    return { messageId: String(data.message_id), threadId: String(data.thread_id ?? "") };
  }
  /** Per-recipient delivery codes: 1 投递中, 2 重试, 3 退信, 4 成功, 5 待审批, 6 审批拒绝. */
  async status(mailbox, messageId) {
    const data = await this.lark.json([
      "mail",
      "user_mailbox.messages",
      "send_status",
      "--params",
      JSON.stringify({ user_mailbox_id: mailbox, message_id: messageId }),
      "--as",
      "user"
    ]);
    const codes = [];
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        if (typeof v.status === "number") codes.push(v.status);
        Object.values(v).forEach(walk);
      }
    };
    walk(data);
    return codes;
  }
};
var STATUS_NAMES = { 1: "\u6295\u9012\u4E2D", 2: "\u6295\u9012\u5931\u8D25\u91CD\u8BD5", 3: "\u9000\u4FE1", 4: "\u6295\u9012\u6210\u529F", 5: "\u5F85\u5BA1\u6279", 6: "\u5BA1\u6279\u62D2\u7EDD" };
function addressOf(from) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}
function toHtml(body) {
  if (/<(p|div|br|ul|ol|table)\b/i.test(body)) return body;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const links = (s) => s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return body.trim().split(/\n{2,}/).map((para) => `<p>${links(esc(para)).replace(/\n/g, "<br>")}</p>`).join("\n");
}
function splitDraft(draft) {
  const m = draft.match(/^\s*(?:主题|主旨|Subject)\s*[:：]\s*(.+)\n/i);
  return m ? { subject: m[1].trim(), body: draft.slice(m[0].length).trim() } : { subject: "", body: draft.trim() };
}

// src/kolops/ops.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
function dataDir() {
  const dir = process.env.KOL_DATA_DIR || join2(homedir(), ".kol-ops");
  mkdirSync(dir, { recursive: true });
  return dir;
}
function stamp(ms = Date.now(), tz = "+08:00") {
  const sign = tz.startsWith("-") ? -1 : 1;
  const [h, m] = tz.slice(1).split(":").map(Number);
  return new Date(ms + sign * (h * 60 + (m || 0)) * 6e4).toISOString().slice(0, 16).replace("T", " ");
}
function today(cfg, ms = Date.now()) {
  return dayOf(ms, cfg.timezone);
}
async function whoami(lark) {
  const data = await lark.json(["contact", "+get-user", "--as", "user", "--format", "json"]);
  const u = data?.user ?? data;
  return { id: String(u?.open_id ?? u?.user_id ?? ""), name: String(u?.name ?? u?.en_name ?? "") };
}
var Journal = class {
  file = join2(dataDir(), "sends.jsonl");
  entries = /* @__PURE__ */ new Map();
  constructor() {
    if (!existsSync(this.file)) return;
    for (const line of readFileSync2(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      this.entries.set(e.key, e);
    }
  }
  get(key) {
    return this.entries.get(key);
  }
  mark(key, state, messageId) {
    const e = { key, state, messageId, at: (/* @__PURE__ */ new Date()).toISOString() };
    this.entries.set(key, e);
    appendFileSync(this.file, JSON.stringify(e) + "\n");
  }
};
async function todaysSends(base, cfg) {
  const rows = await base.records(cfg.tables.contacts, {
    filter: { logic: "and", conditions: [["\u65B9\u5411", "intersects", ["\u53D1\u51FA"]], ["\u65E5\u671F", "==", `ExactDate(${today(cfg)})`]] },
    fields: ["\u6E20\u9053", "KOL", "\u65B9\u5411", "\u65E5\u671F"]
  });
  const counts = { byChannel: /* @__PURE__ */ new Map(), all: /* @__PURE__ */ new Set() };
  for (const r of rows) {
    const who = linkIds(r["KOL"])[0] ?? r.record_id;
    const ch = option(r["\u6E20\u9053"]);
    if (!counts.byChannel.has(ch)) counts.byChannel.set(ch, /* @__PURE__ */ new Set());
    counts.byChannel.get(ch).add(who);
    counts.all.add(who);
  }
  return counts;
}
async function paused(base, cfg) {
  const rows = await base.records(cfg.tables.control);
  return rows.some((r) => r["\u6682\u505C\u6240\u6709\u53D1\u9001"] === true);
}
var Run = class {
  constructor(base, cfg, title, me, scheduled) {
    this.base = base;
    this.cfg = cfg;
    this.title = title;
    this.me = me;
    this.scheduled = scheduled;
  }
  id = "";
  counts = { \u5904\u7406\u6765\u4FE1: 0, \u53D1\u51FA\u90AE\u4EF6: 0, \u65B0\u589E\u5F85\u5BA1: 0 };
  notes = [];
  ops = [];
  async start() {
    [this.id] = await this.base.create(this.cfg.tables.runs, [{
      \u8FD0\u884C: `${this.title}\uFF08${this.me.name || "\u672A\u77E5"}\uFF09`,
      \u65B9\u5F0F: [this.scheduled ? "\u5B9A\u65F6\u4EFB\u52A1" : "\u5BF9\u8BDD\u4E2D\u624B\u52A8"],
      \u7ED3\u679C: ["\u8FDB\u884C\u4E2D"],
      \u5F00\u59CB\u65F6\u95F4: stamp(Date.now(), this.cfg.timezone)
    }]);
  }
  op(o) {
    this.ops.push({
      \u7C7B\u578B: [o.type],
      \u7ED3\u679C: [o.result],
      \u64CD\u4F5C: o.action,
      \u8BF4\u660E: `${o.detail ?? ""}${o.detail ? "\n" : ""}\u6267\u884C\u4EBA\uFF1A${this.me.name || this.me.id}`,
      ...o.recipients ? { \u6536\u4EF6\u4EBA\u660E\u7EC6: o.recipients } : {},
      ...o.body ? { \u90AE\u4EF6\u6B63\u6587: o.body.slice(0, 5e3) } : {},
      ...o.sent != null ? { \u53D1\u9001\u6570: o.sent } : {},
      \u65F6\u95F4: stamp(Date.now(), this.cfg.timezone),
      ...o.followup ? { KOL: [{ id: o.followup }] } : {},
      ...this.id ? { \u6240\u5C5E\u8FD0\u884C: [{ id: this.id }] } : {}
    });
  }
  /** Writes queued 操作日志 rows; called after each batch so a crash loses little. */
  async flush() {
    if (!this.ops.length) return;
    const batch = this.ops.splice(0);
    await this.base.create(this.cfg.tables.oplog, batch);
  }
  async finish(result) {
    await this.flush();
    if (!this.id) return;
    await this.base.update(this.cfg.tables.runs, {
      [this.id]: {
        \u7ED3\u679C: [result],
        \u7ED3\u675F\u65F6\u95F4: stamp(Date.now(), this.cfg.timezone),
        \u5904\u7406\u6765\u4FE1: this.counts.\u5904\u7406\u6765\u4FE1,
        \u53D1\u51FA\u90AE\u4EF6: this.counts.\u53D1\u51FA\u90AE\u4EF6,
        \u65B0\u589E\u5F85\u5BA1: this.counts.\u65B0\u589E\u5F85\u5BA1,
        ...this.notes.length ? { \u95EE\u9898\u4E0E\u5907\u6CE8: this.notes.join("\n").slice(0, 5e3) } : {}
      }
    });
  }
};

// src/kolops/ctx.ts
function makeCtx(cfg, lark, me, title, scheduled, sleep) {
  const base = new Base(lark, cfg.baseToken);
  return {
    cfg,
    base,
    me,
    mail: new Mail(lark),
    journal: new Journal(),
    run: new Run(base, cfg, title, me, scheduled),
    sleep: sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  };
}

// src/kolops/lark.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var exec = promisify(execFile);
var LarkError = class extends Error {
  /** True when lark-cli answered with an API error: the call was refused, so nothing happened. */
  constructor(message, definite = false) {
    super(message);
    this.definite = definite;
  }
};
var LarkCli = class {
  constructor(baseToken, bin = process.env.KOL_LARK_CLI || "lark-cli") {
    this.baseToken = baseToken;
    this.bin = bin;
  }
  async json(args) {
    const out = await this.raw(args);
    return unwrap(out, args);
  }
  async records(table, opts = {}) {
    const rows = [];
    for (let offset = 0; ; offset += 200) {
      const args = [
        "base",
        "+record-list",
        "--base-token",
        this.baseToken,
        "--table-id",
        table,
        "--format",
        "json",
        "--limit",
        "200",
        "--offset",
        String(offset),
        "--as",
        "user"
      ];
      if (opts.filter) args.push("--filter-json", JSON.stringify(opts.filter));
      for (const f of opts.fields ?? []) args.push("--field-id", f);
      const page = await this.json(args);
      rows.push(...matrixRows(page));
      if (!page?.has_more) break;
    }
    return rows;
  }
  async raw(args, cwd) {
    try {
      const { stdout } = await exec(this.bin, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      const detail = (err.stdout || err.stderr || err.message || "").toString().trim();
      let refused = false;
      try {
        refused = JSON.parse(err.stdout).ok === false;
      } catch {
      }
      throw new LarkError(`lark-cli ${args.slice(0, 2).join(" ")} \u5931\u8D25\uFF1A${detail.slice(0, 800)}`, refused);
    }
  }
};
function matrixRows(page) {
  const fields = page?.fields ?? [];
  const ids = page?.record_id_list ?? [];
  return (page?.data ?? []).map((cells, i) => {
    const row = { record_id: ids[i] };
    fields.forEach((f, j) => row[f] = cells[j] ?? null);
    return row;
  });
}
function unwrap(stdout, args = []) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new LarkError(`lark-cli ${args.slice(0, 2).join(" ")} \u6CA1\u6709\u8FD4\u56DE JSON\uFF1A${stdout.slice(0, 300)}`);
  }
  if (parsed && typeof parsed === "object" && "ok" in parsed) {
    if (!parsed.ok) throw new LarkError(`lark-cli ${args.slice(0, 2).join(" ")} \u5931\u8D25\uFF1A${JSON.stringify(parsed.error ?? parsed).slice(0, 800)}`, true);
    return parsed.data ?? {};
  }
  return parsed;
}

// src/kolops/data.ts
var PROFILE_FIELDS = [
  "\u8D26\u53F7",
  "\u8D26\u53F7\u540D\u79F0",
  "\u79F0\u547C",
  "\u4E3B\u9875\u94FE\u63A5",
  "\u516C\u5F00\u90AE\u7BB1",
  "\u5176\u4ED6\u90AE\u7BB1",
  "\u8054\u7CFB\u8BB8\u53EF",
  "\u8054\u7CFB\u8BB8\u53EF\u539F\u56E0",
  "\u7C89\u4E1D\u6570",
  "\u4E3B\u8981\u5E73\u53F0",
  "\u5185\u5BB9\u7C7B\u578B",
  "\u5E02\u573A",
  "\u5165\u5E93\u6279\u6B21",
  "\u8DDF\u8FDB\u8BB0\u5F55"
];
var FOLLOWUP_FIELDS = [
  "\u8D26\u53F7\u540D\u79F0",
  "\u6863\u6848",
  "\u9636\u6BB5",
  "\u5F53\u524D\u8F6E\u5230\u8C01",
  "\u7EA7\u522B",
  "\u5BF9\u65B9\u8981\u6C42",
  "\u8054\u7CFB\u6E20\u9053",
  "\u9080\u7EA6\u6279\u6B21",
  "\u9996\u6B21\u9080\u7EA6\u65E5\u671F",
  "\u4E0B\u6B21\u8DDF\u8FDB\u65E5\u671F",
  "\u6700\u8FD1\u8054\u7CFB\u65E5\u671F",
  "\u6700\u540E\u6765\u4FE1\u65E5\u671F",
  "\u4E0B\u4E00\u6B65",
  "\u7ED3\u6848\u539F\u56E0"
];
async function loadSnapshot(base, cfg) {
  const t = cfg.tables;
  const [profiles, followups] = await Promise.all([
    base.records(t.profiles, { fields: PROFILE_FIELDS }),
    base.records(t.followups, { fields: FOLLOWUP_FIELDS })
  ]);
  return buildSnapshot(profiles, followups);
}
function buildSnapshot(profiles, followups) {
  const s = {
    profiles: new Map(profiles.map((r) => [r.record_id, r])),
    followups: new Map(followups.map((r) => [r.record_id, r])),
    doNotContact: /* @__PURE__ */ new Set(),
    followupsByEmail: /* @__PURE__ */ new Map()
  };
  for (const p of profiles) {
    if (option(p["\u8054\u7CFB\u8BB8\u53EF"]) === "\u6C38\u4E0D\u8054\u7CFB") for (const e of profileEmails(p)) s.doNotContact.add(e);
  }
  for (const f of followups) {
    for (const e of followupEmails(s, f)) {
      const list = s.followupsByEmail.get(e) ?? [];
      list.push(f.record_id);
      s.followupsByEmail.set(e, list);
    }
  }
  return s;
}
function profileEmails(p) {
  if (!p) return [];
  return [.../* @__PURE__ */ new Set([...emailsIn(p["\u516C\u5F00\u90AE\u7BB1"]), ...emailsIn(p["\u5176\u4ED6\u90AE\u7BB1"])])];
}
function profileOf(s, f) {
  return f ? s.profiles.get(linkIds(f["\u6863\u6848"])[0] ?? "") : void 0;
}
function followupEmails(s, f) {
  return profileEmails(profileOf(s, f));
}
function blockedReason(s, f, recipient) {
  const p = profileOf(s, f);
  if (!p) return "\u8DDF\u8FDB\u8BB0\u5F55\u6CA1\u6709\u5173\u8054\u6863\u6848";
  if (option(p["\u8054\u7CFB\u8BB8\u53EF"]) === "\u6C38\u4E0D\u8054\u7CFB") return `\u6C38\u4E0D\u8054\u7CFB\uFF08${text(p["\u8054\u7CFB\u8BB8\u53EF\u539F\u56E0"]) || "\u672A\u5199\u539F\u56E0"}\uFF09`;
  if (s.doNotContact.has(recipient.toLowerCase())) return "\u8FD9\u4E2A\u90AE\u7BB1\u5C5E\u4E8E\u4E00\u4F4D\u6C38\u4E0D\u8054\u7CFB\u7684 KOL";
  return "";
}
function displayName(s, f) {
  const p = profileOf(s, f);
  return text(f["\u8D26\u53F7\u540D\u79F0"]) || text(p?.["\u8D26\u53F7\u540D\u79F0"]) || text(p?.["\u8D26\u53F7"]) || f.record_id;
}

// src/kolops/send.ts
var SENDING_TYPES = ["\u56DE\u590D\u90AE\u4EF6", "\u534F\u8BAE"];
function isApproved(r) {
  const p = option(r["\u5904\u7406"]);
  const res = option(r["\u5BA1\u6838\u7ED3\u679C"]);
  const yes = p === "\u53D1\uFF0F\u540C\u610F" || res === "\u786E\u8BA4\u53D1\u9001" || res === "\u540C\u610F";
  const no = ["\u6539", "\u4E0D\u53D1"].includes(p) || ["\u9000\u56DE\u4FEE\u6539", "\u5148\u4E0D\u53D1", "\u4E0D\u540C\u610F"].includes(res);
  return yes && !no && r["\u786E\u8BA4\u53D1\u51FA"] === true;
}
function checkOne(o, s, counts, knownSenders) {
  const f = s.followups.get(o.followupId);
  if (!f) return "\u627E\u4E0D\u5230\u5BF9\u5E94\u7684\u8DDF\u8FDB\u8BB0\u5F55";
  if (!o.recipient) return "\u6CA1\u6709\u6536\u4EF6\u4EBA\u90AE\u7BB1";
  const blocked = blockedReason(s, f, o.recipient);
  if (blocked) return blocked;
  const known = followupEmails(s, f);
  if (!known.includes(o.recipient) && !knownSenders.has(o.recipient)) return `\u6536\u4EF6\u4EBA ${o.recipient} \u4E0D\u662F\u8FD9\u4F4D KOL \u6863\u6848\u91CC\u7684\u90AE\u7BB1\uFF0C\u4E5F\u6CA1\u6709\u7ED9\u6211\u4EEC\u6765\u8FC7\u4FE1`;
  if (!o.body.trim()) return "\u90AE\u4EF6\u6B63\u6587\u662F\u7A7A\u7684";
  if (!o.replyTo && !o.subject) return "\u662F\u4E00\u5C01\u65B0\u90AE\u4EF6\uFF0C\u4F46\u6CA1\u6709\u4E3B\u9898\uFF08\u8349\u7A3F\u7B2C\u4E00\u884C\u5199\u300C\u4E3B\u9898\uFF1A\u2026\u300D\uFF09";
  const sentToday = counts.all.has(o.followupId);
  if (o.oncePerDay && sentToday) return "\u4ECA\u5929\u5DF2\u7ECF\u7ED9\u8FD9\u4F4D KOL \u53D1\u8FC7\u4FE1";
  const ch = counts.byChannel.get(o.mailbox.channel)?.size ?? 0;
  if (!sentToday && ch >= o.mailbox.dailyExternal) return `${o.mailbox.address} \u4ECA\u5929\u7684\u989D\u5EA6\uFF08${o.mailbox.dailyExternal} \u4EBA\uFF09\u5DF2\u7528\u5B8C`;
  return "";
}
function companyFull(ctx, counts, followupId) {
  return !counts.all.has(followupId) && counts.all.size >= ctx.cfg.companyDailyExternal;
}
async function deliver(ctx, items, s, dryRun) {
  const report = { sent: [], skipped: [], failed: [], dryRun };
  if (await paused(ctx.base, ctx.cfg)) {
    report.skipped.push(...items.map((o) => ({ key: o.key, name: o.name, reason: "\u63A7\u5236\u8868\u7684\u300C\u6682\u505C\u6240\u6709\u53D1\u9001\u300D\u5F00\u7740" })));
    return report;
  }
  const counts = await todaysSends(ctx.base, ctx.cfg);
  const gap = Math.ceil(6e4 / Math.max(1, ctx.cfg.perMinute));
  const t = ctx.cfg.tables;
  for (const o of items) {
    const prior = ctx.journal.get(o.key);
    if (prior?.state === "recorded" || prior?.state === "sent") {
      report.skipped.push({ key: o.key, name: o.name, reason: `\u8FD9\u5C01\u4FE1\u5DF2\u7ECF\u53D1\u8FC7\uFF08${prior.messageId ?? ""}\uFF09` });
      continue;
    }
    if (prior?.state === "sending") {
      report.failed.push({ key: o.key, name: o.name, reason: "\u4E0A\u6B21\u53D1\u9001\u4E2D\u65AD\uFF0C\u7ED3\u679C\u4E0D\u660E\u3002\u8BF7\u5230\u90AE\u7BB1\u7684\u300C\u5DF2\u53D1\u9001\u300D\u91CC\u786E\u8BA4\u540E\u518D\u5904\u7406" });
      if (!dryRun) {
        ctx.journal.mark(o.key, "failed");
        await markFailed(ctx, o, "\u4E0A\u6B21\u53D1\u9001\u4E2D\u65AD\uFF0C\u7ED3\u679C\u4E0D\u660E\uFF0C\u8BF7\u5230\u90AE\u7BB1\u300C\u5DF2\u53D1\u9001\u300D\u786E\u8BA4");
      }
      continue;
    }
    const senders = /* @__PURE__ */ new Set();
    if (!o.replyTo) {
      const latest = await ctx.mail.latestFrom(o.mailbox.address, o.recipient).catch(() => void 0);
      if (latest) {
        o.replyTo = latest.message_id;
        senders.add(o.recipient);
      }
    } else senders.add(o.recipient);
    let reason = checkOne(o, s, counts, senders);
    if (!reason && companyFull(ctx, counts, o.followupId)) reason = `\u5168\u516C\u53F8\u4ECA\u5929\u7684\u5916\u90E8\u6536\u4EF6\u4EBA\u989D\u5EA6\uFF08${ctx.cfg.companyDailyExternal} \u4EBA\uFF09\u5DF2\u7528\u5B8C`;
    if (reason) {
      report.skipped.push({ key: o.key, name: o.name, reason });
      continue;
    }
    if (dryRun) {
      report.sent.push({ name: o.name, recipient: o.recipient, mailbox: o.mailbox.address, kind: o.kind, messageId: "\uFF08\u8BD5\u8DD1\uFF0C\u6CA1\u6709\u53D1\u51FA\uFF09" });
      continue;
    }
    ctx.journal.mark(o.key, "sending");
    let sent;
    try {
      sent = await ctx.mail.send({ mailbox: o.mailbox.address, to: o.recipient, subject: o.subject, body: toHtml(o.body), replyTo: o.replyTo });
    } catch (err) {
      const definite = err instanceof MailBlocked || err instanceof LarkError && err.definite;
      ctx.journal.mark(o.key, definite ? "failed" : "sending");
      const why = definite ? String(err.message) : `\u53D1\u9001\u7ED3\u679C\u4E0D\u660E\uFF1A${err.message}\u3002\u8BF7\u5230\u90AE\u7BB1\u300C\u5DF2\u53D1\u9001\u300D\u786E\u8BA4\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u91CD\u53D1`;
      report.failed.push({ key: o.key, name: o.name, reason: why });
      await markFailed(ctx, o, why);
      ctx.run.op({ type: "\u53D1\u51FA\u90AE\u4EF6", result: "\u5931\u8D25", action: `${o.kind}\uFF1A${o.name}`, detail: why, followup: o.followupId, recipients: o.recipient });
      continue;
    }
    ctx.journal.mark(o.key, "sent", sent.messageId);
    counts.all.add(o.followupId);
    if (!counts.byChannel.has(o.mailbox.channel)) counts.byChannel.set(o.mailbox.channel, /* @__PURE__ */ new Set());
    counts.byChannel.get(o.mailbox.channel).add(o.followupId);
    const now = stamp(Date.now(), ctx.cfg.timezone);
    await ctx.base.create(t.contacts, [{
      \u65B9\u5411: ["\u53D1\u51FA"],
      \u6E20\u9053: [o.mailbox.channel],
      "Message ID": sent.messageId,
      \u6458\u8981: `[${o.kind}] ${o.subject || "\u56DE\u590D"}`.slice(0, 200),
      \u5185\u5BB9: o.body.slice(0, 5e3),
      \u65E5\u671F: now,
      KOL: [{ id: o.followupId }]
    }]);
    await ctx.base.update(t.followups, {
      [o.followupId]: { \u6700\u8FD1\u8054\u7CFB\u65E5\u671F: now, \u5F53\u524D\u8F6E\u5230\u8C01: ["KOL"], ...o.after?.followup ?? {} }
    });
    if (o.after?.review) {
      await ctx.base.update(t.reviews, {
        [o.after.review]: { \u72B6\u6001: ["\u5DF2\u6267\u884C"], \u6267\u884C\u65F6\u95F4: now, \u6267\u884C\u7ED3\u679C: `\u5DF2\u4ECE ${o.mailbox.address} \u53D1\u7ED9 ${o.recipient}\uFF08${sent.messageId}\uFF09` }
      });
    }
    ctx.journal.mark(o.key, "recorded", sent.messageId);
    ctx.run.counts.\u53D1\u51FA\u90AE\u4EF6++;
    ctx.run.op({ type: "\u53D1\u51FA\u90AE\u4EF6", result: "\u5B8C\u6210", action: `${o.kind}\uFF1A${o.name}`, followup: o.followupId, recipients: o.recipient, body: o.body, sent: 1 });
    report.sent.push({ name: o.name, recipient: o.recipient, mailbox: o.mailbox.address, kind: o.kind, messageId: sent.messageId });
    if (report.sent.length % 20 === 0) await ctx.run.flush();
    await ctx.sleep(gap);
  }
  if (!dryRun && report.sent.length) {
    await ctx.sleep(5e3);
    for (const r of report.sent) {
      const codes = await ctx.mail.status(r.mailbox, r.messageId).catch(() => []);
      r.delivery = codes.length ? [...new Set(codes)].map((c) => STATUS_NAMES[c] ?? String(c)).join("\u3001") : "\u672A\u67E5\u5230";
    }
  }
  return report;
  async function markFailed(ctx2, o, why) {
    if (o.after?.review) {
      await ctx2.base.update(t.reviews, { [o.after.review]: { \u72B6\u6001: ["\u6267\u884C\u5931\u8D25"], \u6267\u884C\u7ED3\u679C: why.slice(0, 2e3), \u6267\u884C\u65F6\u95F4: stamp(Date.now(), ctx2.cfg.timezone) } });
    }
  }
}
async function sendApproved(ctx, opts) {
  const t = ctx.cfg.tables;
  const [s, reviews] = await Promise.all([
    loadSnapshot(ctx.base, ctx.cfg),
    ctx.base.records(t.reviews, { filter: { logic: "and", conditions: [["\u72B6\u6001", "intersects", ["\u5F85\u4F60\u5BA1\u6838", "\u5F85\u6267\u884C"]]] } })
  ]);
  const chosen = reviews.filter((r) => isApproved(r) && (!opts.only?.length || opts.only.includes(r.record_id)));
  const items = [];
  const skipped = [];
  let notEmail = 0;
  for (const r of chosen) {
    const type = option(r["\u7C7B\u578B"]);
    const channel = option(r["\u53D1\u9001\u6E20\u9053"]);
    if (!SENDING_TYPES.includes(type) || channel === "\u4E0D\u53D1\u90AE\u4EF6") {
      notEmail++;
      continue;
    }
    const followupId = linkIds(r["KOL"])[0] ?? "";
    const f = s.followups.get(followupId);
    const name = f ? displayName(s, f) : text(r["\u5BA1\u6838\u9879"]);
    const mailbox = mailboxFor(ctx.cfg, channel || option(f?.["\u8054\u7CFB\u6E20\u9053"]));
    if (!mailbox) {
      skipped.push({ key: r.record_id, name, reason: `\u53D1\u9001\u6E20\u9053\u300C${channel || "\u672A\u586B"}\u300D\u4E0D\u662F\u63D2\u4EF6\u80FD\u53D1\u7684\u98DE\u4E66\u90AE\u7BB1` });
      continue;
    }
    const { subject, body } = splitDraft(text(r["\u90AE\u4EF6\u8349\u7A3F"]));
    items.push({
      key: `review:${r.record_id}`,
      followupId,
      name,
      recipient: emailsIn(r["\u6536\u4EF6\u4EBA"])[0] ?? "",
      mailbox,
      subject,
      body,
      oncePerDay: false,
      kind: "\u56DE\u590D",
      after: { review: r.record_id }
    });
  }
  const report = await deliver(ctx, items, s, opts.dryRun);
  report.skipped.unshift(...skipped);
  return { ...report, notEmail };
}

// src/kolops/sync.ts
var BOUNCE_SENDER = /mailer-daemon|postmaster|mail-noreply.*bounce|delivery-?status/i;
async function syncInbox(ctx, opts) {
  const t = ctx.cfg.tables;
  const since = Date.now() - opts.days * 864e5;
  const sinceIso = new Date(since).toISOString().replace("Z", "+00:00");
  const s = await loadSnapshot(ctx.base, ctx.cfg);
  const known = await ctx.base.records(t.contacts, {
    filter: { logic: "and", conditions: [["\u65E5\u671F", ">=", `ExactDate(${day(since - 864e5, ctx.cfg.timezone)})`]] },
    fields: ["Message ID"]
  });
  const seen = new Set(known.map((r) => text(r["Message ID"])).filter(Boolean));
  const report = { mailboxes: [], newReplies: [], bounces: [], unknownSenders: 0, alreadySynced: 0 };
  const contacts = [];
  const followupChanges = {};
  for (const mb of ctx.cfg.mailboxes) {
    const mails = await ctx.mail.list(mb.address, { folder: "INBOX", time_range: { start_time: sinceIso } });
    report.mailboxes.push(`${mb.address}\uFF1A${mails.length} \u5C01`);
    for (const m of mails) {
      if (seen.has(m.message_id)) {
        report.alreadySynced++;
        continue;
      }
      seen.add(m.message_id);
      const from = addressOf(m.from);
      const when = Number.isNaN(Date.parse(m.date)) ? Date.now() : Date.parse(m.date);
      if (BOUNCE_SENDER.test(from)) {
        await handleBounce(ctx, s, mb.address, m, when, report, followupChanges);
        continue;
      }
      const fids = s.followupsByEmail.get(from);
      if (!fids?.length) {
        report.unknownSenders++;
        continue;
      }
      const fid = pickFollowup(s, fids);
      const f = s.followups.get(fid);
      contacts.push({
        \u65B9\u5411: ["\u6536\u5230"],
        \u6E20\u9053: [mb.channel],
        "Message ID": m.message_id,
        \u6458\u8981: m.subject.slice(0, 200),
        \u65E5\u671F: stamp(when, ctx.cfg.timezone),
        \u5F85\u5904\u7406: true,
        KOL: [{ id: fid }]
      });
      const stage = option(f["\u9636\u6BB5"]);
      followupChanges[fid] = {
        ...followupChanges[fid],
        \u6700\u540E\u6765\u4FE1\u65E5\u671F: stamp(when, ctx.cfg.timezone),
        \u5F53\u524D\u8F6E\u5230\u8C01: ["\u6211\u4EEC"],
        ...stage === "\u5DF2\u9080\u7EA6" ? { \u9636\u6BB5: ["\u5DF2\u56DE\u590D"] } : {}
      };
      report.newReplies.push({ name: displayName(s, f), from, subject: m.subject, date: m.date });
    }
  }
  ctx.run.counts.\u5904\u7406\u6765\u4FE1 = report.newReplies.length;
  if (!opts.dryRun) {
    if (contacts.length) await ctx.base.create(t.contacts, contacts);
    if (Object.keys(followupChanges).length) await ctx.base.update(t.followups, followupChanges);
    for (const r of report.newReplies) ctx.run.op({ type: "\u6765\u4FE1\u5904\u7406", result: "\u5B8C\u6210", action: `\u6536\u5230\u6765\u4FE1\uFF1A${r.name}`, detail: r.subject });
    for (const b of report.bounces) ctx.run.op({ type: "\u6765\u4FE1\u5904\u7406", result: "\u9000\u4FE1", action: `\u9000\u4FE1\u7ED3\u6848\uFF1A${b.name}`, detail: b.address });
  }
  return report;
}
function pickFollowup(s, ids) {
  return ids.find((id) => !["\u7ED3\u6848"].includes(option(s.followups.get(id)?.["\u9636\u6BB5"]))) ?? ids[0];
}
async function handleBounce(ctx, s, mailbox, m, when, report, changes) {
  const data = await ctx.base.lark.json([
    "mail",
    "+messages",
    "--mailbox",
    mailbox,
    "--message-ids",
    m.message_id,
    "--html=false",
    "--as",
    "user"
  ]).catch(() => null);
  const body = JSON.stringify(data ?? "");
  for (const addr of new Set(emailsIn(body))) {
    if (addr === mailbox || BOUNCE_SENDER.test(addr)) continue;
    for (const fid of s.followupsByEmail.get(addr) ?? []) {
      const f = s.followups.get(fid);
      if (option(f["\u9636\u6BB5"]) === "\u7ED3\u6848") continue;
      changes[fid] = {
        ...changes[fid],
        \u9636\u6BB5: ["\u7ED3\u6848"],
        \u7ED3\u6848\u539F\u56E0: ["\u9000\u4FE1\u6216\u90AE\u7BB1\u65E0\u6548"],
        \u5F53\u524D\u8F6E\u5230\u8C01: ["\u65E0\u9700\u52A8\u4F5C"],
        \u4E0B\u4E00\u6B65: `${stamp(when, ctx.cfg.timezone).slice(0, 10)} \u53D1\u5F80 ${addr} \u7684\u4FE1\u88AB\u9000\u56DE`
      };
      report.bounces.push({ name: displayName(s, f), address: addr });
    }
  }
}

// src/kolops/cli.ts
var HELP = `kol <\u547D\u4EE4> [\u9009\u9879]

  sync    [--days 3]          \u628A\u5404\u90AE\u7BB1\u6700\u8FD1\u51E0\u5929\u7684\u6765\u4FE1\u540C\u6B65\u8FDB\u63A5\u89E6\u8BB0\u5F55\uFF0C\u5E76\u628A\u6765\u4FE1\u7684 KOL \u6539\u6210\u300C\u8F6E\u5230\u6211\u4EEC\u300D
  send    [--only rec1,rec2]  \u53D1\u51FA\u5BA1\u6838\u961F\u5217\u91CC\u5DF2\u6279\u51C6\u3001\u8FD8\u6CA1\u53D1\u7684\u4FE1\uFF08\u6BCF\u5C01\u90FD\u5148\u68C0\u67E5\u6C38\u4E0D\u8054\u7CFB\u3001\u989D\u5EA6\u3001\u6682\u505C\u5F00\u5173\uFF09
  whoami                      \u770B\u5F53\u524D\u767B\u5F55\u7684\u98DE\u4E66\u8D26\u53F7

\u901A\u7528\u9009\u9879\uFF1A
  --dry-run     \u53EA\u68C0\u67E5\u3001\u5217\u51FA\u4F1A\u505A\u4EC0\u4E48\uFF0C\u4E0D\u53D1\u4FE1\u4E5F\u4E0D\u6539\u8868
  --scheduled   \u7531\u5B9A\u65F6\u4EFB\u52A1\u8C03\u7528\uFF08\u5199\u8FDB\u8FD0\u884C\u8BB0\u5F55\u7684\u300C\u65B9\u5F0F\u300D\uFF09

\u7ED3\u679C\u4EE5 JSON \u6253\u5370\u5230\u6807\u51C6\u8F93\u51FA\u3002`;
var COMMANDS = {
  sync: { title: "\u6536\u4FE1\u540C\u6B65", writes: true, run: (ctx, v) => syncInbox(ctx, { days: Number(v.days ?? 3), dryRun: !!v["dry-run"] }) },
  send: {
    title: "\u53D1\u51FA\u5DF2\u6279\u51C6\u7684\u4FE1",
    writes: true,
    run: (ctx, v) => sendApproved(ctx, { dryRun: !!v["dry-run"], only: v.only ? String(v.only).split(",") : void 0 })
  },
  whoami: { title: "", writes: false, run: async (ctx) => ctx.me }
};
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      scheduled: { type: "boolean" },
      days: { type: "string" },
      only: { type: "string" },
      help: { type: "boolean", short: "h" }
    }
  });
  const name = positionals[0];
  const cmd = name ? COMMANDS[name] : void 0;
  if (!cmd || values.help) {
    console.log(HELP);
    return cmd || values.help ? 0 : 1;
  }
  const cfg = loadConfig();
  const lark = new LarkCli(cfg.baseToken);
  const me = await whoami(lark);
  const ctx = makeCtx(cfg, lark, me, cmd.title, !!values.scheduled);
  const logged = cmd.writes && !values["dry-run"];
  if (logged) await ctx.run.start();
  try {
    const result = await cmd.run(ctx, values);
    if (logged) await ctx.run.finish(hasFailures(result) ? "\u90E8\u5206\u5B8C\u6210" : "\u5B8C\u6210");
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    if (logged) {
      ctx.run.notes.push(String(err?.message ?? err));
      await ctx.run.finish("\u5931\u8D25").catch(() => {
      });
    }
    console.error(`\u51FA\u9519\uFF1A${err?.message ?? err}`);
    return 2;
  }
}
function hasFailures(result) {
  return Array.isArray(result?.failed) && result.failed.length > 0;
}
main().then((code) => process.exit(code));
