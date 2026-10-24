import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { configFrom, type Config } from "../../src/kolops/config.js";
import { makeCtx, type Ctx } from "../../src/kolops/ctx.js";
import { stamp } from "../../src/kolops/ops.js";
import { nextStep, remind } from "../../src/kolops/remind.js";
import { TABLES as T } from "../../src/kolops/schema.js";
import { FakeLark } from "./fake.js";
import { BASE, MAILBOXES, SETTINGS, seedProject } from "./project.js";

const cfg = configFrom("测试项目", BASE, { record_id: "s", ...SETTINGS }, MAILBOXES.map((m, i) => ({ record_id: `m${i}`, ...m })));
const base = {
  record_id: "f1", 阶段: ["已邀约"], 当前轮到谁: ["KOL"], 联系渠道: ["hello@tafu.me"], 级别: ["B"],
  首次邀约日期: "2026-10-22T10:00:00.000+08:00", 下次跟进日期: "2026-10-27T10:00:00.000+08:00", 最后来信日期: null,
};

describe("nextStep", () => {
  it("waits until the follow-up day, then sends the 1st and 2nd 催信, then closes", () => {
    expect(nextStep(cfg, base, 0, "2026-10-26").kind).toBe("wait");
    expect(nextStep(cfg, base, 0, "2026-10-27")).toEqual({ kind: "remind", n: 1 });
    expect(nextStep(cfg, base, 1, "2026-10-27")).toEqual({ kind: "remind", n: 2 });
    expect(nextStep(cfg, base, 2, "2026-10-27")).toEqual({ kind: "close" });
  });

  it("never chases someone who replied, old invitations, or the excluded groups", () => {
    expect(nextStep(cfg, { ...base, 最后来信日期: "2026-10-23T09:00:00.000+08:00" }, 0, "2026-10-27").kind).toBe("skip");
    expect(nextStep(cfg, { ...base, 首次邀约日期: "2026-10-01T10:00:00.000+08:00" }, 0, "2026-10-27").kind).toBe("skip");
    expect(nextStep(cfg, { ...base, 级别: ["S"] }, 0, "2026-10-27").kind).toBe("skip");
    expect(nextStep(cfg, { ...base, 对方要求: ["只接固定费"] }, 0, "2026-10-27").kind).toBe("skip");
    expect(nextStep(cfg, { ...base, 联系渠道: ["tafuofficial Gmail"] }, 0, "2026-10-27").kind).toBe("skip");
    expect(nextStep(cfg, { ...base, 当前轮到谁: ["我们"] }, 0, "2026-10-27").kind).toBe("skip");
  });
});

describe("remind", () => {
  let lark: FakeLark;
  let ctx: Ctx;
  let fid: string;

  function setup(over: Partial<typeof SETTINGS> = {}): Config {
    lark = new FakeLark();
    const c = seedProject(lark, over);
    const pid = lark.add(T.profiles, { 账号名称: "小鹿與阿哲", 称呼: "小鹿", 公开邮箱: "deer@example.com", 联系许可: ["可联系"] });
    const now = stamp(Date.now(), c.timezone);
    fid = lark.add(T.followups, { 账号名称: "小鹿與阿哲", 档案: [{ id: pid }], 阶段: ["已邀约"], 当前轮到谁: ["KOL"],
      联系渠道: ["hello@tafu.me"], 级别: ["B"], 首次邀约日期: now, 下次跟进日期: now });
    ctx = makeCtx(c, lark, { id: "ou_me", name: "测试" }, "催信和结案", true, async () => {});
    return c;
  }

  beforeEach(() => {
    process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  });

  it("sends the first 催信 from the approved template, with its own subject", async () => {
    setup();
    const r = await remind(ctx, { dryRun: false });
    expect(r.send.sent.map((x) => x.name)).toEqual(["小鹿與阿哲"]);
    const args = lark.sent[0].args;
    expect(args[args.indexOf("--subject") + 1]).toBe("想送 小鹿 3 次免費的完整體驗");
    expect(lark.table(T.contacts).find((c) => c["方向"]?.[0] === "发出")!["摘要"]).toMatch(/^\[催信\]/);
    expect(lark.table(T.followups).find((f) => f.record_id === fid)!["下一步"]).toMatch(/第 1 次催信/);
  });

  it("won't run without approved 催信 templates or a start date", async () => {
    setup();
    lark.table(T.templates).find((t) => t["名称"] === "催信-2")!["状态"] = ["待审核"];
    await expect(remind(ctx, { dryRun: true })).rejects.toThrow(/催信 2/);

    setup({ 自动催信起始日: "" });
    await expect(remind(ctx, { dryRun: true })).rejects.toThrow(/自动催信起始日/);
  });
});
