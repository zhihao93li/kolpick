import { ApifyClient } from "apify-client";

// Actors used by the pipeline, with BRONZE-tier prices checked on 2026-10-20 (USD).
// perItem is what one output row roughly costs; start is a fixed per-run fee.
export const ACTORS = {
  ig_related: { id: "thenetaji/instagram-related-user-scraper", perItem: 0.003, start: 0 },
  ig_search: { id: "apify/instagram-search-scraper", perItem: 0.0026, start: 0 },
  ig_email: { id: "devil_port369-owner/instagram-email-phone-scraper-pay-per-result", perItem: 0.0045, start: 0.04 },
  link_pages: { id: "vdrmota/contact-info-scraper", perItem: 0.01, start: 0 },
  yt_search: { id: "maximedupre/youtube-channel-search-scraper", perItem: 0.0007, start: 0 },
  yt_profile: { id: "flash_scraper/creator-leads-scraper", perItem: 0.0018, start: 0 },
  yt_hidden: { id: "dataovercoffee/Youtube-Channel-Business-Email-Scraper", perItem: 0.12, start: 0 },
  tt_search: { id: "clockworks/tiktok-user-search-scraper", perItem: 0.005, start: 0 },
  tt_profile: { id: "clockworks/tiktok-profile-scraper", perItem: 0.002, start: 0 },
  // Post stats for 发布内容 (kol metrics); prices are rough, checked 2026-10-24. TikTok charges at least $0.50 a run.
  ig_post: { id: "apify/instagram-scraper", perItem: 0.0027, start: 0 },
  tt_post: { id: "clockworks/tiktok-scraper", perItem: 0.005, start: 0.5 },
  yt_video: { id: "streamers/youtube-scraper", perItem: 0.005, start: 0 },
} as const;

export type ActorKey = keyof typeof ACTORS;
export type Item = Record<string, any>;

export class BudgetExceeded extends Error {}

/** What the pipeline needs from Apify; tests swap in a fake. */
export interface ActorRunner {
  run(key: ActorKey, input: Item, expectedItems: number): Promise<Item[]>;
}

export function estimate(key: ActorKey, expectedItems: number): number {
  const a = ACTORS[key];
  return a.start + a.perItem * expectedItems;
}

/** A finished or in-flight Apify run, as recorded so a restarted job can pick it up instead of paying twice. */
export interface RunRecord {
  runId: string;
  datasetId: string;
}

export interface RunLedger {
  /** A run already started for this step of this job, if any. */
  find(step: string): Promise<RunRecord | null>;
  started(step: string, actor: string, run: RunRecord): Promise<void>;
  finished(step: string, result: { status: string; items: number; costUsd: number }): Promise<void>;
}

/** Apify refuses a run whose maxTotalChargeUsd is below this. */
export const MIN_CHARGE_CAP = 0.5;

/**
 * The charge cap for one run: the estimate plus 30% headroom, raised to Apify's minimum and clipped to what's
 * left of the budget; null when what's left is below the minimum. The cap only bounds the run: pay-per-result
 * actors charge for what they return, so a small run still costs about its estimate.
 */
export function chargeCap(estimateUsd: number, left: number): number | null {
  const cap = Math.min(Math.max(estimateUsd * 1.3 + 0.05, MIN_CHARGE_CAP), left);
  return cap < MIN_CHARGE_CAP ? null : Math.floor(cap * 100) / 100;
}

/** Runs actors with a spend cap. Each step is recorded in the ledger before waiting on it. */
export class ApifyRunner implements ActorRunner {
  private client: ApifyClient;
  spent = 0;

  // A retried job replays the pipeline from the top; every step it already ran is found in the
  // ledger and re-read from its dataset, so `spent` adds each step's cost exactly once.
  constructor(token: string, private maxSpend: number, private ledger: RunLedger) {
    this.client = new ApifyClient({ token });
  }

  async run(key: ActorKey, input: Item, expectedItems: number): Promise<Item[]> {
    const actor = ACTORS[key].id;
    let record = await this.ledger.find(key);
    if (!record) {
      const left = this.maxSpend - this.spent;
      const cap = chargeCap(estimate(key, expectedItems), left);
      if (cap == null) throw new BudgetExceeded(`预算 $${this.maxSpend.toFixed(2)} 只剩 $${Math.max(0, left).toFixed(2)}，不够 Apify 每次运行最低的 $${MIN_CHARGE_CAP.toFixed(2)} 上限，${actor} 没有启动`);
      const run = await this.client.actor(actor).start(input, { maxTotalChargeUsd: cap });
      record = { runId: run.id, datasetId: run.defaultDatasetId };
      await this.ledger.started(key, actor, record);
    }
    const run = await this.client.run(record.runId).waitForFinish();
    const items: Item[] = [];
    // Datasets are paged; a few thousand rows is the most a step returns.
    for (let offset = 0; ; offset += 1000) {
      const page = await this.client.dataset(record.datasetId).listItems({ offset, limit: 1000, clean: true });
      items.push(...(page.items as Item[]));
      if (page.items.length < 1000) break;
    }
    if (run.status !== "SUCCEEDED" && items.length === 0) {
      await this.ledger.finished(key, { status: run.status, items: 0, costUsd: run.usageTotalUsd ?? 0 });
      throw new Error(`${actor} 运行失败（${run.status}），run ${record.runId}`);
    }
    // usageTotalUsd may leave out pay-per-event charges, so keep the larger of it and the
    // price-table estimate as a conservative running total.
    const cost = Math.max(run.usageTotalUsd ?? 0, estimate(key, items.length));
    this.spent += cost;
    await this.ledger.finished(key, { status: run.status, items: items.length, costUsd: cost });
    return items;
  }
}
