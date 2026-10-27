/**
 * One local process on 127.0.0.1: the MCP server (/mcp) the agents use, the console page and its API (/api), the
 * mail watchers and the scheduled jobs. Scheduled jobs run only while it is open; on opening, anything whose time
 * passed while it was closed runs first.
 */
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { continueJob, runJobs } from "./agent.js";
import { saveConfig } from "./config.js";
import { dayOf, project, type Ctx, type Project } from "./ctx.js";
import { one } from "./db/db.js";
import { findPeople } from "./discover.js";
import { recoverAfterCrash, resolveUnknown, runApproved } from "./execute.js";
import { GUIDE } from "./guide.js";
import { catchUp, recordOne, Watcher } from "./inbox.js";
import { scanFollowups, scanForAgent } from "./outreach.js";
import { findPosts, postMetrics, syncCodes } from "./posts.js";
import { approve, editProposal, groupHash, proposeMail, reject, requestRevision, Stale, undo } from "./proposals.js";
import { draftTemplate } from "./templates.js";
import { callTool, kolDetail, TOOLS } from "./tools.js";
import PAGE from "./console.html";

export interface Status {
  startedAt: string;
  watchers: Record<string, { up: boolean; error: string }>;
  lastCatchUp: string;
  tasks: Record<string, { at: string; ok: boolean; note: string }>;
  busy: string;
}

function mcpServer(ctx: Ctx, who: string, projectName?: string): McpServer {
  const s = new McpServer({ name: "kolpick", version: "1.0.0" }, { instructions: GUIDE });
  for (const t of TOOLS) {
    s.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (args: any) => {
      try {
        const res = await callTool(ctx, t.name, args, who, projectName);
        return { content: [{ type: "text" as const, text: typeof res === "string" ? res : JSON.stringify(res, null, 1) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: "text" as const, text: String(err?.message ?? err) }] };
      }
    });
  }
  return s;
}

async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

/** Daily jobs: name → what runs. */
const DAILY: Record<string, (ctx: Ctx, p: Project) => Promise<unknown>> = {
  followups: (ctx, p) => scanFollowups(ctx, p),
  codes: (ctx, p) => syncCodes(ctx, p),
  expiry: (ctx, p) => scanForAgent(ctx, p),
  posts: (ctx, p) => findPosts(ctx, p),
  metrics: (ctx, p) => postMetrics(ctx, p),
};
export const DAILY_NAMES: Record<string, string> = { followups: "催信扫描", codes: "同步码用量", expiry: "码到期和约好没发", posts: "找帖子", metrics: "抓帖子数据" };

export class App {
  status: Status = { startedAt: new Date().toISOString(), watchers: {}, lastCatchUp: "", tasks: {}, busy: "" };
  private watchers: Watcher[] = [];
  private timers: NodeJS.Timeout[] = [];
  private server?: http.Server;
  private agentRunning = false;
  private execRunning = false;

  constructor(public ctx: Ctx) {}

  get mcpUrl(): string {
    return `http://127.0.0.1:${this.ctx.cfg.port}/mcp`;
  }

