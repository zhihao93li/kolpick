// End-to-end against a real PostgreSQL: TEST_DATABASE_URL (skipped when unset).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { connect, migrate, type Sql } from "../src/db.js";
import type { ActorKey, Item } from "../src/discovery/apify.js";
import { runDiscoveryJob } from "../src/jobs.js";
import { createApp } from "../src/web/app.js";
import { checkPassword, hashPassword, makeSession, readSession } from "../src/web/auth.js";

const url = process.env.TEST_DATABASE_URL;
const offline = { check: async () => "basic_ok" as const };

describe("auth", () => {
  it("checks hashed passwords and signed sessions", () => {
    const hash = hashPassword("s3cret");
    expect(checkPassword("s3cret", { hash, plain: "" })).toBe(true);
    expect(checkPassword("wrong", { hash, plain: "" })).toBe(false);
    expect(checkPassword("x", { hash: "", plain: "" })).toBe(false);
    const cookie = makeSession("k", "小美");
    expect(readSession("k", cookie)).toBe("小美");
    expect(readSession("other", cookie)).toBeNull();
    expect(readSession("k", cookie, Date.now() + 31 * 86400_000)).toBeNull();
  });
});

describe.skipIf(!url)("app with database", () => {
  let sql: Sql;
  const cfg: Config = {
    port: 0, databaseUrl: url!, apifyToken: "test", adminPasswordHash: "", adminPassword: "pw",
    sessionSecret: "secret", publicUrl: "",
  };
  const queued: number[] = [];
  let app: ReturnType<typeof createApp>;
  const cookie = `kol_session=${makeSession("secret", "Emma")}`;
  const form = (path: string, data: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) for (const x of [v].flat()) body.append(k, x);
    return app.request(path, { method: "POST", body, headers: { cookie, "content-type": "application/x-www-form-urlencoded" } });
  };

  beforeAll(async () => {
    sql = connect(url!);
    await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(sql);
    app = createApp(sql, cfg, { enqueueDiscovery: async (id) => void queued.push(id) });
  });
  afterAll(async () => sql?.end());

  it("redirects to login without a session and logs in with the password", async () => {
    expect((await app.request("/")).headers.get("location")).toBe("/login");
    const bad = await app.request("/login", { method: "POST", body: new URLSearchParams({ operator: "Emma", password: "no" }) });
    expect(bad.status).toBe(401);
    const ok = await app.request("/login", { method: "POST", body: new URLSearchParams({ operator: "Emma", password: "pw" }) });
    expect(ok.headers.get("set-cookie")).toContain("kol_session=");
  });

  it("creates a project, runs a job, reviews and exports", async () => {
    const created = await form("/projects", { name: "TAFU", slug: "tafu", region: "台湾", keywords: "新秘，親子", linkPages: "on", maxSpend: "5" });
    expect(created.status).toBe(302);
    const [project] = await sql`SELECT * FROM projects`;
    expect(project.discovery.keywords).toEqual(["新秘", "親子"]);

    const job = await form(`/projects/${project.id}/jobs`, { platform: "instagram", keywords: "新秘", linkPages: "on", maxSpend: "5" });
    expect(job.status).toBe(302);
    expect(queued).toHaveLength(1);

    const items: Partial<Record<ActorKey, Item[]>> = {
      ig_search: [
        { username: "Has_Email", fullName: "有信箱", searchTerm: "新秘", externalUrl: "https://portaly.cc/x" },
        { username: "noemail", fullName: "沒信箱", searchTerm: "新秘" },
      ],
      ig_email: [
        { username: "has_email", public_email: "Biz@Studio.tw", follower_count: 5000, biography: "合作 other@studio.tw" },
        { username: "noemail", follower_count: 800, biography: "私訊" },
      ],
    };
    const fake = { spent: 0.42, run: async (key: ActorKey) => items[key] ?? [] };
    await runDiscoveryJob(sql, cfg, queued[0], true, { makeRunner: () => fake, checker: offline });

    const [done] = await sql`SELECT * FROM discovery_jobs WHERE id = ${queued[0]}`;
    expect(done.status).toBe("done");
    expect([done.found, done.with_email, done.new_to_project]).toEqual([2, 1, 2]);
    const emails = await sql`SELECT email, source FROM kol_emails ORDER BY id`;
    expect(emails.map((e) => [e.email, e.source])).toEqual([["biz@studio.tw", "platform_field"], ["other@studio.tw", "bio"]]);

    const list = await app.request(`/projects/${project.id}/kols`, { headers: { cookie } });
    const html = await list.text();
    expect(html).toContain("has_email");
    expect(html).toContain("biz@studio.tw");

    const [kol] = await sql`SELECT id FROM kols WHERE handle = 'has_email'`;
    const reviewed = await form(`/projects/${project.id}/kols/review?status=candidate`, { action: "approved", ids: [String(kol.id)] });
    expect(reviewed.headers.get("location")).toContain("flash=");
    const [pk] = await sql`SELECT status, reviewed_by FROM project_kols WHERE kol_id = ${kol.id}`;
    expect([pk.status, pk.reviewed_by]).toEqual(["approved", "Emma"]);

    const raw = Buffer.from(await (await app.request(`/projects/${project.id}/kols.csv?status=approved`, { headers: { cookie } })).arrayBuffer());
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM, so Excel reads it as UTF-8
    const csv = raw.toString("utf8");
    expect(csv).toContain("platform,handle");
    expect(csv).toContain("biz@studio.tw");
    expect(csv).not.toContain("noemail");

    // A second job skips handles the project already has, and keeps their review status.
    const again = await form(`/projects/${project.id}/jobs`, { platform: "instagram", keywords: "新秘", maxSpend: "5" });
    expect(again.status).toBe(302);
    await runDiscoveryJob(sql, cfg, queued[1], true, { makeRunner: () => fake, checker: offline });
    const [second] = await sql`SELECT found, new_to_project FROM discovery_jobs WHERE id = ${queued[1]}`;
    expect([second.found, second.new_to_project]).toEqual([0, 0]);
    const [still] = await sql`SELECT status FROM project_kols WHERE kol_id = ${kol.id}`;
    expect(still.status).toBe("approved");
  });

  it("marks a job failed on the final attempt", async () => {
    const [{ id: projectId }] = await sql`SELECT id FROM projects`;
    const [{ id }] = await sql`INSERT INTO discovery_jobs (project_id, platform, params)
      VALUES (${projectId}, 'tiktok', ${sql.json({ platform: "tiktok", keywords: ["x"], seeds: [], handles: [], perKeyword: 5, maxSpend: 1 } as any)}) RETURNING id`;
    const boom = { spent: 0, run: async () => { throw new Error("actor exploded"); } };
    await expect(runDiscoveryJob(sql, cfg, Number(id), true, { makeRunner: () => boom })).rejects.toThrow("actor exploded");
    const [job] = await sql`SELECT status, message FROM discovery_jobs WHERE id = ${id}`;
    expect([job.status, job.message]).toEqual(["failed", "actor exploded"]);
  });
});
