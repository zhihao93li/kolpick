import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// The plugin runs the bundled scripts/kol.mjs, not these sources, so a bundling mistake only shows up here.
const script = join(import.meta.dirname, "../../plugins/kol-ops/scripts/kol.mjs");

let dataDir = "";

function kol(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, KOL_LARK_CLI: "/nonexistent/lark-cli", KOL_DATA_DIR: dataDir },
  });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kol-bundle-"));
});

describe("bundled kol.mjs", () => {
  it("starts and prints help", () => {
    const r = kol("--help");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("kol <命令>");
  });

  it("asks for a project before anything else", () => {
    const r = kol("today");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("还没有登记项目");
  });

  it("explains a missing lark-cli instead of crashing", () => {
    expect(kol("project", "add", "tafu", "https://x.feishu.cn/base/XzwFbW2znaAqoSsQewGckSdTn5e").status).toBe(0);
    const r = kol("today");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("找不到 lark-cli");
    expect(r.stderr).not.toContain("    at ");
  });
});
