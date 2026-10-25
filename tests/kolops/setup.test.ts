import { join } from "node:path";
import { expect, it } from "vitest";
import { Base } from "../../src/kolops/base.js";
import { REQUIRED_FIELDS, TABLES } from "../../src/kolops/schema.js";
import { checkBase, setupBase } from "../../src/kolops/setup.js";
import { FakeLark } from "./fake.js";
import { BASE } from "./project.js";

const templates = join(import.meta.dirname, "fixtures/templates");

/** A base copied from an older project: every working table, none of the settings tables. */
function olderBase(): FakeLark {
  const lark = new FakeLark();
  lark.schemas = {};
  for (const key of ["profiles", "followups", "contacts", "reviews", "oplog", "runs"] as const) {
    lark.schemas[TABLES[key]] = [...REQUIRED_FIELDS[key]!];
  }
  return lark;
}

it("adds the settings tables, a default 设置 row and the template files, and is safe to re-run", async () => {
  const lark = olderBase();
  const base = new Base(lark, BASE);

  const dry = await setupBase(base, { project: "新项目", dryRun: true, importDir: templates });
  expect(dry.建表).toHaveLength(3);
  expect(dry.写入默认设置).toBe(true);
  expect(lark.created).toHaveLength(0);
  expect(lark.table(TABLES.settings)).toHaveLength(0);

  const r = await setupBase(base, { project: "新项目", dryRun: false, importDir: templates, templateLanguage: "繁體中文" });
  expect(r.导入模板).toEqual(["催信-1", "邀约-测试"]);
  expect(lark.table(TABLES.settings)[0]).toMatchObject({ 项目名称: "新项目", 退信率暂停线: 6, 第一次催信天数: 5 });
  const imported = lark.table(TABLES.templates);
  expect(imported.map((t) => [t["名称"], t["用途"], t["状态"], t["语言"]])).toEqual([
    ["催信-1", ["催信 1"], ["待审核"], "繁體中文"],
    ["邀约-测试", ["邀约"], ["待审核"], "繁體中文"],
  ]);
  expect(imported[1]["主旨"]).toBe("想送 {稱呼} 一份體驗");

  const again = await setupBase(base, { project: "新项目", dryRun: false, importDir: templates });
  expect(again).toMatchObject({ 建表: [], 加字段: [], 写入默认设置: false, 导入模板: [] });
});

it("check lists what a base is missing", async () => {
  const lark = olderBase();
  lark.schemas![TABLES.followups] = lark.schemas![TABLES.followups].filter((f) => f !== "下一步");
  const r = await checkBase(new Base(lark, BASE));
  expect(r.缺少的表).toEqual(expect.arrayContaining([TABLES.settings, TABLES.mailboxes, TABLES.templates]));
  expect(r.缺少的字段).toEqual([`${TABLES.followups}.下一步`]);
});

it("adds 更新时间 to 档案 and 跟进 when a base lacks it", async () => {
  const lark = olderBase();
  lark.schemas![TABLES.profiles] = lark.schemas![TABLES.profiles].filter((f) => f !== "更新时间");
  const r = await setupBase(new Base(lark, BASE), { project: "p", dryRun: false });
  expect(r.加字段).toEqual([`${TABLES.profiles}.更新时间`, `${TABLES.followups}.体验码最近使用`]);
  expect(lark.created.map((c) => c.join(" ")).join("\n")).toContain('"type":"updated_at"');
});

it("adds the trial-code fields to 审核队列 and the new purposes to 模板.用途, keeping existing options", async () => {
  const lark = olderBase();
  lark.schemas![TABLES.reviews] = lark.schemas![TABLES.reviews].filter((f) => !f.startsWith("体验"));
  const base = new Base(lark, BASE);
  await setupBase(base, { project: "p", dryRun: false });
  lark.options["用途"] = ["邀约", "催信 1", "催信 2", "体验跟进", "其他"];
  const r = await setupBase(base, { project: "p", dryRun: false });
  expect(r.加选项).toEqual(["模板.用途：发体验码", "模板.用途：体验码延期", "模板.用途：体验未用", "模板.用途：体验到期"]);
  expect(lark.options["用途"]).toEqual(["邀约", "催信 1", "催信 2", "体验跟进", "其他", "发体验码", "体验码延期", "体验未用", "体验到期"]);
  expect(lark.schemas![TABLES.reviews]).toEqual(expect.arrayContaining(["体验码动作", "体验码", "体验次数", "体验天数"]));
});
