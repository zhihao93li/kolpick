import { expect, it } from "vitest";
import { warmupLimit } from "../../src/kolops/config.js";
import { senderDomain, useResolver } from "../../src/kolops/mx.js";

const NOW = Date.parse("2026-10-25T10:00:00+08:00");

it("ramps a new mailbox up from 起步上限 by 每天增加 a day, up to 每日上限", () => {
  const m = { record_id: "m", 每日上限: 150, 起步上限: 20, 每天增加: 10, 启用日期: "2026-10-23 09:00" };
  expect(warmupLimit(m, "+08:00", NOW)).toEqual({ limit: 40, note: "预热第 3 天，今天 40 / 上限 150" });
  expect(warmupLimit({ ...m, 启用日期: "2026-09-01 09:00" }, "+08:00", NOW)).toEqual({ limit: 150 });
  expect(warmupLimit({ record_id: "m", 每日上限: 150 }, "+08:00", NOW)).toEqual({ limit: 150 });
});

it("checks a sending domain's SPF, DMARC and MX", async () => {
  useResolver(async (d) => (d === "tafu.me" ? [{ exchange: "mx1.feishu.cn", priority: 1 }] : [{ exchange: `mx.${d}`, priority: 10 }]));
  expect((await senderDomain("tafu.me")).问题).toEqual([]);
  const bad = await senderDomain("new-brand.com");
  expect(bad.问题.map((p) => p.split("：")[0])).toEqual(["没有 SPF 记录", "没有 DMARC 记录", "MX 不是飞书的"]);
});
