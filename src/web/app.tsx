import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config.js";
import type { Sql } from "../db.js";
import type { Queue } from "../jobs.js";
import { notifyFeishu } from "../notify.js";
import { checkPassword, LoginLimiter, makeSession, readSession } from "./auth.js";
import { parseDiscovery, parseJob, splitList, str, strs, type Body } from "./forms.js";
import { Layout, type Nav } from "./layout.js";
import {
  HomePage, JobFormPage, JobPage, JobsPage, KolsPage, LoginPage, OverviewPage, ProjectForm,
  PAGE_SIZE, STATUS_NAMES, type JobRow, type KolRow, type ListFilters, type Project, type ProjectCard, type RunRow,
} from "./pages.js";

export { STATUS_NAMES };

const COOKIE = "kol_session";
const REVIEW_STATUSES = ["candidate", "approved", "rejected"];

type Env = { Variables: { operator: string } };

export function createApp(sql: Sql, cfg: Config, queue: Pick<Queue, "enqueueDiscovery">) {
  const app = new Hono<Env>();
  const limiter = new LoginLimiter();

  app.get("/healthz", async (c) => {
    await sql`SELECT 1`;
    return c.text("ok");
  });

  // ------------------------------------------------------------ login

  app.get("/login", (c) => c.html(<LoginPage />));

  app.post("/login", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (limiter.blocked(ip)) return c.html(<LoginPage error="尝试次数太多，请 15 分钟后再试" />, 429);
    const body = (await c.req.parseBody()) as Body;
    const operator = str(body, "operator");
    if (!checkPassword(str(body, "password"), { hash: cfg.adminPasswordHash, plain: cfg.adminPassword })) {
      limiter.fail(ip);
      return c.html(<LoginPage error="密码不对" operator={operator} />, 401);
    }
    if (!operator) return c.html(<LoginPage error="请填你的名字，审核记录会用到" />, 400);
    setCookie(c, COOKIE, makeSession(cfg.sessionSecret, operator), {
      httpOnly: true, sameSite: "Lax", secure: cfg.publicUrl.startsWith("https://"), path: "/", maxAge: 30 * 86400,
    });
    return c.redirect("/");
  });

  app.post("/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.redirect("/login");
  });

  app.use("*", async (c, next) => {
    const operator = readSession(cfg.sessionSecret, getCookie(c, COOKIE));
    if (!operator) return c.redirect("/login");
    c.set("operator", operator);
    // Same-site cookie plus an Origin check on writes keeps other sites from posting forms here.
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin && origin !== "null" && URL.parse(origin)?.host !== c.req.header("host")) return c.text("forbidden", 403);
    }
    await next();
  });

  const page = (c: Context<Env>, title: string, body: any, nav?: Nav, status: 200 | 400 | 404 = 200) =>
    c.html(<Layout title={title} operator={c.get("operator")} nav={nav}>{body}</Layout>, status);

  async function loadProject(id: string): Promise<Project | null> {
    if (!/^\d+$/.test(id)) return null;
    const [p] = await sql<Project[]>`SELECT * FROM projects WHERE id = ${Number(id)}`;
    return p ?? null;
  }

  async function nav(p: Project, tab: Nav["tab"]): Promise<Nav> {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_kols WHERE project_id = ${p.id} AND status = 'candidate'`;
    return { project: { id: p.id, name: p.name }, tab, pending: n };
  }

  // ------------------------------------------------------------ projects

  app.get("/", async (c) => {
    const projects = await sql<ProjectCard[]>`
      SELECT p.id, p.name, p.region, p.language,
             count(pk.kol_id)::int AS total,
             count(pk.kol_id) FILTER (WHERE pk.status = 'candidate')::int AS pending,
             count(pk.kol_id) FILTER (WHERE pk.status = 'approved')::int AS approved,
             count(pk.kol_id) FILTER (WHERE EXISTS (SELECT 1 FROM kol_emails e WHERE e.kol_id = pk.kol_id))::int AS with_email,
             (SELECT max(created_at) FROM discovery_jobs j WHERE j.project_id = p.id) AS last_job_at,
             (SELECT count(*) FROM discovery_jobs j WHERE j.project_id = p.id AND j.status IN ('queued', 'running'))::int AS running
      FROM projects p LEFT JOIN project_kols pk ON pk.project_id = p.id GROUP BY p.id ORDER BY p.id`;
    return page(c, "项目", <HomePage projects={projects} />);
  });

  app.get("/projects/new", (c) => page(c, "新建项目", <ProjectForm />));

  app.post("/projects", async (c) => {
    const body = (await c.req.parseBody({ all: true })) as Body;
    const slug = str(body, "slug").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug) || !str(body, "name")) {
      return page(c, "新建项目", <ProjectForm error="请填项目名称和英文代号（小写字母、数字、横线）" />, undefined, 400);
    }
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO projects ${sql(projectFields(body, slug))} RETURNING id`;
    return c.redirect(`/projects/${id}`);
  });

  app.get("/projects/:id/settings", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    return page(c, `${p.name} 设置`, <ProjectForm project={p} flash={c.req.query("flash")} />, await nav(p, "settings"));
  });

  app.post("/projects/:id/settings", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const body = (await c.req.parseBody({ all: true })) as Body;
    const fields = projectFields(body, p.slug);
    await sql`UPDATE projects SET ${sql(fields)}, updated_at = now() WHERE id = ${p.id}`;
    return c.redirect(`/projects/${p.id}/settings?flash=${encodeURIComponent("已保存")}`);
  });

  app.post("/projects/:id/test-notify", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    await notifyFeishu(p.feishu_webhook, `${p.name} 通知测试（${c.get("operator")} 发起）`);
    return c.redirect(`/projects/${p.id}/settings?flash=${encodeURIComponent(p.feishu_webhook ? "已发送测试通知，请到飞书群里看" : "还没填飞书 Webhook")}`);
  });

  app.get("/projects/:id", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const [counts, jobs, [totals]] = await Promise.all([
      statusCounts(sql, p.id),
      sql<JobRow[]>`SELECT * FROM discovery_jobs WHERE project_id = ${p.id} ORDER BY id DESC LIMIT 6`,
      sql<{ with_email: number; pending_with_email: number; spent: string }[]>`
        SELECT count(*) FILTER (WHERE has)::int AS with_email,
               count(*) FILTER (WHERE has AND status = 'candidate')::int AS pending_with_email,
               (SELECT COALESCE(sum(spent_usd), 0) FROM discovery_jobs WHERE project_id = ${p.id}) AS spent
        FROM (SELECT pk.status, EXISTS (SELECT 1 FROM kol_emails e WHERE e.kol_id = pk.kol_id) AS has
              FROM project_kols pk WHERE pk.project_id = ${p.id}) x`,
    ]);
    const active = jobs.filter((j) => j.status === "queued" || j.status === "running");
    const runs = active.length ? await jobRuns(sql, active.map((j) => j.id)) : [];
    return page(c, p.name, (
      <OverviewPage project={p} counts={counts} jobs={jobs} runs={runs} withEmail={totals.with_email}
                    pendingWithEmail={totals.pending_with_email} spent={Number(totals.spent)} flash={c.req.query("flash")} />
    ), await nav(p, "overview"));
  });

  // ------------------------------------------------------------ discovery jobs

  app.get("/projects/:id/jobs", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const jobs = await sql<JobRow[]>`SELECT * FROM discovery_jobs WHERE project_id = ${p.id} ORDER BY id DESC LIMIT 200`;
    return page(c, `${p.name} 找人任务`, <JobsPage project={p} jobs={jobs} />, await nav(p, "jobs"));
  });

  app.get("/projects/:id/jobs/new", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    return page(c, "新建找人任务", <JobFormPage project={p} error={c.req.query("flash")} />, await nav(p, "jobs"));
  });

  app.post("/projects/:id/jobs", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const body = (await c.req.parseBody({ all: true })) as Body;
    const params = parseJob(body);
    if (typeof params === "string") return c.redirect(`/projects/${p.id}/jobs/new?flash=${encodeURIComponent(params)}`);
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO discovery_jobs (project_id, platform, params, created_by)
      VALUES (${p.id}, ${params.platform}, ${sql.json(params as any)}, ${c.get("operator")}) RETURNING id`;
    await queue.enqueueDiscovery(id);
    return c.redirect(`/projects/${p.id}/jobs/${id}`);
  });

  app.get("/projects/:id/jobs/:jobId", async (c) => {
    const p = await loadProject(c.req.param("id"));
    const jobId = c.req.param("jobId");
    if (!p || !/^\d+$/.test(jobId)) return c.notFound();
    const [job] = await sql<JobRow[]>`SELECT * FROM discovery_jobs WHERE id = ${jobId} AND project_id = ${p.id}`;
    if (!job) return c.notFound();
    const [runs, [{ pending }]] = await Promise.all([
      jobRuns(sql, [job.id]),
      sql<{ pending: number }[]>`SELECT count(*)::int AS pending FROM project_kols
                                 WHERE project_id = ${p.id} AND job_id = ${job.id} AND status = 'candidate'`,
    ]);
    return page(c, `任务 #${job.id}`, <JobPage project={p} job={job} runs={runs} pending={pending} />, await nav(p, "jobs"));
  });

  // ------------------------------------------------------------ KOL list and review

  app.get("/projects/:id/kols", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const f = listFilters(c);
    const pageNo = Math.max(1, Number(c.req.query("page")) || 1);
    const [rows, counts, [{ total }]] = await Promise.all([
      listKols(sql, p.id, f, PAGE_SIZE, (pageNo - 1) * PAGE_SIZE),
      statusCounts(sql, p.id, { ...f, status: "" }),
      countKols(sql, p.id, f),
    ]);
    const jobs = await sql<{ id: number; platform: string; created_at: Date }[]>`
      SELECT id, platform, created_at FROM discovery_jobs WHERE project_id = ${p.id} AND new_to_project > 0 ORDER BY id DESC LIMIT 20`;
    return page(c, `${p.name} 名单`, (
      <KolsPage project={p} rows={rows} filters={f} counts={counts} total={total} page={pageNo} jobs={jobs}
                flash={c.req.query("flash")} />
    ), await nav(p, "kols"));
  });

  app.post("/projects/:id/kols/review", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const body = (await c.req.parseBody({ all: true })) as Body;
    const action = str(body, "action");
    const ids = strs(body, "ids").filter((x) => /^\d+$/.test(x)).map(Number);
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
    const back = `/projects/${p.id}/kols?${new URLSearchParams(c.req.query())}`;
    if (!REVIEW_STATUSES.includes(action) || !ids.length) {
      return wantsJson ? c.json({ error: "bad request" }, 400) : c.redirect(back);
    }
    // Review only moves people between candidate / approved / rejected; it never undoes outreach state.
    const updated = await sql`
      UPDATE project_kols SET status = ${action}, reviewed_by = ${c.get("operator")}, reviewed_at = now(), updated_at = now()
      WHERE project_id = ${p.id} AND kol_id IN ${sql(ids)} AND status IN ${sql(REVIEW_STATUSES)}`;
    if (wantsJson) return c.json({ updated: updated.count, counts: await statusCounts(sql, p.id) });
    const sep = back.includes("?") ? "&" : "?";
    return c.redirect(`${back}${sep}flash=${encodeURIComponent(`已更新 ${updated.count} 人`)}`);
  });

  app.get("/projects/:id/kols.csv", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const rows = await listKols(sql, p.id, listFilters(c), 100_000, 0);
    const header = ["platform", "handle", "name", "followers", "email", "email_source", "all_emails", "status",
                    "profile_url", "external_url", "discovered_by", "bio"];
    const lines = rows.map((r) => [
      r.platform, r.handle, r.name, r.followers ?? "", r.emails[0]?.email ?? "", r.emails[0]?.source ?? "",
      r.emails.map((e) => e.email).join("; "), STATUS_NAMES[r.status], r.profile_url, r.external_url, r.discovered_by,
      r.bio.replace(/\s+/g, " ").slice(0, 300),
    ].map(csvCell).join(","));
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${p.slug}-kols.csv"`);
    // BOM so Excel opens Chinese text correctly.
    return c.body(`﻿${[header.join(","), ...lines].join("\r\n")}\r\n`);
  });

  return app;
}

