/**
 * The console's background agent: work the console hands over (draft a reply, rewrite after 让它改, judge an
 * unmatched mail or a bounce, handle an expiring code, ask about a missed post, draft a template) runs through the
 * local command-line agent on the operator's own subscription — `claude -p` by default, `codex exec` if set.
 * Each job is one local session that can be opened and continued later (its id is kept on the job).
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { home, type AgentCommand } from "./config.js";
import { addLog, type Ctx, type Project } from "./ctx.js";
import { one } from "./db/db.js";

export interface AgentRun {
  ok: boolean;
  sessionId: string;
  output: string;
}

/** What the runner needs from an agent; tests swap in a fake. */
export type AgentExec = (o: { prompt: string; mcpUrl: string; resume?: string; cmd: AgentCommand }) => Promise<AgentRun>;

/** The agent runs with a clean environment: no API keys or session markers leaking in from wherever kolpick was started. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_AGENT_SDK|OPENAI_BASE_URL$)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export function agentDir(): string {
  const dir = join(home(), "agent");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The command line for one run; also shown in the console so the operator can resume a session by hand. */
export function agentArgs(cmd: AgentCommand, prompt: string, mcpUrl: string, resume?: string): { bin: string; args: string[] } {
  if (cmd.kind === "codex") {
    const conf = ["-c", `mcp_servers.kolpick.url="${mcpUrl}"`, "-c", 'mcp_servers.kolpick.default_tools_approval_mode="approve"', "-c", 'approval_policy="never"'];
    const args = resume
      ? ["exec", "resume", "--json", "--skip-git-repo-check", ...conf, ...(cmd.args ?? []), resume, prompt]
      : ["exec", "--json", "--skip-git-repo-check", "-s", "read-only", ...conf, ...(cmd.args ?? []), prompt];
    return { bin: cmd.bin || "codex", args };
  }
  const mcp = JSON.stringify({ mcpServers: { kolpick: { type: "http", url: mcpUrl } } });
  // The operator's ~/.claude/settings.json may point claude at a relay with its own key; skip it so the run uses their subscription.
  const args = ["-p", prompt, "--setting-sources", "project,local", "--mcp-config", mcp, "--strict-mcp-config", "--allowedTools", "mcp__kolpick",
    // --allowedTools only pre-approves; the agent works on mail from strangers, so it gets nothing but kolpick.
    "--disallowedTools", "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch", "--output-format", "json", ...(cmd.args ?? [])];
  if (resume) args.push("--resume", resume);
  return { bin: cmd.bin || "claude", args };
}

export const runAgent: AgentExec = ({ prompt, mcpUrl, resume, cmd }) => new Promise((resolve) => {
  const { bin, args } = agentArgs(cmd, prompt, mcpUrl, resume);
  const child = spawn(bin, args, { cwd: agentDir(), env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
  const timer = setTimeout(() => child.kill(), 15 * 60_000);
  child.on("error", (e) => {
    clearTimeout(timer);
    resolve({ ok: false, sessionId: "", output: `启动 ${bin} 失败：${e.message}` });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (cmd.kind === "codex") {
      let sessionId = resume ?? "", last = "";
      for (const line of out.split("\n")) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "thread.started") sessionId = ev.thread_id;
          if (ev.type === "item.completed" && ev.item?.type === "agent_message") last = ev.item.text;
        } catch {}
      }
      resolve({ ok: code === 0, sessionId, output: last || err.slice(-1000) });
      return;
    }
    try {
      const j = JSON.parse(out);
      resolve({ ok: code === 0 && !j.is_error, sessionId: j.session_id ?? "", output: String(j.result ?? "") });
    } catch {
      resolve({ ok: false, sessionId: "", output: (out || err).slice(-1000) });
    }
  });
});

