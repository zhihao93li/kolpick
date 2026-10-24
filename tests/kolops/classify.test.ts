import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { applyClassification, bioOf, toClassify, withBio } from "../../src/kolops/classify.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

let lark: FakeLark;
let ctx: Ctx;
let fresh: string, done: string;
const dir = () => mkdtempSync(join(tmpdir(), "kol-test-"));

beforeEach(() => {
  process.env.KOL_DATA_DIR = dir();
  lark = new FakeLark();
  const cfg = seedProject(lark);
  lark.options = { ...lark.options, 合作邀约方向: ["伴侣", "亲子", "待確認"], 市场: ["台湾", "香港"], 語言: ["繁體中文", "英文"], 内容类型: ["亲子家庭", "其他"] };
  fresh = lark.add(T.profiles, { 账号: "deer_and_jay", 账号名称: "小鹿與阿哲", 入库批次: ["第三十批"],
    备注: withBio("kol find j1：search:親子", "兩個孩子的媽 | 台北\n合作邀約 deer@example.com") });
  done = lark.add(T.profiles, { 账号: "done", 账号名称: "已填好", 入库批次: ["第三十批"], 合作邀约方向: ["亲子"], 市场: ["台湾"], 語言: ["繁體中文"], 内容类型: ["亲子家庭"], 称呼: "好" });
  ctx = makeCtx(cfg, lark, { id: "ou", name: "测试" }, "补全档案", false, async () => {});
});

it("lists the batch's people still missing fields, with their bio and the allowed values", async () => {
  expect(bioOf(lark.table(T.profiles)[0]["备注"])).toBe("兩個孩子的媽 | 台北 合作邀約 deer@example.com");
  const r = await toClassify(ctx, { batch: "第三十批", limit: 50 });
  expect(r.名单.map((x) => x.id)).toEqual([fresh]);
  expect(r.名单[0].简介).toMatch(/兩個孩子的媽/);
  expect(r.可选值.市场).toEqual(["台湾", "香港"]);
});

it("writes valid values, and nothing at all when any value is wrong", async () => {
  const file = join(dir(), "c.json");
  writeFileSync(file, JSON.stringify({ [fresh]: { 合作邀约方向: "亲子", 市场: "台灣", 称呼: "@小鹿" } }));
  const bad = await applyClassification(ctx, { file, dryRun: false });
  expect(bad.写入).toBe(0);
  expect(bad.问题).toEqual([`${fresh}：「市场」没有「台灣」这个选项`]);
  expect(lark.table(T.profiles)[0]["合作邀约方向"]).toBeUndefined();

  writeFileSync(file, JSON.stringify({ [fresh]: { 合作邀约方向: "亲子", 市场: "台湾", 語言: "繁體中文", 内容类型: "亲子家庭", 称呼: "@小鹿" } }));
  expect((await applyClassification(ctx, { file, dryRun: false })).写入).toBe(1);
  expect(lark.table(T.profiles)[0]).toMatchObject({ 合作邀约方向: ["亲子"], 市场: ["台湾"], 称呼: "小鹿" });
  expect((await toClassify(ctx, { batch: "第三十批", limit: 50 })).还要补的人数).toBe(0);
});
