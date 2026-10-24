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
import { addProject, listProjects, removeProject, resolveProject, setDataApiKey, setDefaultProject, type Project } from "./projects.js";
import { remind } from "./remind.js";
import { sendApproved } from "./send.js";
import { checkBase, setupBase } from "./setup.js";
import { syncInbox } from "./sync.js";
import { todayLists } from "./today.js";

const HELP = `kol <命令> [选项]

  today                         今天的清单：待处理来信、轮到我们、等你审核、体验码快到期、快到的发布（只读）
  sync    [--days N]            把各邮箱从上次同步以来的来信同步进接触记录（--days 改成只看最近 N 天），来信的 KOL 改成「轮到我们」
  send    [--only rec1,rec2]    发出审核队列里已批准、还没发的信
  invite  --batch 批次 --template 模板 --mailbox 邮箱 --approval 审核记录 --profiles rec1,rec2 | --profiles-file 文件
                                给一批档案发邀约并建跟进记录（批次要先在审核队列里批准）
  remind                        先同步收件箱，再按规则发第 1/2 次催信，两次都没回的结案
  find    --platform instagram|youtube|tiktok --batch 入库批次 --job 名字 --budget 美元
          [--keywords a,b] [--seeds a,b] [--handles a,b] [--min-followers N] [--max-followers N] [--youtube-hidden]
                                找新 KOL 和邮箱，不在库里的写进档案
  whoami                        看当前登录的飞书账号
  check                         检查飞书授权是否齐全、项目的飞书表缺不缺表和字段，以及怎么补

  project add 项目名 飞书表链接  登记一个项目（它的 KOL 总表）；第一个登记的是默认项目
  project list | default 项目名 | remove 项目名 | set-key 项目名 密钥
  setup-base [--import-templates 文件夹] [--template-language 语言]
                                给项目的飞书表补上「设置」「发信邮箱」「模板」表和缺的字段，没有设置就写一行默认值；
                                可把文件夹里的 .txt 模板导入成「待审核」。只加不改，先用 --dry-run 看会做什么

每封信发出前都会检查：暂停开关、永不联系、收件人是不是这位 KOL、当天额度、是否重复。
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
      });
    },
  },
  whoami: { title: "", writes: false, run: async (ctx) => ctx.me },
  // These three are handled in main(): they must work before the project's settings can be read.
  check: { title: "", writes: false, run: async () => null },
  project: { title: "", writes: false, run: async () => null },
  "setup-base": { title: "", writes: false, run: async () => null },
};

function projectCommand(args: string[]): unknown {
  const [sub, a, b] = args;
  if (sub === "add") {
    if (!a || !b) throw new Error("用法：kol project add <项目名> <飞书表链接>");
    return addProject(a, b);
  }
  if (sub === "default" && a) return setDefaultProject(a), { 默认项目: a };
  if (sub === "remove" && a) return removeProject(a), { 已删除: a };
  if (sub === "set-key" && a && b) return setDataApiKey(a, b), { 已保存: `${a} 的业务数据接口密钥（只存在这台电脑上）` };
  if (!sub || sub === "list") {
    const all = listProjects();
    const def = all.length ? resolveProject().name : "";
    return all.map((p) => ({ 项目: p.name, 默认: p.name === def, 飞书表: p.baseToken, 有接口密钥: !!p.dataApiKey }));
  }
  throw new Error("用法：kol project add|list|default|remove|set-key …");
}

/** `kol check`: login scopes always; the project's base too when one is registered. */
async function check(project: Project | undefined): Promise<unknown> {
  const lark = new LarkCli(project?.baseToken ?? "");
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
      "youtube-hidden": { type: "boolean" },
      days: str, only: str, batch: str, template: str, mailbox: str, approval: str, profiles: str, "profiles-file": str,
      platform: str, job: str, budget: str, keywords: str, seeds: str, handles: str, "min-followers": str, "max-followers": str,
      project: str, "import-templates": str, "template-language": str,
    },
  });
  const name = positionals[0];
  const cmd = name ? COMMANDS[name] : undefined;
  if (!cmd || values.help) {
    console.log(HELP);
    return cmd || values.help ? 0 : 1;
  }

  let ctx: Ctx | undefined;
  const logged = cmd.writes && !values["dry-run"];
  try {
    if (name === "project") return print(projectCommand(positionals.slice(1)));
    if (name === "check") {
      // Runs before whoami, which itself needs a scope a fresh login may lack.
      let project: Project | undefined;
      try {
        project = resolveProject(values.project);
      } catch {}
      return print(await check(project));
    }
    const project = resolveProject(values.project);
    const lark = new LarkCli(project.baseToken);
    if (name === "setup-base") {
      return print(await setupBase(new Base(lark, project.baseToken), {
        project: project.name, dryRun: !!values["dry-run"], importDir: values["import-templates"], templateLanguage: values["template-language"],
      }));
    }
    const cfg = await loadConfig(lark, project.name, project.baseToken);
    ctx = makeCtx(cfg, lark, await whoami(lark), cmd.title, !!values.scheduled);
    if (logged) await ctx.run.start();
    const result = await cmd.run(ctx, values);
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

function print(result: unknown): number {
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

function hasFailures(result: any): boolean {
  return [result?.failed, result?.send?.failed].some((f) => Array.isArray(f) && f.length > 0);
}

main().then((code) => process.exit(code));