/** The task text for each kind of job. The agent reads the rules with `guide` and does the rest with the tools. */
export async function promptFor(ctx: Ctx, p: Project, job: any): Promise<string> {
  const head = `你是 kolpick 的后台 agent，在给项目「${p.name}」干活，这是后台任务 #${job.id}。先调用 guide 读规则。只用 kolpick 的工具；你交的卡片都要等运营在决策台同意。`
    + `做完调用 job_done(job_id=${job.id}, note=一句话说明)；做不了或拿不准就调用 job_stuck(job_id=${job.id}, reason=原因)。\n\n`;
  const input = job.input ?? {};
  switch (job.kind) {
    case "reply":
      return head + `KOL #${job.kol_id} 来了一封信（来信编号 ${job.message_id}）。用 kol_get 看 TA 的资料和来往，`
        + `起草回复：draft_mail(kind="reply", kol_id=${job.kol_id}, in_reply_to=${job.message_id}, proposal_id=${job.proposal_id}, ...)。`
        + `同一位 KOL 还有别的没回的来信，就在这一封里一起回。不用回就 draft_decision(kind="no_reply", kol_id=${job.kol_id}, message_id=${job.message_id})。`;
    case "revise": {
      const card = await one<any>(ctx.db, "select * from proposals where id = $1", [job.proposal_id]);
      if (card?.kind === "template") {
        return head + `运营对模板卡片 #${job.proposal_id}（模板编号 ${card.action?.template_id}）说：「${input.feedback}」。用 templates 看现在的版本，按意见用 draft_template(template_id=${card.action?.template_id}, ...) 重写。`;
      }
      return head + `运营对卡片 #${job.proposal_id}（KOL #${job.kol_id}）说：「${input.feedback}」。用 proposals(status="drafting") 和 kol_get 看原稿和来往，`
        + `按意见重写，用 draft_mail(proposal_id=${job.proposal_id}, kol_id=${job.kol_id}, kind="${card?.kind ?? "reply"}"${card?.in_reply_to ? `, in_reply_to=${card.in_reply_to}` : ""}, ...) 交回。`;
    }
    case "unmatched":
      return head + `来信 #${job.message_id} 的发件人对不上任何 KOL。用 query 读这封信（select * from messages where id=${job.message_id}），用 kol_search 找可能是谁（名字、换了邮箱、经纪人），`
        + `然后 draft_decision(kind="unmatched", message_id=${job.message_id}, match_kol_id=找到的人或不写, why=依据)。`;
    case "bounce":
      return head + `来信 #${job.message_id} 是退信${job.kol_id ? `，退的是 KOL #${job.kol_id} 的信` : ""}。读这封退信，判断是邮箱无效（bounce="close"，结案）还是临时问题（bounce="clear"），`
        + `draft_decision(kind="bounce", message_id=${job.message_id}${job.kol_id ? `, kol_id=${job.kol_id}` : ""}, bounce=..., why=...)。KOL 有别的邮箱可以在 why 里提。`;
    case "code_expiry":
      return head + `KOL #${job.kol_id} 的体验码 ${input.code} 快到期或刚到期。用 kol_get 看用量和来往，判断：延期（draft_mail kind="code_expiry"，code={type:"trial_extend"}）、`
        + `换码、还是收尾（写一封收尾信，或 draft_decision kind="close"）。设置里的体验码规则用 settings_get 看。`;
    case "checkin":
      return head + `KOL #${job.kol_id} 约好的发布日期过了，还没找到帖子。用 kol_get 看约定，起草一封客气的问询：draft_mail(kind="checkin", kol_id=${job.kol_id}, ...)。`;
    case "template":
      return head + `运营要改模板：「${input.feedback}」${input.template_id ? `（模板编号 ${input.template_id}）` : ""}。用 templates 看现有模板，用 draft_template 交新版。`;
    case "ask":
      return head + String(input.text ?? "");
    default:
      return head + `任务类型 ${job.kind}，输入：${JSON.stringify(input)}。`;
  }
}

/** A reply job holds the KOL's one mail slot from the start, so the console shows "being drafted". */
async function reserveReplyCard(ctx: Ctx, p: Project, job: any): Promise<number | null> {
  if (job.kind !== "reply") return job.proposal_id ?? null;
  const open = await one<{ id: number; status: string }>(ctx.db,
    "select id, status from proposals where project_id = $1 and kol_id = $2 and to_addr is not null and status in ('drafting','pending','approved','running','unknown')", [p.id, job.kol_id]);
  if (open) return open.status === "drafting" || open.status === "pending" ? open.id : null;
  const m = await one<any>(ctx.db, "select * from messages where id = $1", [job.message_id]);
  if (!m) return null;
  const kol = await one<any>(ctx.db, "select name from kols where id = $1", [job.kol_id]);
  const r = await one<{ id: number }>(ctx.db,
    `insert into proposals (project_id, kind, status, kol_id, title, mailbox, to_addr, subject, body, in_reply_to, content_hash)
     values ($1, 'reply', 'drafting', $2, $3, $4, $5, $6, '', $7, '') returning id`,
    [p.id, job.kol_id, `回 ${kol?.name ?? ""}`, m.mailbox, m.from_addr, m.subject ? `Re: ${m.subject.replace(/^\s*(re|回复|回覆)\s*[:：]\s*/i, "")}` : null, m.id]);
  return r!.id;
}

