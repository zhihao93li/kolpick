import { ACTORS } from "../discovery/apify.js";
import { PLATFORMS } from "../discovery/models.js";
import { DEFAULT_PARAMS, type DiscoveryParams } from "../discovery/run.js";
import type { DiscoveryDefaults } from "./forms.js";
import { ago, Avatar, compact, Layout, PlatformIcon } from "./layout.js";

export const PAGE_SIZE = 50;

export const PLATFORM_NAMES: Record<string, string> = { instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok" };
export const STATUS_NAMES: Record<string, string> = {
  candidate: "待审核", approved: "已通过", rejected: "已排除", contacted: "已联系",
  replied: "已回复", agreed: "已合作", declined: "已拒绝",
};
const JOB_STATUS: Record<string, [string, string]> = {
  queued: ["排队中", "warn live"], running: ["运行中", "info live"], done: ["完成", "ok"], failed: ["失败", "bad"],
};
const SOURCE_NAMES: Record<string, string> = {
  platform_field: "商业号邮箱", bio: "简介", link_page: "外链页面", youtube_hidden: "YouTube 隐藏邮箱",
  import: "导入", manual: "手动",
};
const CHECK_NAMES: Record<string, string> = {
  discovered: "还没检查", basic_ok: "格式和域名正常", unknown: "域名无法确认", invalid: "无效（退信）",
};
// What each Apify step does, in the words an ops person would use.
const STEP_NAMES: Record<string, string> = {
  ig_related: "找相似账号", ig_search: "按关键词搜账号", ig_email: "读主页和商业号邮箱", link_pages: "打开简介外链找邮箱",
  yt_search: "按关键词搜频道", yt_profile: "读频道简介和邮箱", yt_hidden: "查隐藏商务邮箱",
  tt_search: "按关键词搜账号", tt_profile: "读主页简介",
};
const PLATFORM_HINTS: Record<string, string> = {
  instagram: "相似账号 + 关键词搜索，商业号邮箱命中率最高",
  youtube: "按关键词搜频道，效果稳定",
  tiktok: "关键词搜索效果差，建议直接粘贴已知账号",
};

export interface Project {
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

export interface ProjectCard {
  id: number;
  name: string;
  region: string;
  language: string;
  total: number;
  pending: number;
  approved: number;
  with_email: number;
  last_job_at: Date | null;
  running: number;
}

export interface JobRow {
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
  started_at: Date | null;
  finished_at: Date | null;
}

export interface RunRow {
  job_id: number;
  step: string;
  actor: string;
  run_id: string;
  status: string;
  items: number | null;
  cost_usd: string | null;
}

export interface KolRow {
  kol_id: number;
  platform: string;
  handle: string;
  name: string;
  followers: number | null;
  bio: string;
  profile_url: string;
  external_url: string;
  is_business: boolean | null;
  status: string;
  discovered_by: string;
  reviewed_by: string;
  reviewed_at: Date | null;
  emails: { email: string; source: string; check_status: string }[];
  blocked: boolean;
}

export type ListFilters = { status: string; platform: string; email: string; q: string; job: string };

// ------------------------------------------------------------ small pieces

function Flash(props: { text?: string; bad?: boolean }) {
  return props.text ? <div class={props.bad ? "flash bad" : "flash"}>{props.text}</div> : null;
}

function JobBadge(props: { status: string }) {
  const [label, cls] = JOB_STATUS[props.status] ?? [props.status, ""];
  return <span class={`badge ${cls}`}><span class="dot" />{label}</span>;
}

function money(v: string | number): string {
  return `$${Number(v).toFixed(2)}`;
}

function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "—";
}

/** "related" / "search:新秘" / "input" as a reviewer would say it. */
function sourceLabel(by: string): string {
  if (by === "related") return "相似账号推荐";
  if (by === "input") return "手动填的已知账号";
  if (by.startsWith("search:")) return `搜索「${by.slice(7)}」`;
  return by;
}

function describeParams(p: DiscoveryParams): string {
  const parts: string[] = [];
  if (p.keywords?.length) parts.push(`关键词 ${p.keywords.join("、")}`);
  if (p.seeds?.length) parts.push(`相似于 ${p.seeds.map((s) => `@${s}`).join("、")}`);
  if (p.handles?.length) parts.push(`已知账号 ${p.handles.length} 个`);
  if (p.minFollowers || p.maxFollowers) parts.push(`粉丝 ${compact(p.minFollowers ?? 0)}–${p.maxFollowers ? compact(p.maxFollowers) : "不限"}`);
  return parts.join(" · ") || "—";
}

/** The Apify steps a job will run, in order, so progress can show what is still to come. */
function plannedSteps(p: DiscoveryParams): string[] {
  const steps: string[] = [];
  if (p.platform === "instagram") {
    if (p.seeds?.length) steps.push("ig_related");
    if (p.keywords?.length) steps.push("ig_search");
    steps.push("ig_email");
  } else if (p.platform === "youtube") {
    if (p.keywords?.length) steps.push("yt_search");
    steps.push("yt_profile");
  } else {
    if (p.keywords?.length) steps.push("tt_search");
    steps.push("tt_profile");
  }
  if (p.linkPages) steps.push("link_pages");
  if (p.platform === "youtube" && p.youtubeHidden) steps.push("yt_hidden");
  return steps;
}

function StepList(props: { job: JobRow; runs: RunRow[]; detail?: boolean }) {
  const { job, runs } = props;
  const byStep = new Map(runs.map((r) => [r.step, r]));
  const steps = [...new Set([...plannedSteps({ ...job.params, platform: job.platform as DiscoveryParams["platform"] }), ...runs.map((r) => r.step)])];
  const finished = job.status === "done" || job.status === "failed";
  return (
    <ul class="steps">
      {steps.map((s) => {
        const r = byStep.get(s);
        const st = !r ? (finished ? "skip" : "wait") : r.status === "RUNNING" || r.status === "READY" ? "run"
          : r.status === "SUCCEEDED" ? "done" : "fail";
        const icon = { done: "✓", run: "●", fail: "!", wait: "", skip: "–" }[st];
        const note = { done: "", run: "进行中", fail: "出错", wait: "等待", skip: "没有执行" }[st];
        return (
          <li>
            <span class={`ic ${st}`}>{icon}</span>
            <span>
              {STEP_NAMES[s] ?? s}
              {props.detail && r && (
                <span class="muted small"> · <a href={`https://console.apify.com/actors/runs/${r.run_id}`} target="_blank">Apify 记录</a></span>
              )}
            </span>
            <span class="muted small num">
              {r?.items != null ? `${r.items} 条` : note}
              {props.detail && r?.cost_usd ? ` · $${Number(r.cost_usd).toFixed(3)}` : ""}
            </span>
          </li>
        );
      })}
      <li>
        <span class={`ic ${job.status === "done" ? "done" : job.status === "failed" ? "fail" : ""}`}>{job.status === "done" ? "✓" : ""}</span>
        <span>检查邮箱并存进名单</span>
        <span class="muted small">{job.status === "done" ? `新增 ${job.new_to_project} 人` : job.status === "failed" ? "" : "等待"}</span>
      </li>
    </ul>
  );
}

function AutoRefresh(props: { when: boolean }) {
  return props.when ? <meta http-equiv="refresh" content="15" /> : null;
}

// ------------------------------------------------------------ login

export function LoginPage(props: { error?: string; operator?: string }) {
  return (
    <Layout title="登录">
      <div class="login">
        <div class="panel">
          <div class="bd">
            <div class="brand" style="margin-bottom:20px"><i>K</i>KOL 平台</div>
            <h1 style="margin-bottom:4px">登录</h1>
            <p class="muted" style="margin-bottom:20px">团队共用一个密码，名字用来记录谁审核了谁。</p>
            <Flash text={props.error} bad />
            <form method="post" action="/login">
              <label class="field"><span class="lb">你的名字</span>
                <input class="input" type="text" name="operator" value={props.operator} required autofocus /></label>
              <label class="field"><span class="lb">密码</span>
                <input class="input" type="password" name="password" required /></label>
              <p style="margin-top:20px"><button class="btn primary block lg">登录</button></p>
            </form>
          </div>
        </div>
      </div>
    </Layout>
  );
}

// ------------------------------------------------------------ home

export function HomePage(props: { projects: ProjectCard[] }) {
  const { projects } = props;
  return (
    <>
      <div class="pagehead">
        <h1>项目</h1>
        <div class="actions"><a class="btn" href="/projects/new">＋ 新建项目</a></div>
        <div class="sub">KOL 总库所有项目共用；每个项目有自己的找人条件和审核名单。</div>
      </div>
      {projects.length === 0 ? (
        <div class="panel empty">
          <b>还没有项目</b>
          <p>先建一个项目，填好地区和找人条件，就能开始找 KOL。</p>
          <p style="margin-top:12px"><a class="btn primary" href="/projects/new">新建项目</a></p>
        </div>
      ) : (
        <div class="grid g3">
          {projects.map((p) => (
            <div class="panel">
              <div class="bd">
                <div class="row" style="margin-bottom:4px">
                  <h2 style="margin:0"><a href={`/projects/${p.id}`} style="color:inherit">{p.name}</a></h2>
                  {p.running > 0 && <span class="badge info live"><span class="dot" />{p.running} 个任务在跑</span>}
                </div>
                <p class="muted small">{[p.region, p.language].filter(Boolean).join(" · ") || "未填地区"}
                  {p.last_job_at && ` · 上次找人 ${ago(p.last_job_at)}`}</p>
                <div class="grid g3" style="gap:8px;margin:14px 0">
                  <div><div class="muted small">待审核</div><div style="font-size:20px;font-weight:600" class="num">{p.pending}</div></div>
                  <div><div class="muted small">已通过</div><div style="font-size:20px;font-weight:600" class="num">{p.approved}</div></div>
                  <div><div class="muted small">有邮箱</div><div style="font-size:20px;font-weight:600" class="num">{pct(p.with_email, p.total)}</div></div>
                </div>
                <div class="row">
                  {p.pending > 0
                    ? <a class="btn primary" href={`/projects/${p.id}/kols`}>审核 {p.pending} 人</a>
                    : <a class="btn" href={`/projects/${p.id}/kols?status=approved`}>看名单</a>}
                  <a class="btn" href={`/projects/${p.id}/jobs/new`}>找人</a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------ project overview

export function OverviewPage(props: {
  project: Project; counts: Record<string, number>; jobs: JobRow[]; runs: RunRow[];
  withEmail: number; pendingWithEmail: number; spent: number; flash?: string;
}) {
  const { project: p, counts, jobs, runs } = props;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pending = counts.candidate ?? 0;
  const active = jobs.filter((j) => j.status === "queued" || j.status === "running");
  const outreach = ["contacted", "replied", "agreed", "declined"].filter((s) => counts[s]);
  return (
    <>
      <AutoRefresh when={active.length > 0} />
      <div class="pagehead">
        <h1>{p.name}</h1>
        <div class="actions"><a class="btn primary" href={`/projects/${p.id}/jobs/new`}>＋ 找一批新 KOL</a></div>
        <div class="sub">{[p.region, p.language, p.reviewers.length ? `审核：${p.reviewers.join("、")}` : ""].filter(Boolean).join(" · ")}</div>
      </div>
      <Flash text={props.flash} />
      <div class="stack">
        {pending > 0 && (
          <div class="callout">
            <div class="big">{pending}</div>
            <div>
              <b>人等你审核</b>
              <div class="muted small">其中 {props.pendingWithEmail} 人有邮箱。通过的人会进入后面的写信环节。</div>
            </div>
            <div class="spacer" />
            <a class="btn primary lg" href={`/projects/${p.id}/kols`}>开始审核</a>
          </div>
        )}

        {active.map((j) => (
          <div class="panel">
            <div class="hd">
              <PlatformIcon platform={j.platform} />
              <h2>正在找人 · 任务 #{j.id}</h2>
              <JobBadge status={j.status} />
              <a class="right small" href={`/projects/${p.id}/jobs/${j.id}`}>查看详情</a>
            </div>
            <div class="bd">
              <p class="muted small">{describeParams(j.params)} · {j.created_by} {ago(j.created_at)}提交 · 页面每 15 秒自动刷新</p>
              <StepList job={j} runs={runs.filter((r) => r.job_id === j.id)} />
            </div>
          </div>
        ))}

        <div class="grid g4">
          <a class="panel stat" href={`/projects/${p.id}/kols?status=`}>
            <div class="k">名单总人数</div><div class="v">{total}</div><div class="s">所有找人任务累计</div>
          </a>
          <a class="panel stat" href={`/projects/${p.id}/kols?status=&email=yes`}>
            <div class="k">有邮箱</div><div class="v">{props.withEmail}</div><div class="s">占 {pct(props.withEmail, total)}</div>
          </a>
          <a class="panel stat" href={`/projects/${p.id}/kols?status=approved`}>
            <div class="k">已通过</div><div class="v">{counts.approved ?? 0}</div>
            <div class="s">已排除 {counts.rejected ?? 0} 人</div>
          </a>
          <div class="panel stat">
            <div class="k">累计花费</div><div class="v">{money(props.spent)}</div>
            <div class="s">{total ? `平均每人 $${(props.spent / total).toFixed(3)}` : "Apify 费用"}</div>
          </div>
        </div>

        {outreach.length > 0 && (
          <div class="panel"><div class="bd row">
            <b>联系进度</b>
            {outreach.map((s) => <a class="chip" href={`/projects/${p.id}/kols?status=${s}`}>{STATUS_NAMES[s]} {counts[s]}</a>)}
          </div></div>
        )}

        <div class="panel">
          <div class="hd"><h2>最近的找人任务</h2><a class="right small" href={`/projects/${p.id}/jobs`}>全部任务</a></div>
          {jobs.length === 0 ? (
            <div class="empty">
              <b>还没找过人</b>
              <p>填几个关键词或对标账号，平台会自动搜人、查邮箱，结果进审核名单。</p>
              <p style="margin-top:12px"><a class="btn primary" href={`/projects/${p.id}/jobs/new`}>开始第一次找人</a></p>
            </div>
          ) : <JobTable projectId={p.id} jobs={jobs} />}
        </div>
      </div>
    </>
  );
}

function JobTable(props: { projectId: number; jobs: JobRow[] }) {
  return (
    <table class="t">
      <tr><th>任务</th><th>找人条件</th><th>状态</th><th class="r">找到</th><th class="r">有邮箱</th><th class="r">新增待审</th>
        <th class="r">花费</th><th>提交</th></tr>
      {props.jobs.map((j) => {
        const href = `/projects/${props.projectId}/jobs/${j.id}`;
        return (
          <tr class="link" onclick={`location.href='${href}'`}>
            <td class="nowrap"><span class="row" style="gap:6px"><PlatformIcon platform={j.platform} /><a href={href}>#{j.id}</a></span></td>
            <td class="fg2" style="max-width:360px">{describeParams(j.params)}
              {j.message && <div class={`small ${j.status === "failed" ? "" : "muted"}`} style={j.status === "failed" ? "color:var(--bad)" : ""}>{j.message}</div>}
            </td>
            <td><JobBadge status={j.status} /></td>
            <td class="r num">{j.status === "done" ? j.found : "—"}</td>
            <td class="r num">{j.status === "done" ? <>{j.with_email} <span class="muted small">{pct(j.with_email, j.found)}</span></> : "—"}</td>
            <td class="r num">{j.status === "done" ? j.new_to_project : "—"}</td>
            <td class="r num">{money(j.spent_usd)}</td>
            <td class="muted small nowrap">{j.created_by} · {ago(j.created_at)}</td>
          </tr>
        );
      })}
    </table>
  );
}

// ------------------------------------------------------------ jobs

export function JobsPage(props: { project: Project; jobs: JobRow[] }) {
  const { project: p, jobs } = props;
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  return (
    <>
      <AutoRefresh when={active} />
      <div class="pagehead">
        <h1>找人任务</h1>
        <div class="actions"><a class="btn primary" href={`/projects/${p.id}/jobs/new`}>＋ 新建找人任务</a></div>
        <div class="sub">每个任务按条件搜一批人、查邮箱，新找到的人进「审核名单」。已在名单里的人不会重复花钱查。</div>
      </div>
      <div class="panel">
        {jobs.length === 0 ? (
          <div class="empty"><b>还没有任务</b><p><a href={`/projects/${p.id}/jobs/new`}>新建第一个找人任务</a></p></div>
        ) : <JobTable projectId={p.id} jobs={jobs} />}
      </div>
    </>
  );
}

export function JobPage(props: { project: Project; job: JobRow; runs: RunRow[]; pending: number }) {
  const { project: p, job, runs } = props;
  const params = job.params;
  const live = job.status === "queued" || job.status === "running";
  return (
    <>
      <AutoRefresh when={live} />
      <div class="pagehead">
        <PlatformIcon platform={job.platform} />
        <h1>{PLATFORM_NAMES[job.platform]} 找人任务 #{job.id}</h1>
        <JobBadge status={job.status} />
        <div class="actions">
          {props.pending > 0 && <a class="btn primary" href={`/projects/${p.id}/kols?job=${job.id}`}>审核这批 {props.pending} 人</a>}
          <a class="btn" href={`/projects/${p.id}/kols?status=&job=${job.id}`}>这次找到的所有人</a>
        </div>
        <div class="sub">{job.created_by} {ago(job.created_at)}提交{live ? " · 页面每 15 秒自动刷新" : ""}</div>
      </div>
      {job.message && <Flash text={job.status === "failed" ? `任务失败：${job.message}` : job.message} bad={job.status === "failed"} />}
      <div class="split">
        <div class="stack">
          <div class="grid g4">
            <div class="panel stat"><div class="k">找到</div><div class="v">{job.status === "done" ? job.found : "—"}</div>
              <div class="s">去掉不符合条件的</div></div>
            <div class="panel stat"><div class="k">有邮箱</div><div class="v">{job.status === "done" ? job.with_email : "—"}</div>
              <div class="s">{job.status === "done" ? `命中率 ${pct(job.with_email, job.found)}` : ""}</div></div>
            <div class="panel stat"><div class="k">新增待审核</div><div class="v">{job.status === "done" ? job.new_to_project : "—"}</div>
              <div class="s">名单里原来没有的</div></div>
            <div class="panel stat"><div class="k">花费</div><div class="v">{money(job.spent_usd)}</div>
              <div class="s">预算 {money(params.maxSpend)}</div></div>
          </div>
          <div class="panel">
            <div class="hd"><h2>进度</h2></div>
            <div class="bd"><StepList job={job} runs={runs} detail /></div>
          </div>
        </div>
        <div class="panel">
          <div class="hd"><h2>找人条件</h2></div>
          <div class="bd">
            <dl class="kv">
              <dt>关键词</dt><dd>{params.keywords.join("、") || "—"}</dd>
              {job.platform === "instagram" && <><dt>相似账号</dt><dd>{params.seeds.map((s) => `@${s}`).join("、") || "—"}</dd></>}
              <dt>已知账号</dt><dd>{params.handles.length ? `${params.handles.length} 个` : "—"}</dd>
              <dt>粉丝范围</dt><dd>{params.minFollowers ? compact(params.minFollowers) : "不限"} – {params.maxFollowers ? compact(params.maxFollowers) : "不限"}</dd>
              <dt>只要中文</dt><dd>{params.chineseOnly ? "是" : "否"}</dd>
              <dt>外链找邮箱</dt><dd>{params.linkPages ? "是" : "否"}</dd>
              {job.platform === "youtube" && <><dt>隐藏邮箱</dt><dd>{params.youtubeHidden ? "查" : "不查"}</dd></>}
              <dt>预算上限</dt><dd>{money(params.maxSpend)}</dd>
            </dl>
          </div>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------ new job

export function JobFormPage(props: { project: Project; error?: string }) {
  const p = props.project;
  const d = { ...DEFAULT_PARAMS, ...p.discovery };
  const prices = Object.fromEntries(Object.entries(ACTORS).map(([k, a]) => [k, { perItem: a.perItem, start: a.start }]));
  return (
    <>
      <div class="pagehead">
        <h1>找一批新 KOL</h1>
        <div class="sub">条件已按「项目设置」里的默认值填好。提交后在后台运行，完成后会发飞书通知。</div>
      </div>
      <Flash text={props.error} bad />
      <form method="post" action={`/projects/${p.id}/jobs`} id="job" data-platform="instagram">
        <div class="split">
          <div class="stack">
            <div class="panel">
              <div class="hd"><h2>1. 在哪个平台找</h2></div>
              <div class="bd">
                <div class="choice">
                  {PLATFORMS.map((k, i) => (
                    <label>
                      <input type="radio" name="platform" value={k} checked={i === 0} />
                      <span class="nm"><PlatformIcon platform={k} />{PLATFORM_NAMES[k]}</span>
                      <span class="ds">{PLATFORM_HINTS[k]}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div class="panel">
              <div class="hd"><h2>2. 怎么找</h2><span class="right muted small">三种方式至少填一种，可以组合</span></div>
              <div class="bd">
                <SearchFields d={d} />
                <label class="field">
                  <span class="lb">已知账号</span>
                  <textarea class="input" name="handles" placeholder={"已经有名单的话，直接粘贴账号或主页链接，每行一个"} />
                  <span class="hint">这些人不用搜，直接查邮箱。TikTok 建议用这种方式。</span>
                </label>
              </div>
            </div>
            <div class="panel">
              <div class="hd"><h2>3. 要什么样的人</h2></div>
              <div class="bd"><FilterFields d={d} /></div>
            </div>
          </div>
          <div class="sticky">
            <div class="panel">
              <div class="hd"><h2>预计</h2></div>
              <div class="bd">
                <dl class="kv" style="margin-bottom:14px">
                  <dt>最多搜到</dt><dd><b id="est-n" class="num">—</b> 人</dd>
                  <dt>预计花费</dt><dd><b id="est-cost" class="num">—</b></dd>
                </dl>
                <label class="field">
                  <span class="lb">预算上限（美元）</span>
                  <input class="input" type="number" step="0.5" min="0.5" max="200" name="maxSpend" value={String(d.maxSpend)} />
                  <span class="hint">花到上限就停，已经找到的人照样保存。</span>
                </label>
                <p id="est-warn" class="small" style="color:var(--warn);margin-top:10px" hidden>预计花费超过预算，后面的步骤可能跑不完。</p>
                <p style="margin-top:16px"><button class="btn primary block lg">开始找人</button></p>
                <p class="muted small" style="margin-top:8px">按 Apify 当前价格粗算，实际以运行记录为准。</p>
              </div>
            </div>
          </div>
        </div>
      </form>
      <script dangerouslySetInnerHTML={{ __html: `const PRICES=${JSON.stringify(prices)};${JOB_FORM_JS}` }} />
    </>
  );
}

/** Keywords and seed accounts: shared by the new-job form and project defaults. */
function SearchFields(props: { d: Omit<DiscoveryParams, "platform"> }) {
  const d = props.d;
  return (
    <>
      <label class="field">
        <span class="lb">关键词</span>
        <textarea class="input" name="keywords" placeholder={"每行一个，例如：\n新秘\n親子"}>{d.keywords.join("\n")}</textarea>
        <span class="hint">短词效果更好，用目标地区的写法（台湾用繁体）。</span>
      </label>
      <label class="field" data-only="instagram">
        <span class="lb">对标账号 <span class="badge">只用于 Instagram</span></span>
        <textarea class="input" name="seeds" placeholder={"找跟这些账号相似的人，每行一个"}>{d.seeds.join("\n")}</textarea>
        <span class="hint">Instagram 最好用的找人方式：给几个理想的 KOL，平台找跟他们相似的账号。</span>
      </label>
    </>
  );
}

/** Follower range, language and email options: shared by the new-job form and project defaults. */
function FilterFields(props: { d: Omit<DiscoveryParams, "platform">; all?: boolean }) {
  const d = props.d;
  const presets: [string, string, string][] = [["不限", "", ""], ["1千–1万", "1000", "10000"], ["1万–10万", "10000", "100000"],
                                               ["10万以上", "100000", ""]];
  return (
    <>
      <div class="field">
        <span class="lb">粉丝数</span>
        <div class="chips" style="margin-bottom:8px">
          {presets.map(([label, min, max]) => (
            <button type="button" class="chip" data-min={min} data-max={max}>{label}</button>
          ))}
        </div>
        <div class="row">
          <input class="input w-m" type="number" name="minFollowers" value={d.minFollowers?.toString() ?? ""} placeholder="最少" />
          <span class="muted">到</span>
          <input class="input w-m" type="number" name="maxFollowers" value={d.maxFollowers?.toString() ?? ""} placeholder="最多" />
        </div>
      </div>
      <div class="field">
        <span class="lb">筛选和查邮箱</span>
        <label class="check"><input type="checkbox" name="chineseOnly" checked={d.chineseOnly} />
          <span>只要中文账号<span class="t2">名字或简介里没有中文的不要</span></span></label>
        <label class="check"><input type="checkbox" name="linkPages" checked={d.linkPages} />
          <span>打开简介里的外链找邮箱<span class="t2">Linktree、个人网站等。多找到一些邮箱，每个页面约 $0.01</span></span></label>
        <label class="check" data-only="youtube"><input type="checkbox" name="youtubeHidden" checked={d.youtubeHidden} />
          <span>查 YouTube 隐藏商务邮箱{props.all ? "（只用于 YouTube）" : ""}<span class="t2">命中率高但贵，找到一个约 $0.12，只查前面步骤没找到邮箱的人</span></span></label>
      </div>
      <details class="more field">
        <summary>更多设置</summary>
        <div class="bd">
          <div class="grid g2">
            <label class="field" style="margin:0"><span class="lb">每个关键词最多搜</span>
              <input class="input" type="number" name="perKeyword" value={String(d.perKeyword)} /></label>
            <label class="field" style="margin:0" data-only="instagram"><span class="lb">每个对标账号最多找</span>
              <input class="input" type="number" name="perSeed" value={String(d.perSeed)} /></label>
            <label class="field" style="margin:0" data-only="youtube"><span class="lb">YouTube 搜索地区</span>
              <input class="input" type="text" name="country" value={d.country} placeholder="TW" />
              <span class="hint">两位国家代码，例如 TW、HK、US</span></label>
            <label class="field" style="margin:0" data-only="youtube"><span class="lb">YouTube 搜索语言</span>
              <input class="input" type="text" name="ytLanguage" value={d.language} placeholder="zh" /></label>
          </div>
        </div>
      </details>
    </>
  );
}

// Platform-specific fields, follower presets and a rough cost estimate. Mirrors the pipeline's step order.
const JOB_FORM_JS = `
(() => {
  const f = document.getElementById('job');
  const val = (n) => f.elements[n];
  const lines = (n) => val(n) ? val(n).value.split(/[\\n,，、;；]+/).map(s => s.trim()).filter(Boolean).length : 0;
  const num = (n, dft) => { const v = Number(val(n)?.value); return Number.isFinite(v) && v > 0 ? v : dft; };
  const cost = (k, n) => PRICES[k].start + PRICES[k].perItem * n;
  function update() {
    const pf = f.querySelector('input[name=platform]:checked').value;
    f.dataset.platform = pf;
    const kw = lines('keywords'), seeds = pf === 'instagram' ? lines('seeds') : 0, known = lines('handles');
    const perKw = num('perKeyword', 50), perSeed = num('perSeed', 150);
    const n = kw * perKw + seeds * perSeed + known;
    let usd = 0;
    if (pf === 'instagram') usd = cost('ig_related', seeds * perSeed) * (seeds ? 1 : 0) + (kw ? cost('ig_search', kw * perKw) : 0) + cost('ig_email', n);
    else if (pf === 'youtube') usd = (kw ? cost('yt_search', kw * perKw) : 0) + cost('yt_profile', n) + (val('youtubeHidden').checked ? n * 0.5 * PRICES.yt_hidden.perItem : 0);
    else usd = (kw ? cost('tt_search', kw * perKw) : 0) + cost('tt_profile', n);
    if (val('linkPages').checked) usd += n * 0.4 * PRICES.link_pages.perItem;
    document.getElementById('est-n').textContent = n.toLocaleString();
    document.getElementById('est-cost').textContent = n ? '约 $' + usd.toFixed(2) : '—';
    document.getElementById('est-warn').hidden = !(usd > num('maxSpend', 10));
  }
  f.addEventListener('input', update);
  f.addEventListener('change', update);
  f.querySelectorAll('.chip[data-min]').forEach(b => b.addEventListener('click', () => {
    val('minFollowers').value = b.dataset.min; val('maxFollowers').value = b.dataset.max; update();
  }));
  update();
})();
`;

// ------------------------------------------------------------ KOL review

export function KolsPage(props: {
  project: Project; rows: KolRow[]; filters: ListFilters; counts: Record<string, number>; total: number; page: number;
  jobs: { id: number; platform: string; created_at: Date }[]; flash?: string;
}) {
  const { project: p, rows, filters: f, counts } = props;
  const all = Object.values(counts).reduce((a, b) => a + b, 0);
  const link = (change: Partial<ListFilters> & { page?: number }) => {
    const next: Record<string, string> = { ...f, ...(change as any), page: String(change.page ?? "") };
    const qs = new URLSearchParams(Object.entries(next).filter(([k, v]) => v || k === "status"));
    return `/projects/${p.id}/kols?${qs}`;
  };
  const exportQs = new URLSearchParams(Object.entries(f).filter(([k, v]) => v || k === "status"));
  const tabs = ["candidate", "approved", "rejected", ...["contacted", "replied", "agreed", "declined"].filter((s) => counts[s])];
  const pages = Math.max(1, Math.ceil(props.total / PAGE_SIZE));
  const hasFilter = f.platform || f.email || f.q || f.job;
  return (
    <>
      <div class="pagehead">
        <h1>审核名单</h1>
        <div class="actions">
          <a class="btn" href={`/projects/${p.id}/kols.csv?${exportQs}`}>导出 Excel（CSV）</a>
          <a class="btn primary" href={`/projects/${p.id}/jobs/new`}>＋ 找一批新 KOL</a>
        </div>
      </div>
      <Flash text={props.flash} />
      <div class="panel">
        <nav class="tabs" style="padding:0 6px;border-bottom:1px solid var(--line2);margin:0;max-width:none">
          {tabs.map((s) => (
            <a href={link({ status: s })} class={f.status === s ? "on" : ""}>
              {STATUS_NAMES[s]}<span class="badge count" data-count={s}>{counts[s] ?? 0}</span>
            </a>
          ))}
          <a href={link({ status: "" })} class={f.status === "" ? "on" : ""}>全部<span class="badge count">{all}</span></a>
        </nav>
        <form method="get" class="toolbar">
          <input type="hidden" name="status" value={f.status} />
          {f.job && <input type="hidden" name="job" value={f.job} />}
          <div class="chips">
            <a class={`chip ${!f.platform ? "on" : ""}`} href={link({ platform: "" })}>全部平台</a>
            {PLATFORMS.map((k) => (
              <a class={`chip ${f.platform === k ? "on" : ""}`} href={link({ platform: k })}><PlatformIcon platform={k} />{PLATFORM_NAMES[k]}</a>
            ))}
          </div>
          <div class="chips">
            <a class={`chip ${f.email === "yes" ? "on" : ""}`} href={link({ email: f.email === "yes" ? "" : "yes" })}>只看有邮箱</a>
            <a class={`chip ${f.email === "no" ? "on" : ""}`} href={link({ email: f.email === "no" ? "" : "no" })}>只看没邮箱</a>
            {f.job && <a class="chip on" href={link({ job: "" })} title="去掉这个条件">任务 #{f.job} ✕</a>}
          </div>
          {!f.job && props.jobs.length > 0 && (
            <select class="input" style="width:auto" name="job" onchange="this.form.submit()">
              <option value="">所有任务</option>
              {props.jobs.map((j) => <option value={String(j.id)}>任务 #{j.id} · {PLATFORM_NAMES[j.platform]} · {ago(j.created_at)}</option>)}
            </select>
          )}
          <div class="spacer" />
          <input class="input w-m" type="search" name="q" value={f.q} placeholder="搜账号、名字、简介" />
          {f.platform && <input type="hidden" name="platform" value={f.platform} />}
          {f.email && <input type="hidden" name="email" value={f.email} />}
        </form>
        {rows.length === 0 ? (
          <div class="empty">
            {f.status === "candidate" && !hasFilter && all > 0 ? (
              <><b>都审完了 🎉</b><p>没有待审核的人。可以 <a href={`/projects/${p.id}/jobs/new`}>再找一批</a>，或 <a href={link({ status: "approved" })}>看已通过的名单</a>。</p></>
            ) : all === 0 ? (
              <><b>名单还是空的</b><p><a href={`/projects/${p.id}/jobs/new`}>新建找人任务</a>，找到的人会出现在这里。</p></>
            ) : <><b>没有符合条件的人</b><p><a href={`/projects/${p.id}/kols?status=${f.status}`}>清除筛选</a></p></>}
          </div>
        ) : (
          <>
            <div class="kol-head">
              <span><input type="checkbox" id="all" title="全选本页" /></span><span />
              <span>KOL</span><span>简介</span><span>邮箱</span><span style="text-align:right">操作</span>
            </div>
            <div id="list">
              {rows.map((r) => <KolItem r={r} />)}
            </div>
            {pages > 1 && (
              <div class="pager">
                {props.page > 1 && <a class="btn sm" href={link({ page: props.page - 1 })}>上一页</a>}
                <span class="muted small">第 {props.page} / {pages} 页，共 {props.total} 人</span>
                {props.page < pages && <a class="btn sm" href={link({ page: props.page + 1 })}>下一页</a>}
              </div>
            )}
          </>
        )}
      </div>
      {rows.length > 0 && (
        <p class="keys" style="margin-top:12px">
          快捷键：<kbd>J</kbd> <kbd>K</kbd> 上下移动 · <kbd>A</kbd> 通过 · <kbd>X</kbd> 排除 · <kbd>空格</kbd> 勾选 · <kbd>O</kbd> 打开主页
        </p>
      )}
      <div class="bulkbar" id="bulk">
        <span>已选 <b id="bulk-n">0</b> 人</span>
        <button class="btn sm" data-bulk="approved">✓ 全部通过</button>
        <button class="btn sm" data-bulk="rejected">✕ 全部排除</button>
        <button class="btn sm" data-bulk="candidate">退回待审核</button>
        <button class="btn sm" data-bulk="">取消</button>
      </div>
      <div class="toast" id="toast"><span id="toast-t" /><button id="toast-undo">撤销</button></div>
      <script dangerouslySetInnerHTML={{
        __html: `const REVIEW_URL=${JSON.stringify(`/projects/${p.id}/kols/review`)},FILTER_STATUS=${JSON.stringify(f.status)},
          STATUS_NAMES=${JSON.stringify(STATUS_NAMES)};${REVIEW_JS}`,
      }} />
    </>
  );
}

function KolItem(props: { r: KolRow }) {
  const r = props.r;
  const reviewable = ["candidate", "approved", "rejected"].includes(r.status);
  return (
    <div class="kol" data-id={String(r.kol_id)} data-status={r.status} data-url={r.profile_url} data-name={r.name || r.handle} tabindex={-1}>
      <div class="sel"><input type="checkbox" class="pick" value={String(r.kol_id)} /></div>
      <Avatar name={r.name || r.handle} seed={r.kol_id} />
      <div style="min-width:0">
        <div class="who1"><PlatformIcon platform={r.platform} /><b title={r.name}>{r.name || r.handle}</b></div>
        <a class="handle" href={r.profile_url} target="_blank" rel="noreferrer">@{r.handle} ↗</a>
        <div class="fol"><b>{compact(r.followers)}</b> <span class="muted">粉丝</span>
          {r.is_business && <span class="badge" style="margin-left:6px">商业号</span>}</div>
      </div>
      <div class="c-bio" style="min-width:0">
        <div class="bio">{r.bio || <span class="muted">没有简介</span>}</div>
        <div class="src">
          来源：{sourceLabel(r.discovered_by)}
          {r.external_url && <> · <a href={r.external_url} target="_blank" rel="noreferrer">简介外链 ↗</a></>}
        </div>
      </div>
      <div class="c-mail" style="min-width:0">
        {r.emails.length ? r.emails.map((e) => (
          <div class="mail" title={`${SOURCE_NAMES[e.source] ?? e.source} · ${CHECK_NAMES[e.check_status] ?? e.check_status}`}>
            <span class={`ck ${e.check_status}`} />
            <span class="addr">{e.email}</span>
            <span class="badge" style="height:18px;font-size:11px">{SOURCE_NAMES[e.source] ?? e.source}</span>
          </div>
        )) : <span class="nomail">没找到邮箱</span>}
        {r.blocked && <div class="badge bad" style="margin-top:6px">在禁止联系名单里</div>}
      </div>
      <div class="c-act">
        {reviewable ? (
          <div class="acts">
            {r.status !== "approved" && <button type="button" class="btn sm ok" data-act="approved">✓ 通过</button>}
            {r.status !== "rejected" && <button type="button" class="btn sm bad" data-act="rejected">✕ 排除</button>}
            {r.status !== "candidate" && <button type="button" class="btn sm ghost" data-act="candidate">退回</button>}
          </div>
        ) : null}
        <div class="state">
          {r.status !== "candidate" && <span class="badge">{STATUS_NAMES[r.status]}</span>}
          {r.reviewed_by && <div>{r.reviewed_by} · {ago(r.reviewed_at)}</div>}
        </div>
      </div>
    </div>
  );
}

// One-click review with undo, keyboard review and bulk actions. Plain fetch to the same form endpoint.
const REVIEW_JS = `
(() => {
  const list = document.getElementById('list');
  if (!list) return;
  const rows = () => [...list.querySelectorAll('.kol:not(.gone)')];
  let cur = -1;
  function focus(i) {
    const rs = rows(); if (!rs.length) return;
    cur = Math.max(0, Math.min(i, rs.length - 1));
    rs.forEach((r, j) => r.classList.toggle('focus', j === cur));
    rs[cur].scrollIntoView({ block: 'nearest' });
  }
  async function post(action, ids) {
    const body = new URLSearchParams({ action }); ids.forEach(id => body.append('ids', id));
    const res = await fetch(REVIEW_URL, { method: 'POST', body, headers: { accept: 'application/json' } });
    if (!res.ok) { alert('保存失败，请刷新页面再试'); throw new Error(res.status); }
    const data = await res.json();
    document.querySelectorAll('[data-count]').forEach(el => el.textContent = data.counts[el.dataset.count] || 0);
    return data;
  }
  const toast = document.getElementById('toast'); let toastTimer, undo;
  function say(text, undoFn) {
    document.getElementById('toast-t').textContent = text; undo = undoFn;
    toast.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('on'), 6000);
  }
  document.getElementById('toast-undo').onclick = async () => {
    toast.classList.remove('on'); if (undo) { await undo(); location.reload(); }
  };
  async function act(els, action) {
    if (!els.length) return;
    const before = els.map(el => [el.dataset.id, el.dataset.status]);
    await post(action, before.map(b => b[0]));
    const leaves = FILTER_STATUS && FILTER_STATUS !== action;
    els.forEach(el => {
      el.dataset.status = action;
      if (leaves) { el.classList.add('gone'); setTimeout(() => el.remove(), 250); }
      else location.reload();
    });
    const who = els.length === 1 ? els[0].dataset.name : els.length + ' 人';
    say(who + ' 已' + (action === 'candidate' ? '退回待审核' : STATUS_NAMES[action].replace('已', '')), async () => {
      const groups = {}; before.forEach(([id, st]) => (groups[st] = groups[st] || []).push(id));
      for (const st in groups) await post(st, groups[st]);
    });
    syncBulk();
    if (leaves) setTimeout(() => { if (!rows().length) location.reload(); else focus(Math.min(cur, rows().length - 1)); }, 260);
  }
  list.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const row = b.closest('.kol'); cur = rows().indexOf(row); act([row], b.dataset.act);
  });
  list.addEventListener('click', e => {
    const row = e.target.closest('.kol');
    if (row && !e.target.closest('a,button,input')) { focus(rows().indexOf(row)); }
  });
  const bulk = document.getElementById('bulk');
  const picked = () => [...list.querySelectorAll('.pick:checked')].map(c => c.closest('.kol'));
  function syncBulk() {
    const n = picked().length; document.getElementById('bulk-n').textContent = n; bulk.classList.toggle('on', n > 0);
  }
  list.addEventListener('change', syncBulk);
  const all = document.getElementById('all');
  if (all) all.addEventListener('change', () => { list.querySelectorAll('.pick').forEach(c => c.checked = all.checked); syncBulk(); });
  bulk.addEventListener('click', e => {
    const b = e.target.closest('[data-bulk]'); if (!b) return;
    if (!b.dataset.bulk) { list.querySelectorAll('.pick').forEach(c => c.checked = false); if (all) all.checked = false; syncBulk(); return; }
    act(picked(), b.dataset.bulk);
  });
  document.addEventListener('keydown', e => {
    if (e.target.closest('input,textarea,select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase(), row = rows()[cur];
    if (k === 'j' || e.key === 'ArrowDown') { focus(cur + 1); e.preventDefault(); }
    else if (k === 'k' || e.key === 'ArrowUp') { focus(cur - 1); e.preventDefault(); }
    else if (k === 'a' && row && row.querySelector('[data-act=approved]')) act([row], 'approved');
    else if (k === 'x' && row && row.querySelector('[data-act=rejected]')) act([row], 'rejected');
    else if (k === ' ' && row) { const c = row.querySelector('.pick'); c.checked = !c.checked; syncBulk(); e.preventDefault(); }
    else if (k === 'o' && row && row.dataset.url) window.open(row.dataset.url, '_blank');
  });
})();
`;

// ------------------------------------------------------------ project settings

export function ProjectForm(props: { project?: Project; error?: string; flash?: string }) {
  const p = props.project;
  const d = { ...DEFAULT_PARAMS, ...(p?.discovery ?? {}) };
  return (
    <>
      <div class="pagehead">
        <h1>{p ? "项目设置" : "新建项目"}</h1>
        <div class="sub">{p ? "这里的找人条件会作为新建任务时的默认值。" : "每个项目有自己的地区、找人条件和审核名单；KOL 总库所有项目共用。"}</div>
      </div>
      <Flash text={props.error} bad />
      <Flash text={props.flash} />
      <form method="post" action={p ? `/projects/${p.id}/settings` : "/projects"} id="project" data-platform="all">
        <div class="split">
          <div class="stack">
            <div class="panel">
              <div class="hd"><h2>基本信息</h2></div>
              <div class="bd">
                <div class="grid g2">
                  <label class="field" style="margin:0"><span class="lb">项目名称</span>
                    <input class="input" type="text" name="name" value={p?.name} required placeholder="例如：TAFU 台湾" /></label>
                  {p ? (
                    <div class="field" style="margin:0"><span class="lb">英文代号</span>
                      <div class="input" style="background:var(--line2);display:flex;align-items:center">{p.slug}</div>
                      <span class="hint">导出文件名用，建好后不能改</span></div>
                  ) : (
                    <label class="field" style="margin:0"><span class="lb">英文代号</span>
                      <input class="input" type="text" name="slug" required placeholder="tafu-tw" pattern="[a-z0-9][a-z0-9\-]{1,40}" />
                      <span class="hint">小写字母、数字、横线，建好后不能改</span></label>
                  )}
                  <label class="field" style="margin:0"><span class="lb">目标地区</span>
                    <input class="input" type="text" name="region" value={p?.region} placeholder="台湾" /></label>
                  <label class="field" style="margin:0"><span class="lb">沟通语言</span>
                    <input class="input" type="text" name="language" value={p?.language} placeholder="繁体中文" /></label>
                </div>
                <label class="field"><span class="lb">审核人</span>
                  <input class="input" type="text" name="reviewers" value={p?.reviewers.join("，")} placeholder="多个人用逗号分隔" /></label>
              </div>
            </div>
            <div class="panel">
              <div class="hd"><h2>默认找人条件</h2><span class="right muted small">新建任务时预先填好，每次还能改</span></div>
              <div class="bd">
                <SearchFields d={d} />
                <div style="margin-top:16px"><FilterFields d={d} all /></div>
                <label class="field"><span class="lb">每次预算上限（美元）</span>
                  <input class="input w-m" type="number" step="0.5" name="maxSpend" value={String(d.maxSpend)} /></label>
              </div>
            </div>
            <div class="panel">
              <div class="hd"><h2>写信设置</h2><span class="badge">后面的阶段才用到</span></div>
              <div class="bd">
                <label class="field"><span class="lb">品牌介绍</span>
                  <textarea class="input" name="brand_brief" placeholder="写信时介绍品牌用：做什么、卖点、合作方式">{p?.brand_brief}</textarea></label>
                <label class="field"><span class="lb">写信要求</span>
                  <textarea class="input" name="writing_guide" placeholder="语气、长度、必须提到或不能说的内容">{p?.writing_guide}</textarea></label>
              </div>
            </div>
          </div>
          <div class="sticky stack">
            <div class="panel">
              <div class="hd"><h2>飞书通知</h2></div>
              <div class="bd">
                <label class="field"><span class="lb">群机器人 Webhook</span>
                  <input class="input" type="text" name="feishu_webhook" value={p?.feishu_webhook} placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
                  <span class="hint">找人任务完成或失败时发到这个群。群设置 → 群机器人 → 添加自定义机器人；安全设置选「自定义关键词」填 KOL。</span></label>
                {p && <p style="margin-top:10px"><button class="btn sm" form="notify-test">发一条测试通知</button></p>}
              </div>
            </div>
            <button class="btn primary block lg">{p ? "保存设置" : "创建项目"}</button>
          </div>
        </div>
      </form>
      {p && <form method="post" action={`/projects/${p.id}/test-notify`} id="notify-test" />}
      <script dangerouslySetInnerHTML={{
        __html: `document.querySelectorAll('.chip[data-min]').forEach(b => b.addEventListener('click', () => {
          const f = b.form; f.elements.minFollowers.value = b.dataset.min; f.elements.maxFollowers.value = b.dataset.max; }));`,
      }} />
    </>
  );
}
