import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Platform } from "../discovery/models.js";
import { Base } from "./base.js";
import { loadConfig } from "./config.js";
import { makeCtx, type Ctx } from "./ctx.js";
import { find } from "./find.js";
import { invite } from "./invite.js";
import { LarkCli } from "./lark.js";
import { checkAuth, RUN_TITLES, whoami } from "./ops.js";
import { addProject, listProjects, removeProject, resolveBaseLink, resolveProject, setDataApiKey, setDefaultProject, type Project } from "./projects.js";
import { remind } from "./remind.js";
import { sendApproved } from "./send.js";
import { checkBase, setupBase } from "./setup.js";
import { applyClassification, toClassify } from "./classify.js";
import { postMetrics } from "./metrics.js";
import { findPosts } from "./posts.js";
import { checkTrialName, syncCodes } from "./codes.js";
import { notifyGroup } from "./notify.js";
import { applyInbox, listInbox } from "./inbox.js";
import { applyRevisions, toRevise } from "./reviews.js";
import { syncInbox } from "./sync.js";
import { trialFollowup } from "./trialfollow.js";
import { todayLists } from "./today.js";
import { startConsole } from "./console/server.js";
import { dbCommand } from "./store/command.js";
import { withStores } from "./store/db.js";
import { ExecutorLock, lockHolder, machine, machineLabel, notExecutor } from "./executor.js";

const HELP = `kol <命令> [选项]

  today                         今天的清单：待处理来信、轮到我们、等你审核、体验码快到期、快到的发布（只读）
  console [--port N] [--no-browser]
                                在这台电脑上打开决策台：一件一件处理待你决定的事、看各阶段的 KOL 和来往、执行记录。按 Ctrl+C 关掉
  sync    [--days N]            把各邮箱从上次同步以来的来信同步进接触记录（--days 改成只看最近 N 天），来信的 KOL 改成「轮到我们」
  inbox   [--limit 30]          列出待处理的来信：对方原话、跟进阶段、体验码、建议码名（只读）
  inbox   --apply 文件.json      按决定文件把这批来信一次提交到审核队列（想体验 / 要回复 / 拒绝 / 不用回），
                                取消待处理；有一条不对就一条都不写
  send    [--only rec1,rec2]    发出审核队列里已批准、还没发的信，执行批准项的发后动作（结案 / 永不联系），撤回审核选了「不发」的
  revise                        列出审核选了「改」的项，附审核意见和原草稿（只读）
  revise  --apply 文件.json      把按意见重写的草稿放回原审核项，清掉处理、重新送审；有一条不对就一条都不写
  invite  --batch 批次 --template 模板 --mailbox 邮箱 --approval 审核记录 --profiles rec1,rec2 | --profiles-file 文件
                                给一批档案发邀约并建跟进记录（批次要先在审核队列里批准）
  remind                        先同步收件箱，再按规则发第 1/2 次催信，两次都没回的结案
  find    --platform instagram|youtube|tiktok --batch 入库批次 --job 名字 --budget 美元
          [--keywords a,b] [--seeds a,b] [--handles a,b] [--min-followers N] [--max-followers N] [--youtube-hidden]
          [--target N] [--add-batch]
                                找新 KOL 和邮箱，不在库里的写进档案。--target 大约搜多少个账号（平分给各关键词和相似账号）；
                                --add-batch 入库批次还不是选项时由插件加上
  classify --batch 入库批次 [--limit 50]
                                列出这批里还没填合作邀约方向、市场、語言、内容类型、称呼的人，附简介和可选值（只读）
  classify --apply 文件.json     按文件写入上面这几个字段（{"rec…": {"市场": "台湾", …}}），有一个值不对就一条都不写
  posts   [--budget 1] [--days N] 看已约发布、合作中、已发布的 KOL 最近的帖子，文案里有「设置」的发布识别词或他的活动码的，记进「发布内容」（花 Apify 的钱）
  metrics [--budget 2]          发布后第 1/3/7/30 天，抓 Instagram、YouTube、TikTok 帖子的播放和互动数填进「发布内容」（花 Apify 的钱）
  notify  --file 文本文件        把一段文字发到项目的飞书群（「设置」里填了飞书群机器人才发）
  codes                         从项目的业务数据接口同步体验码已用次数、上限和到期日，列出用了一部分、快到期的体验码和活动码概况
  trial-followup                体验码发出 5 天没用、用了一部分后 7 天没动静、2 天内到期的，按已批准的模板写好回信放进审核队列（天数在「设置」里）
  trial-check --code 码名        看这个码名能不能用来建体验码（只读）
  whoami                        看当前登录的飞书账号
  executor [claim]              看这台电脑是不是项目的执行电脑（只有它能发信、收信、建码、找人）；claim 把这台电脑设成执行电脑
  check                         检查飞书授权是否齐全、项目的飞书表缺不缺表和字段，以及怎么补

  project add 项目名 飞书表链接  登记一个项目（它的 KOL 总表）；第一个登记的是默认项目
  project list | default 项目名 | remove 项目名 | set-key 项目名 密钥 | set-trial-key 项目名 写密钥 | set-partner-key 项目名 写密钥
  db import [--url 连接串] [--replace]
                                把项目的飞书表整个复制进 Postgres（不切换）；库里已有这个项目时要加 --replace 才会整个换掉
  db use --url 连接串 | --feishu  把项目的读写切到这个数据库，或切回飞书表（连接串只存在这台电脑上）
  db status | backup [--dir 文件夹] | restore --file 备份 --replace | views
                                看项目用的是哪边、每张表多少行；备份到 ~/.kol-ops/backups（留 30 份）；从备份恢复；重建分析用的视图
  setup-base [--import-templates 文件夹] [--template-language 语言]
                                给项目的飞书表补上「设置」「发信邮箱」「模板」表和缺的字段，没有设置就写一行默认值；
                                可把文件夹里的 .txt 模板导入成「待审核」。只加不改，先用 --dry-run 看会做什么

每封信发出前都会检查：暂停开关、永不联系、收件人是不是这位 KOL、收件人邮箱的域名能不能收信、当天额度、是否重复。
通用选项：--project 项目名 选项目（不写就用默认项目）；--dry-run 只检查、列出会做什么，不发信也不改表；--scheduled 由定时任务调用。
结果以 JSON 打印到标准输出。`;

