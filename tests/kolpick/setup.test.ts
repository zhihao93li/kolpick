import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/kolpick/config.js";
import { fromKolOps, ready, saveSetup } from "../../src/kolpick/setup.js";

describe("setting up this computer", () => {
  const env = { ...process.env };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kolpick-setup-"));
    process.env.HOME = dir;
    process.env.KOLPICK_HOME = join(dir, ".kolpick");
    delete process.env.KOLPICK_DATABASE_URL;
  });
  afterEach(() => {
    for (const k of ["HOME", "KOLPICK_HOME", "KOLPICK_DATABASE_URL"]) if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  });

  it("isn't ready until the database in use has a URL", () => {
    const cfg = loadConfig();
    expect(ready(cfg)).toBe(false);
    cfg.databases.prod = "postgres://x";
    expect(ready(cfg)).toBe(false);
    cfg.databases.test = "postgres://y";
    expect(ready(cfg)).toBe(true);
  });

  it("keeps what is there when a field is left empty, and won't save without the database in use", async () => {
    const cfg = loadConfig();
    await expect(saveSetup(cfg, { dataApi: "k1" })).rejects.toThrow(/测试库/);
    cfg.databases.test = "postgres://y";
    cfg.keys.tafu = { trial: "old" };
    await saveSetup(cfg, { dataApi: " k1 ", trial: "", apify: "tok" });
    const saved = JSON.parse(readFileSync(join(dir, ".kolpick", "config.json"), "utf8"));
    expect(saved.keys.tafu).toEqual({ trial: "old", dataApi: "k1" });
    expect(saved.apifyToken).toBe("tok");
  });

  it("won't switch to a database that has no URL", async () => {
    const cfg = loadConfig();
    cfg.databases.test = "postgres://y";
    await expect(saveSetup(cfg, { env: "prod" })).rejects.toThrow(/正式库/);
    expect(cfg.env).toBe("test");
  });

  it("takes old kol-ops keys only when there are some and only for what is missing", () => {
    const cfg = loadConfig();
    fromKolOps(cfg);
    expect(cfg.keys).toEqual({});
    mkdirSync(join(dir, ".kol-ops"));
    writeFileSync(join(dir, ".kol-ops", "projects.json"), JSON.stringify({ projects: { tafu: { dataApiKey: "d", trialKey: "t" }, "tafu-test": { dataApiKey: "x" } } }));
    writeFileSync(join(dir, ".kol-ops", "apify-token"), "ap\n");
    cfg.keys.tafu = { dataApi: "mine" };
    fromKolOps(cfg);
    expect(cfg.keys).toEqual({ tafu: { dataApi: "mine", trial: "t" } });
    expect(cfg.apifyToken).toBe("ap");
  });
});
