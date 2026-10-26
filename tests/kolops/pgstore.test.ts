import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { Base, cellTime, onOrAfter } from "../../src/kolops/base.js";
import { backup, createViews, ensureSchema, loadSnapshot, projectCounts, readBackup, type Snapshot } from "../../src/kolops/store/db.js";
import { PgStore, StoreLark, type Sql } from "../../src/kolops/store/pg.js";
import { FakeLark } from "./fake.js";

type Db = Sql & { exec(text: string): Promise<void> };

function pglite(): Db {
  const db = new PGlite();
  const wrap = (q: any): Sql => ({
    query: async (text, params = []) => (await q.query(text, params)).rows,
    tx: (fn) => db.transaction((t) => fn(wrap(t))),
    end: () => db.close(),
  });
  return { ...wrap(db), exec: async (text) => void (await db.exec(text)) };
}

const TOKEN = "baseOnPostgres01";
const link = (table: string, back: string, id: string) => ({ type: "link", link_table: table, bidirectional: true, bidirectional_link_field_id: back, id });

/** Tables shaped like a real project base: profiles ↔ followups ↔ contacts, with Feishu's lookups and system fields. */
function snapshot(): Snapshot {
  const f = (tbl: string, defs: any[]) => defs.map((def, i) => ({ tbl, name: def.name, position: i + 1, type: def.type, def }));
  const at = "2026-10-20T02:00:00.000Z";
  return {
    version: 1, project: "p", exportedAt: at,
    tables: [{ name: "KOL 档案", feishu_id: "tblP", position: 1 }, { name: "KOL 跟进", feishu_id: "tblF", position: 2 }, { name: "接触记录", feishu_id: "tblC", position: 3 }, { name: "设置", feishu_id: "tblS", position: 4 }],
    fields: [
      ...f("KOL 档案", [{ name: "账号名称", type: "text" }, { name: "公开邮箱", type: "text" }, { name: "粉丝数", type: "number" },
        { name: "联系许可", type: "select", multiple: false, options: [{ name: "可联系" }, { name: "永不联系" }] }, { name: "跟进记录", ...link("tblF", "f1", "p1") }, { name: "更新时间", type: "updated_at" }]),
      ...f("KOL 跟进", [{ name: "账号名称", type: "text" }, { name: "档案", ...link("tblP", "p1", "f1") }, { name: "阶段", type: "select", multiple: false, options: [{ name: "已回复" }, { name: "体验中" }] },
        { name: "下次跟进日期", type: "datetime" }, { name: "公开邮箱", type: "formula", expression: "[档案].[公开邮箱].LISTCOMBINE().UNIQUE()" },
        { name: "粉丝数", type: "formula", expression: "[档案].[粉丝数].MAX()" }, { name: "接触记录", ...link("tblC", "c1", "f2") }, { name: "更新时间", type: "updated_at" }]),
      ...f("接触记录", [{ name: "摘要", type: "text" }, { name: "方向", type: "select", multiple: false, options: [{ name: "收到" }, { name: "发出" }] }, { name: "待处理", type: "checkbox" },
        { name: "日期", type: "datetime" }, { name: "KOL", ...link("tblF", "f2", "c1") }, { name: "记录人", type: "created_by" }]),
      ...f("设置", [{ name: "项目名称", type: "text" }, { name: "时区", type: "text" }]),
    ],
    records: [
      { tbl: "KOL 档案", id: "recP1", fields: { 账号名称: "安安", 公开邮箱: "anan@example.com", 粉丝数: 15000, 联系许可: ["可联系"], 跟进记录: [{ id: "recF1" }] }, created_at: at, updated_at: at },
      { tbl: "KOL 跟进", id: "recF1", fields: { 账号名称: "安安", 档案: [{ id: "recP1" }], 阶段: ["已回复"], 接触记录: [{ id: "recC1" }] }, created_at: at, updated_at: at },
      { tbl: "接触记录", id: "recC1", fields: { 摘要: "你好", 方向: ["收到"], 待处理: true, 日期: "2026-10-20T10:00:00.000+08:00", KOL: [{ id: "recF1" }], 记录人: [{ id: "ou_x", name: "某人" }] }, created_at: at, updated_at: at },
      { tbl: "设置", id: "recS1", fields: { 项目名称: "测试", 时区: "+08:00" }, created_at: at, updated_at: at },
    ],
  };
}

let db: Db;
let base: Base;

beforeEach(async () => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-pg-"));
  db = pglite();
  await ensureSchema(db);
  await loadSnapshot(db, snapshot(), "p", false);
  const store = new PgStore("p", db);
  base = new Base(new StoreLark(new FakeLark(), TOKEN, (t) => (t === TOKEN ? store : null)), TOKEN);
});