const list = (v: unknown) => (v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : []);
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
function need(v: Record<string, any>, ...keys: string[]) {
  const missing = keys.filter((k) => !v[k]);
  if (missing.length) throw new Error(`缺少参数：${missing.map((k) => `--${k}`).join(" ")}`);
}

const COMMANDS: Record<string, { title: string; writes: boolean; run: (ctx: Ctx, v: Record<string, any>) => Promise<unknown> }> = {
  today: { title: "", writes: false, run: (ctx) => todayLists(ctx) },
  sync: { title: RUN_TITLES.sync, writes: true, run: (ctx, v) => syncInbox(ctx, { days: v.days ? Number(v.days) : undefined, dryRun: !!v["dry-run"] }) },
  send: { title: RUN_TITLES.send, writes: true, run: (ctx, v) => sendApproved(ctx, { dryRun: !!v["dry-run"], only: list(v.only) }) },
  invite: {
    title: RUN_TITLES.invite, writes: true,
    run: (ctx, v) => {
      need(v, "batch", "template", "mailbox", "approval");
      const profiles = v["profiles-file"] ? list(readFileSync(String(v["profiles-file"]), "utf8").replace(/\s+/g, ",")) : list(v.profiles);
      if (!profiles.length) throw new Error("没有给要邀约的档案记录（--profiles 或 --profiles-file）");
      return invite(ctx, { batch: v.batch, template: v.template, mailbox: v.mailbox, approval: v.approval, profiles, dryRun: !!v["dry-run"] });
    },
  },
  remind: { title: RUN_TITLES.remind, writes: true, run: (ctx, v) => remind(ctx, { dryRun: !!v["dry-run"] }) },
  find: {
    title: RUN_TITLES.find, writes: true,
    run: (ctx, v) => {
      need(v, "platform", "batch", "job", "budget");
      return find(ctx, {
        platform: v.platform as Platform, keywords: list(v.keywords), seeds: list(v.seeds), handles: list(v.handles),
        minFollowers: num(v["min-followers"]), maxFollowers: num(v["max-followers"]), budget: Number(v.budget),
        batch: v.batch, job: v.job, youtubeHidden: !!v["youtube-hidden"], dryRun: !!v["dry-run"],
        target: num(v.target) ?? undefined, addBatch: !!v["add-batch"],
      });
    },
  },
  classify: {
    title: RUN_TITLES.classify, writes: true,
    run: (ctx, v) => {
      if (v.apply) return applyClassification(ctx, { file: String(v.apply), dryRun: !!v["dry-run"] });
      need(v, "batch");
      return toClassify(ctx, { batch: v.batch, limit: Number(v.limit ?? 50) });
    },
  },
  inbox: {
    title: RUN_TITLES.inbox, writes: true,
    run: (ctx, v) => (v.apply ? applyInbox(ctx, { file: String(v.apply), dryRun: !!v["dry-run"] }) : listInbox(ctx, { limit: Number(v.limit ?? 30) })),
  },
  revise: {
    title: RUN_TITLES.revise, writes: true,
    run: (ctx, v) => (v.apply ? applyRevisions(ctx, { file: String(v.apply), dryRun: !!v["dry-run"] }) : toRevise(ctx)),
  },
  posts: { title: RUN_TITLES.posts, writes: true, run: (ctx, v) => findPosts(ctx, { dryRun: !!v["dry-run"], budget: Number(v.budget ?? 1), days: v.days ? Number(v.days) : undefined }) },
  metrics: { title: RUN_TITLES.metrics, writes: true, run: (ctx, v) => postMetrics(ctx, { dryRun: !!v["dry-run"], budget: Number(v.budget ?? 2) }) },
  codes: { title: RUN_TITLES.codes, writes: true, run: (ctx, v) => syncCodes(ctx, { dryRun: !!v["dry-run"] }) },
  "trial-followup": { title: RUN_TITLES.trialFollowup, writes: true, run: (ctx, v) => trialFollowup(ctx, { dryRun: !!v["dry-run"] }) },
  "trial-check": {
    title: "", writes: false,
    run: (ctx, v) => {
      need(v, "code");
      return checkTrialName(ctx, String(v.code));
    },
  },
  notify: {
    title: "", writes: false,
    run: (ctx, v) => {
      need(v, "file");
      return notifyGroup(ctx.cfg, { file: String(v.file), dryRun: !!v["dry-run"] });
    },
  },
  whoami: { title: "", writes: false, run: async (ctx) => ctx.me },
  // Handled in main(): it keeps running until stopped.
  console: { title: "", writes: false, run: async () => null },
  executor: { title: "", writes: false, run: async () => null },
  // These three are handled in main(): they must work before the project's settings can be read.
  check: { title: "", writes: false, run: async () => null },
  project: { title: "", writes: false, run: async () => null },
  "setup-base": { title: "", writes: false, run: async () => null },
  db: { title: "", writes: false, run: async () => null },
};

