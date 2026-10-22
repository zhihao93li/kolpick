import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/kolops/config.js";
import { nextStep } from "../../src/kolops/remind.js";

const cfg = loadConfig(join(import.meta.dirname, "../../plugins/kol-ops"));
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
