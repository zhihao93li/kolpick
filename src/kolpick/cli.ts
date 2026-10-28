/**
 * kolpick command line: the same tools the MCP server offers (kolpick tool <名字>), plus serve, install, setup,
 * migration and import.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { databaseUrl, home, loadConfig, saveConfig } from "./config.js";
import { makeCtx } from "./ctx.js";
import { connect, migrate } from "./db/db.js";
import { exportBase } from "./importer/export.js";
import { importSnapshot, projectCounts } from "./importer/import.js";
import { install, restart, uninstall } from "./install.js";
import { App, serveSetup } from "./server.js";
import { fromKolOps, ready } from "./setup.js";
import { callTool, TOOLS } from "./tools.js";

const HELP = `kolpick <命令>

  open                            打开决策台（浏览器）
  serve                           在前台运行本机服务（决策台 + MCP + 收信 + 定时任务）
  install                         安装：放好 kolpick.app，注册到本机 Claude Code 和 Codex，然后打开它
  uninstall | restart             停掉并移除 / 重启后台服务
  setup [--from-kol-ops] [--test-db URL] [--prod-db URL] [--apify-token T]
        [--data-key K] [--trial-key K] [--partner-key K] [--project tafu]
                                  保存本机配置（只存在 ~/.kolpick/config.json；也可以在决策台里填）
  tools                           列出所有工具
  tool <名字> ['{"参数":...}']      运行一个工具，结果打印成 JSON
  db migrate | db use test|prod   建表升级 / 切换当前数据库
  import export <飞书 base> [目录]  把旧飞书表导出成本机快照
  import load <目录> [--keep-mailboxes]  把快照导入当前数据库（可重复跑；测试库停用所有发信邮箱）
  import counts                   数各类条数
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function withDb<T>(fn: (db: ReturnType<typeof connect>) => Promise<T>): Promise<T> {
  const db = connect(databaseUrl());
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

export async function main(argv: string[]): Promise<void> {
  const [group, cmd, ...rest] = argv;
  const cfg = loadConfig();
  const project = flag(argv, "--project") ?? cfg.project;
  switch (group) {
    case "serve": {
      const startApp = async () => {
        const db = connect(databaseUrl());
        await migrate(db);
        const app = new App(makeCtx(db));
        await app.start();
        console.log(`kolpick 已启动：http://127.0.0.1:${cfg.port}（${loadConfig().env === "prod" ? "正式库" : "测试库"}）`);
        const stop = async () => {
          await app.stop();
          await db.end();
          process.exit(0);
        };
        app.onQuit = stop;
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      };
      if (ready(cfg)) return startApp();
      // Not set up yet: the console shows the setup page until a working database is saved.
      fromKolOps(cfg);
      await serveSetup(cfg, startApp);
      console.log(`kolpick 等第一次设置：http://127.0.0.1:${cfg.port}`);
      return;
    }
    case "open": {
      const url = `http://127.0.0.1:${cfg.port}/`;
      const up = await fetch(`${url}api/local`).then((r) => r.ok).catch(() => false);
      if (!up) console.log(`服务没在运行：先运行 kolpick install（或在另一个窗口运行 kolpick serve）`);
      execFileSync("open", [url]);
      return;
    }
    case "install":
      install().forEach((l) => console.log(l));
      return;
    case "uninstall":
      uninstall().forEach((l) => console.log(l));
      return;
    case "restart":
      console.log(restart());
      return;
    case "setup": {
      const args = [cmd, ...rest].filter((x) => x !== undefined) as string[];
      if (args.includes("--from-kol-ops")) fromKolOps(cfg);
      if (flag(args, "--test-db")) cfg.databases.test = flag(args, "--test-db");
      if (flag(args, "--prod-db")) cfg.databases.prod = flag(args, "--prod-db");
      if (flag(args, "--apify-token")) cfg.apifyToken = flag(args, "--apify-token");
      if (flag(args, "--project")) cfg.project = flag(args, "--project")!;
      const keys = (cfg.keys[cfg.project] ??= {});
      if (flag(args, "--data-key")) keys.dataApi = flag(args, "--data-key");
      if (flag(args, "--trial-key")) keys.trial = flag(args, "--trial-key");
      if (flag(args, "--partner-key")) keys.partner = flag(args, "--partner-key");
      saveConfig(cfg);
      console.log(`已保存 ${join(home(), "config.json")}：数据库 ${Object.keys(cfg.databases).join("、") || "未配"}，当前 ${cfg.env}，项目 ${cfg.project}，`
        + `Apify ${cfg.apifyToken ? "有" : "无"}，接口密钥 ${Object.entries(cfg.keys[cfg.project] ?? {}).filter(([, v]) => v).map(([k]) => k).join("、") || "无"}`);
      return;
    }
    case "tools":
      for (const t of TOOLS) console.log(`${t.name}\n    ${t.description}\n`);
      return;
    case "tool": {
      if (!cmd) throw new Error("用法：kolpick tool <名字> '{\"参数\":...}'");
      const args = rest[0] && !rest[0].startsWith("--") ? JSON.parse(rest[0]) : {};
      const res = await withDb(async (db) => callTool(makeCtx(db), cmd, args, "operator", project));
      console.log(typeof res === "string" ? res : JSON.stringify(res, null, 2));
      return;
    }
    case "db":
      if (cmd === "use") {
        if (rest[0] !== "test" && rest[0] !== "prod") throw new Error("用法：kolpick db use test|prod");
        cfg.env = rest[0];
        saveConfig(cfg);
        console.log(`当前数据库：${cfg.env}。后台服务要重启才换：kolpick restart`);
        return;
      }
      if (cmd === "migrate") {
        await withDb(async (db) => console.log(`[${cfg.env}] 新执行迁移 ${await migrate(db)} 个`));
        return;
      }
      break;
    case "import":
      if (cmd === "export") {
        if (!rest[0]) throw new Error("用法：kolpick import export <飞书 base token> [目录]");
        const dir = rest[1] ?? join(home(), "snapshots", `feishu-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
        await exportBase(rest[0], dir);
        console.log(`已导出到 ${dir}`);
        return;
      }
      if (cmd === "load" || cmd === "counts") {
        await withDb(async (db) => {
          if (cmd === "load") {
            const dir = rest[0]?.replace(/^~/, homedir());
            if (!dir) throw new Error("用法：kolpick import load <快照目录>");
            await migrate(db);
            const keep = rest.includes("--keep-mailboxes");
            if (keep && cfg.env === "test") throw new Error("测试库不保留发信邮箱");
            await importSnapshot(db, dir, { project, disableMailboxes: !keep, log: (l) => console.log(l) });
          }
          console.log(`[${cfg.env}] ${project}：`, await projectCounts(db, project));
        });
        return;
      }
      break;
  }
  console.log(HELP);
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