// ------------------------------------------------------------ queries

function listFilters(c: Context): ListFilters {
  const q = (k: string) => (c.req.query(k) ?? "").trim();
  const status = c.req.query("status") === undefined ? "candidate" : q("status");
  return { status, platform: q("platform"), email: q("email"), q: q("q"), job: /^\d+$/.test(q("job")) ? q("job") : "" };
}

function kolWhere(sql: Sql, projectId: number, f: ListFilters) {
  const like = `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const hasEmail = sql`EXISTS (SELECT 1 FROM kol_emails e WHERE e.kol_id = k.id)`;
  return sql`
    WHERE pk.project_id = ${projectId}
      ${f.status ? sql`AND pk.status = ${f.status}` : sql``}
      ${f.platform ? sql`AND k.platform = ${f.platform}` : sql``}
      ${f.job ? sql`AND pk.job_id = ${Number(f.job)}` : sql``}
      ${f.email === "yes" ? sql`AND ${hasEmail}` : f.email === "no" ? sql`AND NOT ${hasEmail}` : sql``}
      ${f.q ? sql`AND (k.handle ILIKE ${like} OR k.name ILIKE ${like} OR k.bio ILIKE ${like})` : sql``}`;
}

export async function listKols(sql: Sql, projectId: number, f: ListFilters, limit: number, offset: number): Promise<KolRow[]> {
  return sql<KolRow[]>`
    SELECT k.id AS kol_id, k.platform, k.handle, k.name, k.followers, k.bio, k.profile_url, k.external_url, k.is_business,
           pk.status, pk.discovered_by, pk.reviewed_by, pk.reviewed_at,
           COALESCE(e.emails, '[]') AS emails,
           EXISTS (SELECT 1 FROM do_not_contact d
                   WHERE (d.project_id IS NULL OR d.project_id = ${projectId})
                     AND ((d.platform = k.platform AND d.handle = k.handle)
                          OR d.email IN (SELECT email FROM kol_emails WHERE kol_id = k.id))) AS blocked
    FROM project_kols pk
    JOIN kols k ON k.id = pk.kol_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('email', email, 'source', source, 'check_status', check_status)
                      ORDER BY check_status = 'invalid',
                               array_position(ARRAY['platform_field','bio','link_page','youtube_hidden','import','manual'], source),
                               found_at) AS emails
      FROM kol_emails WHERE kol_id = k.id
    ) e ON true
    ${kolWhere(sql, projectId, f)}
    ORDER BY (e.emails IS NOT NULL) DESC, k.followers DESC NULLS LAST, k.id
    LIMIT ${limit} OFFSET ${offset}`;
}

function countKols(sql: Sql, projectId: number, f: ListFilters) {
  return sql<{ total: number }[]>`
    SELECT count(*)::int AS total FROM project_kols pk JOIN kols k ON k.id = pk.kol_id ${kolWhere(sql, projectId, f)}`;
}

/** People per review status, under the same platform / email / search filters as the list. */
async function statusCounts(sql: Sql, projectId: number,
                            f: ListFilters = { status: "", platform: "", email: "", q: "", job: "" }): Promise<Record<string, number>> {
  const rows = await sql<{ status: string; n: number }[]>`
    SELECT pk.status, count(*)::int AS n FROM project_kols pk JOIN kols k ON k.id = pk.kol_id
    ${kolWhere(sql, projectId, { ...f, status: "" })} GROUP BY pk.status`;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

function jobRuns(sql: Sql, jobIds: number[]) {
  return sql<RunRow[]>`
    SELECT job_id, step, actor, run_id, status, items, cost_usd FROM apify_runs WHERE job_id IN ${sql(jobIds)} ORDER BY id`;
}

function projectFields(body: Body, slug: string) {
  return {
    slug,
    name: str(body, "name"),
    region: str(body, "region"),
    language: str(body, "language"),
    brand_brief: str(body, "brand_brief"),
    writing_guide: str(body, "writing_guide"),
    feishu_webhook: str(body, "feishu_webhook"),
    reviewers: splitList(str(body, "reviewers")),
    discovery: parseDiscovery(body) as any,
  };
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  // Leading = + - @ would run as a formula in Excel.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
