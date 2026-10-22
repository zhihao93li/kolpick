import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApifyRunner, type RunLedger, type RunRecord } from "../discovery/apify.js";
import { normalizeHandle, type Platform } from "../discovery/models.js";
import { DEFAULT_PARAMS, discover, type DiscoveryParams } from "../discovery/run.js";
import { text } from "./base.js";
import type { Ctx } from "./ctx.js";
import { profileEmails } from "./data.js";
import { dataDir } from "./ops.js";

const PLATFORM_OPTION: Record<Platform, string> = { instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok" };

export interface FindOpts {
  platform: Platform;
  keywords: string[];
  seeds: string[];
  handles: string[];
  minFollowers: number | null;
  maxFollowers: number | null;
  budget: number;
  /** 入库批次 for the new 档案 rows. */
  batch: string;
  /** Names this run's Apify ledger, so re-running the same job reuses finished actor runs instead of paying again. */
  job: string;
  youtubeHidden: boolean;
  dryRun: boolean;
}

/** Remembers each Apify run of a job on disk; a retried `kol find --job X` picks them up. */
class FileLedger implements RunLedger {
  private file: string;
  private data: Record<string, RunRecord & { status?: string }>;
  constructor(job: string) {
    this.file = join(dataDir(), `find-${job.replace(/[^\w一-鿿-]/g, "_")}.json`);
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
  }
  async find(step: string) {
    return this.data[step] ?? null;
  }
  async started(step: string, _actor: string, run: RunRecord) {
    this.data[step] = run;
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  async finished(step: string, r: { status: string }) {
    this.data[step] = { ...this.data[step], status: r.status };
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

export function apifyToken(): string {
  if (process.env.APIFY_TOKEN) return process.env.APIFY_TOKEN;
  const file = join(dataDir(), "apify-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  throw new Error(`没有 Apify token。把 token 存进 ${file}（只放在这台电脑上），或设置环境变量 APIFY_TOKEN`);
}

/**
 * `kol find`: runs discovery and email lookup, then adds people not already in 档案 (matched by handle
 * or any email). People without an email are added too, so nobody is paid for twice.
 */
export async function find(ctx: Ctx, o: FindOpts) {
  const t = ctx.cfg.tables;
  const batches = await ctx.base.fieldOptions(t.profiles, "入库批次");
  if (!batches?.includes(o.batch)) throw new Error(`「${o.batch}」还不是「入库批次」的选项，先在飞书里加上再找人（免得花了钱写不进去）`);
  const existing = await ctx.base.records(t.profiles, { fields: ["账号", "主页链接", "公开邮箱", "其他邮箱", "联系许可"] });
  const handles = new Set<string>();
  const emails = new Set<string>();
  for (const p of existing) {
    const h = handleOf(text(p["账号"])) || handleOf(text(p["主页链接"]));
    if (h) handles.add(h);
    for (const e of profileEmails(p)) emails.add(e);
  }

  const params: DiscoveryParams = {
    ...DEFAULT_PARAMS, platform: o.platform, keywords: o.keywords, seeds: o.seeds, handles: o.handles,
    minFollowers: o.minFollowers, maxFollowers: o.maxFollowers, youtubeHidden: o.youtubeHidden, maxSpend: o.budget,
  };
  if (o.dryRun) {
    return { 试跑: true, 已在库里的账号: handles.size, 参数: params, 说明: `正式运行最多花 $${o.budget}，到上限就停，已找到的照样入库` };
  }
  const runner = new ApifyRunner(apifyToken(), o.budget, new FileLedger(o.job));
  const result = await discover(runner, params, handles);

  const rows: Record<string, unknown>[] = [];
  let dupEmail = 0;
  let filtered = 0;
  for (const { creator: c, status } of result.creators) {
    if (status.startsWith("filtered")) {
      filtered++;
      continue;
    }
    const all = c.allEmails.map((e) => e.toLowerCase());
    if (all.some((e) => emails.has(e))) {
      dupEmail++;
      continue;
    }
    all.forEach((e) => emails.add(e));
    rows.push({
      账号: c.handle, 账号名称: c.name || c.handle, 主页链接: c.profileUrl, 主要平台: [PLATFORM_OPTION[c.platform]],
      ...(c.followers != null ? { 粉丝数: c.followers } : {}),
      ...(all[0] ? { 公开邮箱: all[0] } : {}),
      ...(all.length > 1 ? { 其他邮箱: all.slice(1).join(", ") } : {}),
      联系许可: ["可联系"], 入库批次: [o.batch],
      备注: `kol find ${o.job}：${c.discoveredBy}${c.emailSource ? `，邮箱来自 ${c.emailSource}` : ""}`,
    });
  }
  const ids = rows.length ? await ctx.base.create(t.profiles, rows) : [];
  ctx.run.op({ type: "飞书变更", result: "完成", action: `找人入库 ${rows.length} 人（${o.platform}）`, detail: `批次 ${o.batch}，花费约 $${runner.spent.toFixed(2)}` });
  return {
    新入库: ids.length,
    其中有邮箱: rows.filter((r) => r["公开邮箱"]).length,
    跳过_已在库里或邮箱重复: dupEmail,
    跳过_不符合条件: filtered,
    花费美元: Number(runner.spent.toFixed(2)),
    提前停止: result.stoppedEarly || undefined,
  };
}

function handleOf(s: string): string {
  if (!s) return "";
  const m = s.match(/(?:instagram\.com|tiktok\.com\/@?|youtube\.com\/@?)\/?@?([\w.-]+)/i);
  return normalizeHandle(m ? m[1] : s.includes("/") ? "" : s);
}
