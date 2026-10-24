import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { makeCtx } from "../../src/kolops/ctx.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { todayLists } from "../../src/kolops/today.js";
import { FakeLark } from "./fake.js";
import { seedProject } from "./project.js";

it("keeps conversations on channels the plugin can't use in their own list", async () => {
  process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  const lark = new FakeLark();
  const cfg = seedProject(lark);
  const p1 = lark.add(T.profiles, { 账号名称: "飛書這邊" });
  const p2 = lark.add(T.profiles, { 账号名称: "Gmail 那邊" });
  lark.add(T.followups, { 账号名称: "飛書這邊", 档案: [{ id: p1 }], 阶段: ["已回复"], 当前轮到谁: ["我们"], 联系渠道: ["hello@tafu.me"] });
  const g = lark.add(T.followups, { 账号名称: "Gmail 那邊", 档案: [{ id: p2 }], 阶段: ["体验中"], 当前轮到谁: ["等你审核"], 联系渠道: ["tafuofficial Gmail"] });
  lark.add(T.reviews, { 状态: ["待你审核"], 类型: ["回复邮件"], 审核项: "回 Gmail 那邊", 发送渠道: ["tafuofficial Gmail"], KOL: [{ id: g }] });

  const r = await todayLists(makeCtx(cfg, lark, { id: "ou", name: "测试" }, "", false, async () => {}));
  expect(r.轮到我们.map((x) => x.name)).toEqual(["飛書這邊"]);
  expect(r.其他渠道要手动处理).toEqual([expect.objectContaining({ name: "Gmail 那邊", 渠道: "tafuofficial Gmail", 轮到: "等你审核" })]);
  expect(r.等你审核[0]).toMatchObject({ 发送渠道: "tafuofficial Gmail", 插件能发: false });
});
