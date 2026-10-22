import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Platform } from "../discovery/models.js";
import { loadConfig } from "./config.js";
import { makeCtx, type Ctx } from "./ctx.js";
import { find } from "./find.js";
import { invite } from "./invite.js";
import { LarkCli } from "./lark.js";
import { whoami } from "./ops.js";
import { remind } from "./remind.js";
import { sendApproved } from "./send.js";
import { syncInbox } from "./sync.js";
import { todayLists } from "./today.js";

const HELP = `kol <命令> [选项]

  today                         今天的清单：待处理来信、轮到我们、等你审核、体验码快到期、快到的发布（只读）
  sync    [--days 3]            把各邮箱最近几天的来信同步进接触记录，来信的 KOL 改成「轮到我们」
  send    [--only rec1,rec2]    发出审核队列里已批准、还没发的信
  invite  --batch 批次 --template 模板 --mailbox 邮箱 --approval 审核记录 --profiles rec1,rec2 | --profiles-file 文件
                                给一批档案发邀约并建跟进记录（批次要先在审核队列里批准）
  remind                        先同步收件箱，再按规则发第 1/2 次催信，两次都没回的结案
  find    --platform instagram|youtube|tiktok --batch 入库批次 --job 名字 --budget 美元
          [--keywords a,b] [--seeds a,b] [--handles a,b] [--min-followers N] [--max-followers N] [--youtube-hidden]
                                找新 KOL 和邮箱，不在库里的写进档案
  whoami                        看当前登录的飞书账号

每封信发出前都会检查：暂停开关、永不联系、收件人是不是这位 KOL、当天额度、是否重复。
通用选项：--dry-run 只检查、列出会做什么，不发信也不改表；--scheduled 由定时任务调用。
结果以 JSON 打印到标准输出。`;

const list = (v: unknown) => (v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : []);
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
function need(v: Record<string, any>, ...keys: string[]) {
  const missing = keys.filter((k) => !v[k]);
  if (missing.length) throw new Error(`缺少参数：${missing.map((k) => `--${k}`).join(" ")}`);
}

const COMMANDS: Record<string, { title: string; writes: boolean; run: (ctx: Ctx, v: Record<string, any>) => Promise<unknown> }> = {
  today: { title: "", writes: false, run: (ctx) => todayLists(ctx) },
  sync: { title: "收信同步", writes: true, run: (ctx, v) => syncInbox(ctx, { days: Number(v.days ?? 3), dryRun: !!v["dry-run"] }) },
  send: { title: "发出已批准的信", writes: true, run: (ctx, v) => sendApproved(ctx, { dryRun: !!v["dry-run"], only: list(v.only) }) },
  invite: {
    title: "发邀约", writes: true,
    run: (ctx, v) => {
      need(v, "batch", "template", "mailbox", "approval");
      const profiles = v["profiles-file"] ? list(readFileSync(String(v["profiles-file"]), "utf8").replace(/\s+/g, ",")) : list(v.profiles);
      if (!profiles.length) throw new Error("没有给要邀约的档案记录（--profiles 或 --profiles-file）");
      return invite(ctx, { batch: v.batch, template: v.template, mailbox: v.mailbox, approval: v.approval, profiles, dryRun: !!v["dry-run"] });
    },
  },
  remind: { title: "催信和结案", writes: true, run: (ctx, v) => remind(ctx, { dryRun: !!v["dry-run"] }) },
  find: {
    title: "找 KOL", writes: true,
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
};

async function main(): Promise<number> {
  const str = { type: "string" } as const;
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" }, scheduled: { type: "boolean" }, help: { type: "boolean", short: "h" },
      "youtube-hidden": { type: "boolean" },
      days: str, only: str, batch: str, template: str, mailbox: str, approval: str, profiles: str, "profiles-file": str,
      platform: str, job: str, budget: str, keywords: str, seeds: str, handles: str, "min-followers": str, "max-followers": str,
    },
  });
  const name = positionals[0];
  const cmd = name ? COMMANDS[name] : undefined;
  if (!cmd || values.help) {
    console.log(HELP);
    return cmd || values.help ? 0 : 1;
  }

  const cfg = loadConfig();
  const lark = new LarkCli(cfg.baseToken);
  const me = await whoami(lark);
  const ctx = makeCtx(cfg, lark, me, cmd.title, !!values.scheduled);
  const logged = cmd.writes && !values["dry-run"];
  try {
    if (logged) await ctx.run.start();
    const result = await cmd.run(ctx, values);
    if (logged) await ctx.run.finish(hasFailures(result) ? "部分完成" : "完成");
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err: any) {
    if (logged) {
      ctx.run.notes.push(String(err?.message ?? err));
      await ctx.run.finish("失败").catch(() => {});
    }
    console.error(`出错：${err?.message ?? err}`);
    return 2;
  }
}

function hasFailures(result: any): boolean {
  return [result?.failed, result?.send?.failed].some((f) => Array.isArray(f) && f.length > 0);
}

main().then((code) => process.exit(code));
