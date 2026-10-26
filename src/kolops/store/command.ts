import { LarkCli } from "../lark.js";
import { setDatabase, type Project } from "../projects.js";
import { backup, connect, createViews, ensureSchema, loadSnapshot, projectCounts, readBackup, readFeishu } from "./db.js";

/** Which database a db command talks to: --url, else KOL_DATABASE_URL, else the one the project already uses. */
function urlFor(project: Project, v: Record<string, any>): string {
  const url = v.url || process.env.KOL_DATABASE_URL || project.database;
  if (!url) throw new Error("没有数据库连接串：加 --url postgres://…，或设环境变量 KOL_DATABASE_URL");
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error("连接串要以 postgres:// 或 postgresql:// 开头");
  return url;
}

/** Never print the password part of a connection string. */
const masked = (url: string) => url.replace(/\/\/([^:@/]+):[^@]+@/, "//$1:***@");

/** `kol db …`: copy a project's Feishu base into Postgres, switch it over or back, back it up, restore it, rebuild views. */
export async function dbCommand(project: Project, sub: string | undefined, v: Record<string, any>): Promise<unknown> {
  if (sub === "use" && v.feishu) {
    setDatabase(project.name, undefined);
    return { 项目: project.name, 现在用: "飞书表", 说明: "数据库里的数据还在，没有删；之后在飞书表里的改动不会自动进数据库" };
  }
  const url = urlFor(project, v);
  const sql = connect(url);
  try {
    await ensureSchema(sql);
    switch (sub) {
      case "import": {
        const counts = await projectCounts(sql, project.name);
        if (Object.keys(counts).length && !v.replace) {
          throw new Error(`数据库里已经有项目「${project.name}」的数据（${Object.keys(counts).length} 张表）。要用飞书表的现状整个换掉，加 --replace`);
        }
        const read: Record<string, number> = {};
        const snap = await readFeishu(new LarkCli(project.baseToken), project.baseToken, project.name, (t, n) => {
          read[t] = n;
          console.error(`读完「${t}」：${n} 行`);
        });
        if (v["dry-run"]) return { 试跑: true, 会复制: read };
        await loadSnapshot(sql, snap, project.name, !!v.replace);
        const views = await createViews(sql, project.name);
        return {
          项目: project.name, 数据库: masked(url), 复制了: await projectCounts(sql, project.name), 分析视图: views.length,
          说明: project.database === url ? "这个项目已经在用这个数据库" : `还没切换：确认没问题后运行 kol db use --project ${project.name} --url <连接串>`,
        };
      }
      case "use": {
        const counts = await projectCounts(sql, project.name);
        if (!Object.keys(counts).length) throw new Error(`数据库里还没有项目「${project.name}」的数据，先运行 kol db import`);
        setDatabase(project.name, url);
        return { 项目: project.name, 现在用: masked(url), 各表行数: counts, 说明: "以后这个项目的读写都走数据库，飞书表不再更新。退回：kol db use --feishu" };
      }
      case "status":
      case undefined:
        return { 项目: project.name, 现在用: project.database ? masked(project.database) : "飞书表", 这个库里的数据: await projectCounts(sql, project.name) };
      case "backup":
        return { 项目: project.name, ...(await backup(sql, project.name, v.dir)) };
      case "restore": {
        if (!v.file) throw new Error("用法：kol db restore --file 备份文件 --replace");
        if (!v.replace) throw new Error("恢复会用备份整个换掉库里这个项目的数据，确认的话加 --replace");
        // Keep what is there now first, so a restore from the wrong file can itself be undone.
        const before = await backup(sql, project.name, undefined).catch(() => null);
        const snap = readBackup(String(v.file));
        await loadSnapshot(sql, { ...snap, project: project.name }, project.name, true);
        await createViews(sql, project.name);
        return { 项目: project.name, 恢复自: v.file, 恢复前的数据另存在: before?.file ?? "（没能另存）", 各表行数: await projectCounts(sql, project.name) };
      }
      case "views":
        return { 项目: project.name, 视图: await createViews(sql, project.name) };
      default:
        throw new Error("用法：kol db import|use|status|backup|restore|views");
    }
  } finally {
    await sql.end();
  }
}