describe("a project kept in Postgres", () => {
  it("reads rows the way Feishu returns them, lookups and 更新时间 included", async () => {
    const [f] = await base.records("KOL 跟进");
    expect(f).toMatchObject({ record_id: "recF1", 阶段: ["已回复"], 公开邮箱: "anan@example.com", 粉丝数: "15000", 更新时间: "2026-10-20T10:00:00.000+08:00" });
    expect(await base.get("tblF", ["recF1"], ["账号名称"])).toEqual([{ record_id: "recF1", 账号名称: "安安" }]);
  });

  it("filters like Feishu: intersects, checkbox, and days on or after", async () => {
    const open = (more: any[] = []) => base.records("接触记录", { filter: { logic: "and", conditions: [["待处理", "==", true], ["方向", "intersects", ["收到"]], ...more] } });
    expect(await open()).toHaveLength(1);
    expect(await open([onOrAfter("日期", "2026-10-20")])).toHaveLength(1);
    expect(await open([onOrAfter("日期", "2026-10-21")])).toHaveLength(0);
  });

  it("stores written values in Feishu's form and keeps two-way links in step", async () => {
    const [id] = await base.create("接触记录", [{ 摘要: "回信", 方向: "发出", 日期: "2026-10-26 09:30", KOL: [{ id: "recF1" }] }]);
    const [c] = await base.get("接触记录", [id]);
    expect(c).toMatchObject({ 方向: ["发出"], 日期: "2026-10-26T09:30:00.000+08:00" });
    expect(cellTime(c["日期"])).toBe(Date.parse("2026-10-26T09:30:00+08:00"));
    let [f] = await base.get("KOL 跟进", ["recF1"]);
    expect(f["接触记录"]).toEqual([{ id: "recC1" }, { id }]);

    await base.update("接触记录", { [id]: { KOL: null } });
    [f] = await base.get("KOL 跟进", ["recF1"]);
    expect(f["接触记录"]).toEqual([{ id: "recC1" }]);
  });

  it("moves 更新时间 on every write and adds an option the first time it is used", async () => {
    await base.update("KOL 跟进", { recF1: { 阶段: ["已发布"], 下次跟进日期: "2026-11-02" } });
    const [f] = await base.records("KOL 跟进");
    expect(f).toMatchObject({ 阶段: ["已发布"], 下次跟进日期: "2026-11-02T00:00:00.000+08:00" });
    expect(cellTime(f["更新时间"])!).toBeGreaterThan(Date.now() - 60_000);
    expect(await base.fieldOptions("KOL 跟进", "阶段")).toEqual(["已回复", "体验中", "已发布"]);
  });

  it("refuses unknown and computed fields, as the plugin treats Feishu ignoring them", async () => {
    await expect(base.update("KOL 跟进", { recF1: { 没这个: 1 } })).rejects.toThrow("没有这个字段");
    await expect(base.update("KOL 跟进", { recF1: { 公开邮箱: "x@y.z" } })).rejects.toThrow("自动算的字段");
    await expect(base.records("没这张表")).rejects.toThrow("not found");
    expect(await base.fieldNames("没这张表")).toBeNull();
  });

  it("adds tables and fields for setup-base", async () => {
    await base.lark.json(["base", "+table-create", "--base-token", TOKEN, "--name", "模板", "--fields", JSON.stringify([{ name: "名称", type: "text" }])]);
    await base.lark.json(["base", "+field-create", "--base-token", TOKEN, "--table-id", "模板", "--json", JSON.stringify({ name: "状态", type: "select", options: [{ name: "已批准" }] })]);
    await base.create("模板", [{ 名称: "邀约", 状态: "已批准" }]);
    expect(await base.records("模板", { filter: { logic: "and", conditions: [["状态", "intersects", ["已批准"]]] } })).toHaveLength(1);
  });

  it("backs up and restores the whole project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kol-backup-"));
    const { file, rows } = await backup(db, "p", dir);
    expect(rows).toBe(4);
    await base.create("接触记录", [{ 摘要: "备份之后" }]);
    await loadSnapshot(db, readBackup(file), "p", true);
    expect(await projectCounts(db, "p")).toMatchObject({ 接触记录: 1 });
    await expect(loadSnapshot(db, readBackup(file), "p", false)).rejects.toThrow("--replace");
  });

  it("gives each table a typed view for analysis", async () => {
    await createViews(db, "p");
    const rows = await db.query(`select 阶段, 下次跟进日期, 档案, 更新时间 from kol."p/KOL 跟进"`);
    expect(rows[0]).toMatchObject({ 阶段: "已回复", 档案: ["recP1"] });
    const [{ n }] = await db.query(`select sum(粉丝数)::int as n from kol."p/KOL 档案"`);
    expect(n).toBe(15000);
  });

  it("leaves other projects and mail to lark-cli", async () => {
    const fake = (base.lark as any).inner as FakeLark;
    fake.add("KOL 跟进", { 账号名称: "飞书那边" });
    expect(await base.lark.records("KOL 跟进", { baseToken: "anotherFeishuBase" })).toMatchObject([{ 账号名称: "飞书那边" }]);
    expect(await base.lark.json(["contact", "+get-user"])).toMatchObject({ user: { name: "测试运营" } });
  });
});