async function projectCommand(args: string[]): Promise<unknown> {
  const [sub, a, b] = args;
  if (sub === "add") {
    if (!a || !b) throw new Error("用法：kol project add <项目名> <飞书表链接>");
    return addProject(a, await resolveBaseLink(new LarkCli(""), b));
  }
  if (sub === "default" && a) return setDefaultProject(a), { 默认项目: a };
  if (sub === "remove" && a) return removeProject(a), { 已删除: a };
  if (sub === "set-key" && a && b) return setDataApiKey(a, b), { 已保存: `${a} 的业务数据接口密钥（只存在这台电脑上）` };
  if (sub === "set-trial-key" && a && b) return setDataApiKey(a, b, "trialKey"), { 已保存: `${a} 的体验码写密钥（只存在这台电脑上）` };
  if (sub === "set-partner-key" && a && b) return setDataApiKey(a, b, "partnerKey"), { 已保存: `${a} 的活动码写密钥（只存在这台电脑上）` };
  if (!sub || sub === "list") {
    const all = listProjects();
    const def = all.length ? resolveProject().name : "";
    return all.map((p) => ({ 项目: p.name, 默认: p.name === def, 飞书表: p.baseToken, 有接口密钥: !!p.dataApiKey, 有体验码写密钥: !!p.trialKey, 有活动码写密钥: !!p.partnerKey }));
  }
  throw new Error("用法：kol project add|list|default|remove|set-key|set-trial-key|set-partner-key …");
}

/** `kol check`: login scopes always; the project's base too when one is registered. */
async function check(project: Project | undefined): Promise<unknown> {
  const lark = withStores(new LarkCli(project?.baseToken ?? ""), project?.baseToken ?? "");
  const auth = await checkAuth(lark);
  if (!project) return { ...auth, 项目: "这台电脑还没有登记项目（kol project add <项目名> <飞书表链接>）" };
  // Reading the base needs only the Base scopes, so a login still waiting for mail scopes can be checked too.
  const canReadBase = !auth.缺少的权限?.some((s) => s === "base:record:read" || s === "base:field:read");
  if (!canReadBase) return { ...auth, 项目: project.name, 飞书表: "授权补齐后再检查" };
  return { ...auth, 项目: project.name, 飞书表: await checkBase(new Base(lark, project.baseToken)) };
}

