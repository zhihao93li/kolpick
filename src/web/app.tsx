import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config.js";
import type { Sql } from "../db.js";
import { estimate } from "../discovery/apify.js";
import { PLATFORMS } from "../discovery/models.js";
import { DEFAULT_PARAMS, type DiscoveryParams } from "../discovery/run.js";
import type { Queue } from "../jobs.js";
import { notifyFeishu } from "../notify.js";
import { checkPassword, LoginLimiter, makeSession, readSession } from "./auth.js";
import { parseDiscovery, parseJob, splitList, str, strs, type Body, type DiscoveryDefaults } from "./forms.js";
import { Layout } from "./layout.js";

const COOKIE = "kol_session";

type Env = { Variables: { operator: string } };

const PLATFORM_NAMES: Record<string, string> = { instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok" };
export const STATUS_NAMES: Record<string, string> = {
  candidate: "待审核", approved: "已通过", rejected: "已排除", contacted: "已联系",
  replied: "已回复", agreed: "已合作", declined: "已拒绝",
};
const JOB_STATUS: Record<string, string> = { queued: "排队中", running: "运行中", done: "完成", failed: "失败" };
const SOURCE_NAMES: Record<string, string> = {
  platform_field: "商业号邮箱", bio: "简介", link_page: "外链页面", youtube_hidden: "YouTube 隐藏邮箱",
  import: "导入", manual: "手动",
};
const CHECK_NAMES: Record<string, string> = { discovered: "未检查", basic_ok: "基础检查通过", unknown: "未知", invalid: "无效" };

interface Project {
  id: number;
  slug: string;
  name: string;
  region: string;
  language: string;
  brand_brief: string;
  writing_guide: string;
  discovery: DiscoveryDefaults;
  feishu_webhook: string;
  reviewers: string[];
}

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
      return c.html(<LoginPage error="密码不对" />, 401);
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

  const page = (c: Context<Env>, title: string, body: any, status: 200 | 400 | 404 = 200) =>
    c.html(<Layout title={title} operator={c.get("operator")}>{body}</Layout>, status);

  async function loadProject(id: string): Promise<Project | null> {
    if (!/^\d+$/.test(id)) return null;
    const [p] = await sql<Project[]>`SELECT * FROM projects WHERE id = ${Number(id)}`;
    return p ?? null;
  }

  // ------------------------------------------------------------ projects

  app.get("/", async (c) => {
    const projects = await sql<(Project & { total: number; pending: number })[]>`
      SELECT p.*, count(pk.kol_id)::int AS total, count(pk.kol_id) FILTER (WHERE pk.status = 'candidate')::int AS pending
      FROM projects p LEFT JOIN project_kols pk ON pk.project_id = p.id GROUP BY p.id ORDER BY p.id`;
    return page(c, "项目", (
      <>
        <div class="row"><h1>项目</h1><a href="/projects/new">新建项目</a></div>
        {projects.length === 0 ? <p class="muted">还没有项目，先新建一个。</p> : (
          <table>
            <tr><th>项目</th><th>地区</th><th>语言</th><th>KOL 数</th><th>待审核</th></tr>
            {projects.map((p) => (
              <tr>
                <td><a href={`/projects/${p.id}`}>{p.name}</a></td>
                <td>{p.region}</td><td>{p.language}</td><td>{p.total}</td><td>{p.pending}</td>
              </tr>
            ))}
          </table>
        )}
      </>
    ));
  });

  app.get("/projects/new", (c) => page(c, "新建项目", <ProjectForm />));

  app.post("/projects", async (c) => {
    const body = (await c.req.parseBody({ all: true })) as Body;
    const slug = str(body, "slug").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug) || !str(body, "name")) {
      return page(c, "新建项目", <ProjectForm error="请填项目名称和英文代号（小写字母、数字、横线）" />, 400);
    }
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO projects ${sql(projectFields(body, slug))} RETURNING id`;
    return c.redirect(`/projects/${id}`);
  });

  app.get("/projects/:id/settings", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    return page(c, `${p.name} 设置`, <ProjectForm project={p} flash={c.req.query("flash")} />);
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
    const counts = await sql<{ status: string; n: number }[]>`
      SELECT status, count(*)::int AS n FROM project_kols WHERE project_id = ${p.id} GROUP BY status`;
    const jobs = await sql<JobRow[]>`
      SELECT * FROM discovery_jobs WHERE project_id = ${p.id} ORDER BY id DESC LIMIT 20`;
    const by = Object.fromEntries(counts.map((r) => [r.status, r.n]));
    return page(c, p.name, (
      <>
        <div class="row">
          <h1>{p.name}</h1>
          <a href={`/projects/${p.id}/kols`}>KOL 名单</a>
          <a href={`/projects/${p.id}/settings`}>项目设置</a>
        </div>
        {c.req.query("flash") && <div class="flash">{c.req.query("flash")}</div>}
        <div class="cards">
          {Object.entries(STATUS_NAMES).map(([key, label]) => (
            <a class="card" href={`/projects/${p.id}/kols?status=${key}`}><b>{by[key] ?? 0}</b>{label}</a>
          ))}
        </div>
        <h2>找人</h2>
        <JobForm project={p} />
        <h2>最近的任务</h2>
        <JobTable projectId={p.id} jobs={jobs} />
      </>
    ));
  });

  // ------------------------------------------------------------ discovery jobs

  app.post("/projects/:id/jobs", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const body = (await c.req.parseBody({ all: true })) as Body;
    const params = parseJob(body);
    if (typeof params === "string") return c.redirect(`/projects/${p.id}?flash=${encodeURIComponent(params)}`);
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
    const runs = await sql<{ step: string; actor: string; run_id: string; status: string; items: number | null; cost_usd: string | null }[]>`
      SELECT step, actor, run_id, status, items, cost_usd FROM apify_runs WHERE job_id = ${job.id} ORDER BY id`;
    const params = job.params;
    return page(c, `任务 #${job.id}`, (
      <>
        <h1>{p.name} · 找人任务 #{job.id}</h1>
        {(job.status === "queued" || job.status === "running") && <meta http-equiv="refresh" content="15" />}
        <p>
          {PLATFORM_NAMES[job.platform]} · <JobStatus job={job} /> · {job.created_by} 于 {fmt(job.created_at)} 提交
          {job.message && <> · <span class={job.status === "failed" ? "bad" : "muted"}>{job.message}</span></>}
        </p>
        <div class="cards">
          <div class="card"><b>{job.found}</b>找到</div>
          <div class="card"><b>{job.with_email}</b>有邮箱</div>
          <div class="card"><b>{job.new_to_project}</b>新增待审核</div>
          <div class="card"><b>${Number(job.spent_usd).toFixed(2)}</b>约花费</div>
        </div>
        <p><a href={`/projects/${p.id}/kols?job=${job.id}`}>查看这次找到的人</a></p>
        <h2>参数</h2>
        <table>
          <tr><th>关键词</th><td>{params.keywords.join("、") || "—"}</td></tr>
          <tr><th>种子账号</th><td>{params.seeds.join("、") || "—"}</td></tr>
          <tr><th>已知账号</th><td>{params.handles.length ? `${params.handles.length} 个` : "—"}</td></tr>
          <tr><th>粉丝范围</th><td>{params.minFollowers ?? "不限"} – {params.maxFollowers ?? "不限"}</td></tr>
          <tr><th>预算</th><td>${params.maxSpend}</td></tr>
        </table>
        <h2>Apify 运行记录</h2>
        <table>
          <tr><th>步骤</th><th>actor</th><th>状态</th><th>条数</th><th>费用</th></tr>
          {runs.map((r) => (
            <tr>
              <td>{r.step}</td>
              <td><a href={`https://console.apify.com/actors/runs/${r.run_id}`} target="_blank">{r.actor}</a></td>
              <td>{r.status}</td><td>{r.items ?? ""}</td><td>{r.cost_usd ? `$${Number(r.cost_usd).toFixed(3)}` : ""}</td>
            </tr>
          ))}
        </table>
      </>
    ));
  });

  // ------------------------------------------------------------ KOL list and review

  app.get("/projects/:id/kols", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const f = listFilters(c);
    const rows = await listKols(sql, p.id, f, 200);
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
    return page(c, `${p.name} 名单`, (
      <>
        <div class="row"><h1>{p.name} · KOL 名单</h1><a href={`/projects/${p.id}`}>返回项目</a></div>
        {c.req.query("flash") && <div class="flash">{c.req.query("flash")}</div>}
        <form method="get" class="row">
          <select name="status" style="width:auto">
            <option value="">全部状态</option>
            {Object.entries(STATUS_NAMES).map(([k, v]) => <option value={k} selected={f.status === k}>{v}</option>)}
          </select>
          <select name="platform" style="width:auto">
            <option value="">全部平台</option>
            {PLATFORMS.map((k) => <option value={k} selected={f.platform === k}>{PLATFORM_NAMES[k]}</option>)}
          </select>
          <select name="email" style="width:auto">
            <option value="">有无邮箱都看</option>
            <option value="yes" selected={f.email === "yes"}>只看有邮箱</option>
            <option value="no" selected={f.email === "no"}>只看没邮箱</option>
          </select>
          <input type="text" name="q" value={f.q} placeholder="搜账号、名字、简介" style="width:200px" />
          {f.job && <input type="hidden" name="job" value={f.job} />}
          <button>筛选</button>
          <a href={`/projects/${p.id}/kols.csv?${qs}`}>导出 CSV</a>
        </form>
        <form method="post" action={`/projects/${p.id}/kols/review?${qs}`}>
          <p class="row">
            <span class="muted">显示 {rows.length} 人{rows.length === 200 ? "（最多 200，用筛选缩小范围）" : ""}，勾选后：</span>
            <button name="action" value="approved" class="primary">通过</button>
            <button name="action" value="rejected">排除</button>
            <button name="action" value="candidate">退回待审核</button>
          </p>
          <table>
            <tr>
              <th><input type="checkbox" onclick="document.querySelectorAll('input[name=ids]').forEach(x=>x.checked=this.checked)" /></th>
              <th>平台</th><th>账号</th><th>粉丝</th><th>邮箱</th><th>简介</th><th>状态</th><th>来源</th>
            </tr>
            {rows.map((r) => (
              <tr>
                <td><input type="checkbox" name="ids" value={String(r.kol_id)} /></td>
                <td>{PLATFORM_NAMES[r.platform]}</td>
                <td><a href={r.profile_url} target="_blank">{r.handle}</a><div class="muted">{r.name}</div></td>
                <td>{r.followers?.toLocaleString() ?? "?"}</td>
                <td>
                  {r.emails.map((e) => (
                    <div>
                      {e.email} <span class="tag">{SOURCE_NAMES[e.source]}</span>{" "}
                      <span class={e.check_status === "basic_ok" ? "ok" : e.check_status === "invalid" ? "bad" : "muted"}>
                        {CHECK_NAMES[e.check_status]}
                      </span>
                    </div>
                  ))}
                  {r.blocked && <div class="bad">在禁止联系名单里</div>}
                </td>
                <td class="bio">{r.bio.slice(0, 160)}</td>
                <td>{STATUS_NAMES[r.status]}{r.reviewed_by && <div class="muted">{r.reviewed_by}</div>}</td>
                <td class="muted">{r.discovered_by}</td>
              </tr>
            ))}
          </table>
        </form>
      </>
    ));
  });

  app.post("/projects/:id/kols/review", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const body = (await c.req.parseBody({ all: true })) as Body;
    const action = str(body, "action");
    const ids = strs(body, "ids").filter((x) => /^\d+$/.test(x)).map(Number);
    const back = `/projects/${p.id}/kols?${new URLSearchParams(c.req.query())}`;
    if (!["approved", "rejected", "candidate"].includes(action) || !ids.length) return c.redirect(back);
    // Review only moves people between candidate / approved / rejected; it never undoes outreach state.
    const updated = await sql`
      UPDATE project_kols SET status = ${action}, reviewed_by = ${c.get("operator")}, reviewed_at = now(), updated_at = now()
      WHERE project_id = ${p.id} AND kol_id IN ${sql(ids)} AND status IN ('candidate', 'approved', 'rejected')`;
    const sep = back.includes("?") ? "&" : "?";
    return c.redirect(`${back}${sep}flash=${encodeURIComponent(`已更新 ${updated.count} 人`)}`);
  });

  app.get("/projects/:id/kols.csv", async (c) => {
    const p = await loadProject(c.req.param("id"));
    if (!p) return c.notFound();
    const rows = await listKols(sql, p.id, listFilters(c), 100_000);
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

interface JobRow {
  id: number;
  platform: string;
  params: DiscoveryParams;
  status: string;
  created_by: string;
  message: string;
  spent_usd: string;
  found: number;
  with_email: number;
  new_to_project: number;
  created_at: Date;
}

interface KolRow {
  kol_id: number;
  platform: string;
  handle: string;
  name: string;
  followers: number | null;
  bio: string;
  profile_url: string;
  external_url: string;
  status: string;
  discovered_by: string;
  reviewed_by: string;
  emails: { email: string; source: string; check_status: string }[];
  blocked: boolean;
}

type ListFilters = { status: string; platform: string; email: string; q: string; job: string };

function listFilters(c: Context): ListFilters {
  const q = (k: string) => (c.req.query(k) ?? "").trim();
  const status = c.req.query("status") === undefined ? "candidate" : q("status");
  return { status, platform: q("platform"), email: q("email"), q: q("q"), job: /^\d+$/.test(q("job")) ? q("job") : "" };
}

export async function listKols(sql: Sql, projectId: number, f: ListFilters, limit: number): Promise<KolRow[]> {
  const like = `%${f.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  return sql<KolRow[]>`
    SELECT k.id AS kol_id, k.platform, k.handle, k.name, k.followers, k.bio, k.profile_url, k.external_url,
           pk.status, pk.discovered_by, pk.reviewed_by,
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
    WHERE pk.project_id = ${projectId}
      ${f.status ? sql`AND pk.status = ${f.status}` : sql``}
      ${f.platform ? sql`AND k.platform = ${f.platform}` : sql``}
      ${f.job ? sql`AND pk.job_id = ${Number(f.job)}` : sql``}
      ${f.email === "yes" ? sql`AND e.emails IS NOT NULL` : f.email === "no" ? sql`AND e.emails IS NULL` : sql``}
      ${f.q ? sql`AND (k.handle ILIKE ${like} OR k.name ILIKE ${like} OR k.bio ILIKE ${like})` : sql``}
    ORDER BY (e.emails IS NOT NULL) DESC, k.followers DESC NULLS LAST, k.id
    LIMIT ${limit}`;
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

function fmt(d: Date): string {
  return new Date(d).toLocaleString("zh-CN", { timeZone: "Asia/Taipei", hour12: false });
}

// ------------------------------------------------------------ views

function LoginPage(props: { error?: string }) {
  return (
    <Layout title="登录">
      <h1>KOL 平台</h1>
      {props.error && <div class="flash">{props.error}</div>}
      <form method="post" action="/login" class="stack">
        <label>你的名字（审核记录用）</label>
        <input type="text" name="operator" required />
        <label>密码</label>
        <input type="password" name="password" required />
        <p><button class="primary">登录</button></p>
      </form>
    </Layout>
  );
}

function ProjectForm(props: { project?: Project; error?: string; flash?: string }) {
  const p = props.project;
  return (
    <>
      <h1>{p ? `${p.name} · 设置` : "新建项目"}</h1>
      {(props.error || props.flash) && <div class="flash">{props.error || props.flash}</div>}
      <form method="post" action={p ? `/projects/${p.id}/settings` : "/projects"} class="stack">
        <label>项目名称</label>
        <input type="text" name="name" value={p?.name} required />
        {!p && (<><label>英文代号（小写字母、数字、横线，建好后不能改）</label><input type="text" name="slug" required /></>)}
        <label>目标地区</label>
        <input type="text" name="region" value={p?.region} placeholder="台湾" />
        <label>沟通语言</label>
        <input type="text" name="language" value={p?.language} placeholder="繁体中文" />
        <label>品牌介绍（第二阶段写信用）</label>
        <textarea name="brand_brief">{p?.brand_brief}</textarea>
        <label>写信要求（第二阶段写信用）</label>
        <textarea name="writing_guide">{p?.writing_guide}</textarea>
        <label>审核人（逗号分隔）</label>
        <input type="text" name="reviewers" value={p?.reviewers.join("，")} />
        <label>飞书群机器人 Webhook</label>
        <input type="text" name="feishu_webhook" value={p?.feishu_webhook} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
        <h2>找人默认条件</h2>
        <p class="muted">新建任务时会预先填好，每次可以改。</p>
        <DiscoveryFields d={p?.discovery ?? {}} />
        <p><button class="primary">保存</button></p>
      </form>
      {p && (
        <form method="post" action={`/projects/${p.id}/test-notify`}><button>发一条测试通知到飞书群</button></form>
      )}
    </>
  );
}

function DiscoveryFields(props: { d: DiscoveryDefaults }) {
  const d = { ...DEFAULT_PARAMS, ...props.d };
  return (
    <>
      <label>关键词（每行一个，或用逗号分隔；短词效果更好）</label>
      <textarea name="keywords">{d.keywords.join("\n")}</textarea>
      <label>种子账号（只用于 Instagram：找跟这些账号相似的人）</label>
      <textarea name="seeds">{d.seeds.join("\n")}</textarea>
      <div class="row">
        <span>每个关键词最多 <input type="number" name="perKeyword" value={String(d.perKeyword)} style="width:90px" /> 人</span>
        <span>每个种子最多 <input type="number" name="perSeed" value={String(d.perSeed)} style="width:90px" /> 人</span>
      </div>
      <div class="row">
        <span>粉丝 <input type="number" name="minFollowers" value={d.minFollowers?.toString() ?? ""} style="width:110px" /> 到{" "}
          <input type="number" name="maxFollowers" value={d.maxFollowers?.toString() ?? ""} style="width:110px" />（空着不限）</span>
      </div>
      <div class="row">
        <label style="margin:0"><input type="checkbox" name="chineseOnly" checked={d.chineseOnly} /> 只要中文账号</label>
        <label style="margin:0"><input type="checkbox" name="linkPages" checked={d.linkPages} /> 爬简介外链页面找邮箱</label>
        <label style="margin:0"><input type="checkbox" name="youtubeHidden" checked={d.youtubeHidden} /> YouTube 查隐藏商务邮箱（找到一个约 $0.12）</label>
      </div>
      <div class="row">
        <span>YouTube 地区 <input type="text" name="country" value={d.country} style="width:70px" /></span>
        <span>语言 <input type="text" name="language" value={d.language} style="width:70px" /></span>
        <span>每次预算上限 $ <input type="number" step="0.5" name="maxSpend" value={String(d.maxSpend)} style="width:90px" /></span>
      </div>
    </>
  );
}

function JobForm(props: { project: Project }) {
  const p = props.project;
  const d = { ...DEFAULT_PARAMS, ...p.discovery };
  // Rough worst case for the search step alone, to set expectations before submitting.
  const igGuess = estimate("ig_search", d.keywords.length * d.perKeyword) + estimate("ig_email", d.keywords.length * d.perKeyword);
  return (
    <form method="post" action={`/projects/${p.id}/jobs`} class="stack">
      <label>平台</label>
      <select name="platform" style="width:auto">
        {PLATFORMS.map((k) => <option value={k}>{PLATFORM_NAMES[k]}</option>)}
      </select>
      <DiscoveryFields d={p.discovery} />
      <label>已知账号（直接查这些人；每行一个，账号或主页链接都行。TikTok 建议用这种方式）</label>
      <textarea name="handles" />
      <p class="muted">参考：Instagram 按当前关键词搜索加查邮箱，大约 ${igGuess.toFixed(2)}。花费超过预算上限就停，已找到的照样保存。</p>
      <p><button class="primary">开始找人</button></p>
    </form>
  );
}

function JobStatus(props: { job: JobRow }) {
  const cls = props.job.status === "failed" ? "bad" : props.job.status === "done" ? "ok" : "muted";
  return <span class={cls}>{JOB_STATUS[props.job.status]}</span>;
}

function JobTable(props: { projectId: number; jobs: JobRow[] }) {
  if (!props.jobs.length) return <p class="muted">还没有任务。</p>;
  return (
    <table>
      <tr><th>#</th><th>平台</th><th>状态</th><th>找到</th><th>有邮箱</th><th>新增</th><th>花费</th><th>提交</th></tr>
      {props.jobs.map((j) => (
        <tr>
          <td><a href={`/projects/${props.projectId}/jobs/${j.id}`}>{j.id}</a></td>
          <td>{PLATFORM_NAMES[j.platform]}</td>
          <td><JobStatus job={j} /></td>
          <td>{j.found}</td><td>{j.with_email}</td><td>{j.new_to_project}</td>
          <td>${Number(j.spent_usd).toFixed(2)}</td>
          <td class="muted">{j.created_by} {fmt(j.created_at)}</td>
        </tr>
      ))}
    </table>
  );
}