// Claims go one at a time within this process, so two workers never both take a job for the same KOL.
let claiming: Promise<unknown> = Promise.resolve();
function claimJob(ctx: Ctx, p: Project): Promise<any> {
  const r = claiming.then(() => one<any>(ctx.db,
    `update agent_jobs set status='running', started_at=now() where id = (
       select j.id from agent_jobs j where j.project_id=$1 and j.status='queued'
         and (j.kol_id is null or not exists (select 1 from agent_jobs r where r.kol_id = j.kol_id and r.status = 'running'))
       order by j.id limit 1 for update skip locked) returning *`, [p.id]));
  claiming = r.catch(() => {});
  return r;
}

/**
 * Runs queued jobs with `parallel` workers until none are left; a KOL's jobs still run one after another. Returns how
 * many ran. A job the agent leaves without calling job_done or job_stuck is marked stuck, and an empty card it was
 * meant to fill is withdrawn.
 */
export async function runJobs(ctx: Ctx, p: Project, mcpUrl: string, exec: AgentExec = runAgent, max = 20, parallel = 1): Promise<number> {
  let ran = 0;
  const worker = async () => {
    while (ran < max) {
      const job = await claimJob(ctx, p);
      if (!job) return;
      ran++;
      await runJob(ctx, p, mcpUrl, exec, job);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  return ran;
}

async function runJob(ctx: Ctx, p: Project, mcpUrl: string, exec: AgentExec, job: any): Promise<void> {
  try {
    job.proposal_id = await reserveReplyCard(ctx, p, job);
    if (job.proposal_id) await ctx.db.query("update agent_jobs set proposal_id=$2 where id=$1", [job.id, job.proposal_id]);
    const prompt = await promptFor(ctx, p, job);
    const res = await exec({ prompt, mcpUrl: `${mcpUrl}?who=agent-job-${job.id}`, cmd: ctx.cfg.agent });
    await ctx.db.query("update agent_jobs set agent=$2, session_id=$3, output=coalesce(output, $4) where id=$1", [job.id, ctx.cfg.agent.kind, res.sessionId, res.output.slice(0, 4000)]);
    const after = await one<any>(ctx.db, "select status from agent_jobs where id=$1", [job.id]);
    if (after?.status === "running") {
      await ctx.db.query("update agent_jobs set status='stuck', error=$2, finished_at=now() where id=$1",
        [job.id, res.ok ? "agent 结束了但没说做完（没调用 job_done）" : `agent 出错：${res.output.slice(0, 500)}`]);
    }
  } catch (err: any) {
    await ctx.db.query("update agent_jobs set status='stuck', error=$2, finished_at=now() where id=$1", [job.id, String(err?.message ?? err)]);
  }
  // A reply card the agent never filled goes away, so it doesn't block the KOL's mail slot.
  if (job.proposal_id) await ctx.db.query("update proposals set status='dropped', result='agent 没写成', done_at=now() where id=$1 and status='drafting' and body = ''", [job.proposal_id]);
  const final = await one<any>(ctx.db, "select status, error, output from agent_jobs where id=$1", [job.id]);
  if (final?.status === "stuck") await addLog(ctx, p, { kind: "agent_stuck", who: "agent", kolId: job.kol_id, summary: `后台任务 #${job.id}（${job.kind}）卡住：${final.error}` });
}

/** Continue a job's session with a new instruction (the console's "接着聊"). */
export async function continueJob(ctx: Ctx, p: Project, jobId: number, text: string, mcpUrl: string, exec: AgentExec = runAgent): Promise<AgentRun> {
  const job = await one<any>(ctx.db, "select * from agent_jobs where id=$1 and project_id=$2", [jobId, p.id]);
  if (!job?.session_id) throw new Error("这个任务没有可接着聊的会话");
  return exec({ prompt: text, mcpUrl: `${mcpUrl}?who=agent-job-${job.id}`, resume: job.session_id, cmd: { ...ctx.cfg.agent, kind: job.agent ?? ctx.cfg.agent.kind } });
}
