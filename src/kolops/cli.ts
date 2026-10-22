import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { makeCtx, type Ctx } from "./ctx.js";
import { LarkCli } from "./lark.js";
import { whoami } from "./ops.js";
import { sendApproved } from "./send.js";
import { syncInbox } from "./sync.js";

const HELP = `kol <命令> [选项]

  sync    [--days 3]          把各邮箱最近几天的来信同步进接触记录，并把来信的 KOL 改成「轮到我们」
  send    [--only rec1,rec2]  发出审核队列里已批准、还没发的信（每封都先检查永不联系、额度、暂停开关）
  whoami                      看当前登录的飞书账号

通用选项：
  --dry-run     只检查、列出会做什么，不发信也不改表
  --scheduled   由定时任务调用（写进运行记录的「方式」）

结果以 JSON 打印到标准输出。`;

const COMMANDS: Record<string, { title: string; writes: boolean; run: (ctx: Ctx, v: Record<string, any>) => Promise<unknown> }> = {
  sync: { title: "收信同步", writes: true, run: (ctx, v) => syncInbox(ctx, { days: Number(v.days ?? 3), dryRun: !!v["dry-run"] }) },
  send: {
    title: "发出已批准的信", writes: true,
    run: (ctx, v) => sendApproved(ctx, { dryRun: !!v["dry-run"], only: v.only ? String(v.only).split(",") : undefined }),
  },
  whoami: { title: "", writes: false, run: async (ctx) => ctx.me },
};

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" }, scheduled: { type: "boolean" }, days: { type: "string" },
      only: { type: "string" }, help: { type: "boolean", short: "h" },
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
  if (logged) await ctx.run.start();
  try {
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

function hasFailures(result: unknown): boolean {
  return Array.isArray((result as any)?.failed) && (result as any).failed.length > 0;
}

main().then((code) => process.exit(code));