async function main(): Promise<number> {
  const str = { type: "string" } as const;
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" }, scheduled: { type: "boolean" }, help: { type: "boolean", short: "h" },
      "youtube-hidden": { type: "boolean" }, "no-browser": { type: "boolean" }, port: str,
      days: str, only: str, batch: str, template: str, mailbox: str, approval: str, profiles: str, "profiles-file": str,
      platform: str, job: str, budget: str, keywords: str, seeds: str, handles: str, "min-followers": str, "max-followers": str, target: str, "add-batch": { type: "boolean" },
      url: str, replace: { type: "boolean" }, feishu: { type: "boolean" }, dir: str,
      project: str, "import-templates": str, "template-language": str, apply: str, limit: str, file: str, code: str,
    },
  });
  const name = positionals[0];
  const cmd = name ? COMMANDS[name] : undefined;
  if (!cmd || values.help) {
    console.log(HELP);
    return cmd || values.help ? 0 : 1;
  }

  let ctx: Ctx | undefined;
  // Listing what to classify or answer only reads; only --apply belongs in 运行记录.
  const logged = cmd.writes && !values["dry-run"] && !(["classify", "inbox", "revise"].includes(name) && !values.apply);
  try {
    if (name === "project") return print(await projectCommand(positionals.slice(1)));
    if (name === "check") {
      // Runs before whoami, which itself needs a scope a fresh login may lack.
      let project: Project | undefined;
      try {
        project = resolveProject(values.project);
      } catch {}
      return print(await check(project));
    }
    const project = resolveProject(values.project);
    if (name === "db") return print(await dbCommand(project, positionals[1], values));
    const lark = withStores(new LarkCli(project.baseToken), project.baseToken);
    if (name === "setup-base") {
      return print(await setupBase(new Base(lark, project.baseToken), {
        project: project.name, dryRun: !!values["dry-run"], importDir: values["import-templates"], templateLanguage: values["template-language"],
      }));
    }
    const cfg = await loadConfig(lark, project.name, project.baseToken);
    ctx = makeCtx(cfg, lark, await whoami(lark), cmd.title, !!values.scheduled);
    if (name === "console") {
      const { url } = await startConsole(ctx, { port: values.port ? Number(values.port) : undefined, openBrowser: !values["no-browser"] });
      print({ 地址: url, 说明: "决策台已经打开，正在读数据，页面会自己显示出来。只有这台电脑能访问；按 Ctrl+C 关掉。" });
      return new Promise<number>(() => {});
    }
    if (name === "executor") return print(await executorCommand(ctx, positionals[1]));
    const executes = EXECUTES.includes(name) && !values["dry-run"];
    if (executes) {
      const why = notExecutor(cfg);
      if (why) throw new Error(why);
    }
    const go = async () => {
      if (logged) await ctx!.run.start();
      return cmd.run(ctx!, values);
    };
    // Everything that reaches outside the base runs one at a time on this computer; wait for a run in progress.
    const result = executes ? await ExecutorLock.run(cmd.title || name, go, { waitMs: 10 * 60_000 }) : await go();
    if (logged) await ctx.run.finish(hasFailures(result) ? "部分完成" : "完成");
    return print(result);
  } catch (err: any) {
    if (logged && ctx) {
      ctx.run.notes.push(String(err?.message ?? err));
      await ctx.run.finish("失败").catch(() => {});
    }
    console.error(`出错：${err?.message ?? err}`);
    return 2;
  }
}

/** Commands that send, read the inbox, write codes or spend Apify money: only the executor computer runs them. */
const EXECUTES = ["sync", "send", "invite", "remind", "find", "posts", "metrics", "codes", "trial-followup"];

/** `kol executor`: whether this computer is the project's executor; `claim` makes it so. */
async function executorCommand(ctx: Ctx, sub: string | undefined): Promise<unknown> {
  const me = machine();
  if (sub === "claim") {
    const [row] = await ctx.base.records(ctx.cfg.tables.settings, { fields: ["执行电脑"] });
    if (!row) throw new Error("「设置」表是空的");
    await ctx.base.update(ctx.cfg.tables.settings, { [row.record_id]: { 执行电脑: machineLabel(me) } });
    return { 执行电脑: machineLabel(me), 说明: "以后只有这台电脑能发信、收信、建码、找人" };
  }
  if (sub) throw new Error("用法：kol executor [claim]");
  const holder = lockHolder();
  return {
    这台电脑: machineLabel(me),
    设置里的执行电脑: ctx.cfg.executor || "（没填：哪台电脑都能执行）",
    能执行: !notExecutor(ctx.cfg, me),
    正在做: holder ? `${holder.what}（${new Date(holder.since).toLocaleString("zh-CN", { hour12: false })} 开始）` : "没有",
  };
}

function print(result: unknown): number {
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function hasFailures(result: any): boolean {
  return [result?.failed, result?.send?.failed].some((f) => Array.isArray(f) && f.length > 0);
}

main().then((code) => process.exit(code));
