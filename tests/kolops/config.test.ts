import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { configFrom } from "../../src/kolops/config.js";
import { addProject, baseTokenFrom, removeProject, resolveBaseLink, resolveProject } from "../../src/kolops/projects.js";
import { BASE, MAILBOXES, SETTINGS } from "./project.js";

describe("configFrom", () => {
  it("reads lists, enabled mailboxes and the start day; empty cells fall back to defaults", () => {
    const cfg = configFrom("p", BASE, { record_id: "s", ...SETTINGS, 每分钟上限: "", 退信率暂停线: 4 },
      MAILBOXES.map((m, i) => ({ record_id: `m${i}`, ...m })));
    expect(cfg.mailboxes.map((m) => m.address)).toEqual(["hello@tafu.me", "mei@tafu.me"]);
    expect(cfg.mailboxes[0].bouncePause).toBe(4);
    expect(cfg.perMinute).toBe(30);
    expect(cfg.followup.skipChannels).toEqual(["IG 私信", "tafuofficial Gmail"]);
    expect(cfg.followup.skipLevels).toEqual(["S", "A"]);
    expect(cfg.followup.onlyInvitedOnOrAfter).toBe("2026-10-22");
    expect(cfg.discovery).toEqual({ country: "", language: "" });
  });
});

describe("projects", () => {
  beforeEach(() => {
    process.env.KOL_DATA_DIR = mkdtempSync(join(tmpdir(), "kol-test-"));
  });

  it("takes a base token from a Feishu link", () => {
    expect(baseTokenFrom("https://tafu.feishu.cn/base/XzwFbW2znaAqoSsQewGckSdTn5e?table=tbl1&view=vew2")).toBe("XzwFbW2znaAqoSsQewGckSdTn5e");
    expect(() => baseTokenFrom("https://tafu.feishu.cn/wiki/abc")).toThrow(/不是飞书多维表格/);
  });

  it("uses the default project, and asks which one when it can't tell", () => {
    expect(() => resolveProject()).toThrow(/还没有登记项目/);
    addProject("tafu", "XzwFbW2znaAqoSsQewGckSdTn5e");
    addProject("other", "OtherBaseToken0001");
    expect(resolveProject().name).toBe("tafu");
    expect(resolveProject("other").baseToken).toBe("OtherBaseToken0001");
    removeProject("tafu");
    expect(resolveProject().name).toBe("other");
    expect(() => resolveProject("nope")).toThrow(/没有登记/);
  });
});

describe("resolveBaseLink", () => {
  const lark = (node: object) => ({ json: async () => node, records: async () => [] });
  it("looks up the table behind a knowledge-base link", async () => {
    const wiki = "https://amt94r69je.feishu.cn/wiki/A86LwOfAKiYAuok6v4fcmLT3nBe?from=from_copylink";
    expect(await resolveBaseLink(lark({ obj_type: "bitable", obj_token: "AHdmbtvomaBhXrsZbfMcJr5An0g" }), wiki)).toBe("AHdmbtvomaBhXrsZbfMcJr5An0g");
    await expect(resolveBaseLink(lark({ obj_type: "docx", obj_token: "Doc123456789", title: "说明" }), wiki)).rejects.toThrow(/不是多维表格（是 docx）/);
  });
  it("takes a /base/ link without asking Feishu", async () => {
    const never = { json: async () => { throw new Error("should not be called"); }, records: async () => [] };
    expect(await resolveBaseLink(never, "https://x.feishu.cn/base/Vmdjb70JKaWLm8sO2jGc1jdbnBd?table=t")).toBe("Vmdjb70JKaWLm8sO2jGc1jdbnBd");
  });
});