  async start(): Promise<void> {
    const recovered = await recoverAfterCrash(this.ctx);
    if (recovered) console.log(`上次中断时有 ${recovered} 个外部动作结果不明，已放进决策台等你确认`);
    await this.ctx.db.query("update agent_jobs set status='queued', started_at=null where status='running'");
    this.server = http.createServer((req, res) => this.handle(req, res).catch((err) => send(res, 500, { error: String(err?.message ?? err) })));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.ctx.cfg.port, "127.0.0.1", () => resolve());
    });
    this.timers.push(setInterval(() => this.tick().catch(() => {}), 60_000));
    void this.boot();
  }

  /** On opening: catch up mail, then any daily job whose day has passed, then start watching. */
  private async boot(): Promise<void> {
    const p = await project(this.ctx);
    if (this.ctx.cfg.auto.inbox) {
      await this.catchUpNow(p);
      await this.startWatchers(p);
    }
    if (this.ctx.cfg.auto.schedule) await this.runDaily(p);
    await this.tick();
  }

  async stop(): Promise<void> {
    this.watchers.forEach((w) => w.stop());
    this.timers.forEach((t) => clearInterval(t));
    await new Promise((r) => this.server?.close(r));
  }

  private async startWatchers(p: Project): Promise<void> {
    const boxes = await this.ctx.db.query<{ address: string }>("select address from mailboxes where project_id = $1", [p.id]);
    for (const b of boxes) {
      const w = new Watcher(this.ctx, p, b.address, async (id) => {
        await recordOne(this.ctx, p, b.address, id);
        void this.kickAgent(p);
      });
      w.start();
      this.watchers.push(w);
      this.status.watchers[b.address] = { up: false, error: "" };
    }
  }

  private async catchUpNow(p: Project): Promise<unknown> {
    try {
      const r = await catchUp(this.ctx, p);
      this.status.lastCatchUp = new Date().toISOString();
      void this.kickAgent(p);
      return r;
    } catch (err: any) {
      this.status.tasks.inbox = { at: new Date().toISOString(), ok: false, note: String(err?.message ?? err) };
      throw err;
    }
  }

  /** Every minute: send what is approved, let the agent work the queue, catch up mail if a watcher is down. */
  private async tick(): Promise<void> {
    const p = await project(this.ctx);
    for (const w of this.watchers) this.status.watchers[w.mailbox] = { up: w.up, error: w.lastError };
    void this.kickExec(p);
    void this.kickAgent(p);
    if (this.ctx.cfg.auto.inbox) {
      const down = this.watchers.some((w) => !w.up);
      const since = this.status.lastCatchUp ? Date.now() - Date.parse(this.status.lastCatchUp) : Infinity;
      if (since > (down ? 2 : 15) * 60_000) await this.catchUpNow(p).catch(() => {});
    }
    if (this.ctx.cfg.auto.schedule) await this.runDaily(p);
  }

  async kickExec(p: Project): Promise<void> {
    if (this.execRunning) return;
    this.execRunning = true;
    try {
      await runApproved(this.ctx, p);
    } finally {
      this.execRunning = false;
    }
  }

  async kickAgent(p: Project): Promise<void> {
    if (this.agentRunning || !this.ctx.cfg.auto.agent) return;
    this.agentRunning = true;
    try {
      await runJobs(this.ctx, p, this.mcpUrl);
    } finally {
      this.agentRunning = false;
    }
  }

  /** Runs each daily job once per project day; a day missed while closed is made up on the next run. */
  async runDaily(p: Project, only?: string): Promise<void> {
    const today = dayOf(Date.now(), p.settings.timezone);
    for (const [name, fn] of Object.entries(DAILY)) {
      if (only && name !== only) continue;
      const key = `daily:${name}`;
      const last = await one<{ value: any }>(this.ctx.db, "select value from state where project_id = $1 and key = $2", [p.id, key]);
      if (!only && last?.value?.day === today) continue;
      let ok = true, note = "";
      try {
        note = JSON.stringify(await fn(this.ctx, p)).slice(0, 300);
      } catch (err: any) {
        ok = false;
        note = String(err?.message ?? err);
      }
      this.status.tasks[name] = { at: new Date().toISOString(), ok, note };
      await this.ctx.db.query(
        `insert into state (project_id, key, value, updated_at) values ($1, $2, $3, now()) on conflict (project_id, key) do update set value = excluded.value, updated_at = now()`,
        [p.id, key, JSON.stringify({ day: today, ok, note, at: new Date().toISOString() })]);
    }
    void this.kickAgent(p);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // Only this computer's pages may call in; a web page elsewhere can't make the console act.
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { error: "forbidden" });
    if (url.pathname === "/mcp") return this.mcp(req, res, url);
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
    if (req.method === "POST" && req.headers["content-type"]?.split(";")[0] !== "application/json") return send(res, 415, { error: "json only" });
    try {
      const data = await this.api(req.method ?? "GET", url, req.method === "POST" ? await body(req) : undefined);
      send(res, 200, data ?? { ok: true });
    } catch (err: any) {
      send(res, err instanceof Stale ? 409 : 400, { error: String(err?.message ?? err) });
    }
  }

  private async mcp(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const who = url.searchParams.get("who") || "agent";
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = mcpServer(this.ctx, who, url.searchParams.get("project") ?? undefined);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.method === "POST" ? await body(req) : undefined);
    // Cards the agent made may be waiting for an agent job or the executor.
    if (req.method === "POST") {
      const p = await project(this.ctx);
      setTimeout(() => void this.kickAgent(p), 1000);
    }
  }

  /** The console's API. */
  async api(method: string, url: URL, b: any): Promise<unknown> {
    const ctx = this.ctx;
    const p = await project(ctx);
    const path = url.pathname.replace(/^\/api/, "");
    const id = Number(path.split("/")[2]);
    const route = `${method} ${path.replace(/\/\d+/g, "/:id")}`;
    const kick = () => {
      void this.kickExec(p);
      void this.kickAgent(p);
    };
    // Approvals wait a few seconds before anything goes out, so the console's undo can still take them back.
    const kickLater = () => setTimeout(kick, 6_000);
    switch (route) {
      case "GET /state":
        return this.state(p);
      case "GET /cards":
        return this.cards(p, url.searchParams.get("view") ?? "pending");
      case "GET /kols": {
        const q = url.searchParams.get("q") || null, stage = url.searchParams.get("stage") || null, page = Number(url.searchParams.get("page") ?? 0);
        return ctx.db.query(
          `select id, name, handle, platform, email, stage, whose_turn, mailbox, followers, last_contact_at, last_inbound_at, next_followup_at, never_contact,
             (select count(*)::int from posts po where po.kol_id = k.id) as posts
           from kols k where project_id = $1 and ($2::text is null or name ilike '%'||$2||'%' or handle ilike '%'||$2||'%' or email ilike '%'||$2||'%')
             and ($3::text is null or stage = $3)
           order by coalesce(last_inbound_at, last_contact_at, created_at) desc limit 100 offset $4`, [p.id, q, stage, page * 100]);
      }
      case "GET /kols/:id":
        return kolDetail(ctx, p, id);
      case "POST /kols/:id":
        return callTool(ctx, "kol_update", { id, fields: b.fields }, "operator");
      case "POST /kols/:id/mail": {
        // The operator wrote it in the console and clicked send: that is the approval of exactly this text.
        const card = await proposeMail(ctx, p, { kind: "mail", kolId: id, subject: b.subject, body: b.body, to: b.to, mailbox: b.mailbox, inReplyTo: b.in_reply_to, who: "operator", title: b.title });
        const row = await one<any>(ctx.db, "select content_hash from proposals where id = $1", [card.id]);
        await approve(ctx, p, card.id, row.content_hash);
        kickLater();
        return card;
      }
      case "POST /cards/:id/approve": {
        const r = await approve(ctx, p, id, b.hash, b.drop ?? []);
        kickLater();
        return r;
      }
      case "POST /cards/:id/reject":
        return reject(ctx, p, id, b?.note);
      case "POST /cards/:id/undo":
        return undo(ctx, p, id);
      case "POST /cards/:id/revise": {
        await requestRevision(ctx, p, id, b.feedback);
        kick();
        return { ok: true };
      }
      case "POST /cards/:id/edit":
        return editProposal(ctx, p, id, b);
      case "POST /cards/:id/resolve": {
        await resolveUnknown(ctx, p, id, !!b.happened);
        kick();
        return { ok: true };
      }
      case "POST /find":
        return findPeople(ctx, p, b, { direct: true, who: "operator" });
      case "POST /templates":
        return draftTemplate(ctx, p, { ...b, templateId: b.template_id, who: "operator" });
      case "POST /templates/ask": {
        await ctx.db.query("insert into agent_jobs (project_id, kind, input) values ($1, 'template', $2)", [p.id, JSON.stringify({ feedback: b.feedback, template_id: b.template_id ?? null })]);
        kick();
        return { ok: true };
      }
      case "POST /ask": {
        await ctx.db.query("insert into agent_jobs (project_id, kind, input) values ($1, 'ask', $2)", [p.id, JSON.stringify({ text: b.text })]);
        kick();
        return { ok: true };
      }
      case "GET /jobs":
        return ctx.db.query("select id, kind, status, kol_id, proposal_id, agent, session_id, left(output, 600) as output, error, created_at, started_at, finished_at from agent_jobs where project_id = $1 order by id desc limit 60", [p.id]);
      case "POST /jobs/:id/continue":
        return continueJob(ctx, p, id, b.text, this.mcpUrl);
      case "POST /jobs/:id/retry":
        await ctx.db.query("update agent_jobs set status='queued', error=null, started_at=null, finished_at=null where id=$1 and project_id=$2 and status='stuck'", [id, p.id]);
        kick();
        return { ok: true };
      case "POST /tool/:name": {
        const name = path.split("/")[2];
        const r = await callTool(ctx, name, b ?? {}, "operator");
        kick();
        return r;
      }
      case "POST /daily/:name":
        await this.runDaily(p, path.split("/")[2]);
        return this.status.tasks[path.split("/")[2]];
      case "POST /inbox":
        return this.catchUpNow(p);
      case "GET /local":
        return { env: ctx.cfg.env, agent: ctx.cfg.agent, auto: ctx.cfg.auto, project: ctx.cfg.project, mcpUrl: this.mcpUrl };
      case "POST /local": {
        if (b.agent) ctx.cfg.agent = { kind: b.agent.kind === "codex" ? "codex" : "claude", bin: b.agent.bin || undefined, args: Array.isArray(b.agent.args) ? b.agent.args : undefined };
        if (b.auto) {
          const wasInbox = ctx.cfg.auto.inbox;
          ctx.cfg.auto = { ...ctx.cfg.auto, ...b.auto };
          if (!wasInbox && ctx.cfg.auto.inbox) void this.catchUpNow(p).then(() => this.startWatchers(p));
          if (wasInbox && !ctx.cfg.auto.inbox) {
            this.watchers.forEach((w) => w.stop());
            this.watchers = [];
            this.status.watchers = {};
          }
        }
        saveConfig(ctx.cfg);
        return { agent: ctx.cfg.agent, auto: ctx.cfg.auto };
      }
    }
    throw new Error(`没有这个接口：${route}`);
  }

  private async state(p: Project) {
    const db = this.ctx.db;
    const row = await one<any>(db, "select paused from projects where id = $1", [p.id]);
    const counts = await one<any>(db,
      `select (select count(*)::int from proposals where project_id=$1 and status='pending' and parent_id is null) as pending,
              (select count(*)::int from proposals where project_id=$1 and status in ('unknown','failed') and done_at is null) as problems,
              (select count(*)::int from proposals where project_id=$1 and status='approved') as approved,
              (select count(*)::int from proposals where project_id=$1 and status='drafting') as drafting,
              (select count(*)::int from agent_jobs where project_id=$1 and status in ('queued','running')) as jobs,
              (select count(*)::int from agent_jobs where project_id=$1 and status='stuck') as stuck,
              (select count(*)::int from messages where project_id=$1 and direction='in' and pending and kol_id is not null) as unanswered`, [p.id]);
    const mailboxes = await db.query("select address, enabled, daily_limit from mailboxes where project_id = $1 order by id", [p.id]);
    const daily = await db.query("select key, value from state where project_id = $1 and key like 'daily:%'", [p.id]);
    return {
      project: p.name, env: this.ctx.cfg.env, paused: row?.paused, settings: p.settings, counts, mailboxes, status: this.status,
      daily: Object.fromEntries(daily.map((d: any) => [d.key.slice(6), d.value])), dailyNames: DAILY_NAMES, auto: this.ctx.cfg.auto, agent: this.ctx.cfg.agent,
    };
  }

  /** Cards for the console. Groups come with their items and the hash to approve them by. */
  private async cards(p: Project, view: string) {
    const db = this.ctx.db;
    const where = view === "problems" ? "status in ('unknown','failed') and done_at is null"
      : view === "approved" ? "status in ('approved','running')"
      : view === "drafting" ? "status = 'drafting'"
      : view === "done" ? "status in ('done','rejected','superseded','dropped') and done_at > now() - interval '3 days'"
      : "status = 'pending' and parent_id is null";
    const rows = await db.query<any>(
      `select pr.*, k.name as kol_name, k.stage as kol_stage, m.subject as in_subject, m.body as in_body, m.from_addr as in_from, m.at as in_at
       from proposals pr left join kols k on k.id = pr.kol_id left join messages m on m.id = pr.in_reply_to
       where pr.project_id = $1 and pr.${where} order by pr.id ${view === "done" ? "desc" : "asc"} limit 200`, [p.id]);
    for (const r of rows) {
      if (r.kind === "invite_batch" || r.kind === "followup_group") {
        r.items = await db.query("select pr.*, k.name as kol_name from proposals pr left join kols k on k.id = pr.kol_id where pr.parent_id = $1 and pr.status = 'pending' order by pr.id", [r.id]);
        r.hash = groupHash(r.items);
      } else r.hash = r.content_hash;
      if (r.kind === "template" && r.action?.template_id) {
        r.draft = await one(db, "select * from templates where id = $1", [r.action.template_id]);
        r.current = r.draft?.draft_of ? await one(db, "select * from templates where id = $1", [r.draft.draft_of]) : null;
      }
      if (r.in_body) r.in_body = String(r.in_body).slice(0, 4000);
    }
    return rows;
  }
}
