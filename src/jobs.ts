import { PgBoss, type Job } from "pg-boss";
import type { Config } from "./config.js";
import type { Sql } from "./db.js";
import { ApifyRunner, type ActorRunner, type RunLedger } from "./discovery/apify.js";
import { discover, type DiscoveryParams } from "./discovery/run.js";
import { EmailChecker } from "./emailcheck.js";
import { notifyFeishu } from "./notify.js";
import { projectHandles, saveResults } from "./store.js";

const DISCOVERY = "discovery";
// Long YouTube hidden-email runs took ~13 minutes for 30 channels; thousands take hours.
const DISCOVERY_EXPIRE_SECONDS = 6 * 3600;
const DISCOVERY_RETRIES = 2;

export interface Queue {
  enqueueDiscovery(jobId: number): Promise<void>;
  stop(): Promise<void>;
}

/** Records each Apify run of a job in apify_runs; a failed run is started afresh on retry. */
function ledger(sql: Sql, jobId: number): RunLedger {
  return {
    async find(step) {
      const [row] = await sql<{ run_id: string; dataset_id: string }[]>`
        SELECT run_id, dataset_id FROM apify_runs
        WHERE job_id = ${jobId} AND step = ${step} AND status NOT IN ('FAILED', 'ABORTED', 'TIMED-OUT')`;
      return row ? { runId: row.run_id, datasetId: row.dataset_id } : null;
    },
    async started(step, actor, run) {
      await sql`INSERT INTO apify_runs (job_id, step, actor, run_id, dataset_id)
                VALUES (${jobId}, ${step}, ${actor}, ${run.runId}, ${run.datasetId})
                ON CONFLICT (job_id, step) DO UPDATE SET run_id = EXCLUDED.run_id, dataset_id = EXCLUDED.dataset_id,
                  status = 'RUNNING', items = NULL, cost_usd = NULL, started_at = now(), finished_at = NULL`;
    },
    async finished(step, r) {
      await sql`UPDATE apify_runs SET status = ${r.status}, items = ${r.items}, cost_usd = ${r.costUsd}, finished_at = now()
                WHERE job_id = ${jobId} AND step = ${step}`;
    },
  };
}

export interface JobDeps {
  makeRunner?: (maxSpend: number) => ActorRunner & { spent: number };
  checker?: Pick<EmailChecker, "check">;
}

export async function runDiscoveryJob(sql: Sql, cfg: Config, jobId: number, finalAttempt: boolean,
                                      deps: JobDeps = {}): Promise<void> {
  const makeRunner = deps.makeRunner ?? ((maxSpend: number) => new ApifyRunner(cfg.apifyToken, maxSpend, ledger(sql, jobId)));
  const [job] = await sql<{ project_id: number; params: DiscoveryParams; webhook: string; project: string }[]>`
    SELECT j.project_id, j.params, p.feishu_webhook AS webhook, p.name AS project
    FROM discovery_jobs j JOIN projects p ON p.id = j.project_id WHERE j.id = ${jobId}`;
  if (!job) return;
  const link = cfg.publicUrl ? ` ${cfg.publicUrl}/projects/${job.project_id}/jobs/${jobId}` : "";
  await sql`UPDATE discovery_jobs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = ${jobId}`;
  if (!cfg.apifyToken && !deps.makeRunner) {
    // A settings problem, not a passing failure: fail at once instead of retrying.
    await sql`UPDATE discovery_jobs SET status = 'failed', finished_at = now(), message = '没有配置 APIFY_TOKEN' WHERE id = ${jobId}`;
    return;
  }
  try {
    const runner = makeRunner(job.params.maxSpend);
    const skip = await projectHandles(sql, job.project_id, job.params.platform);
    const result = await discover(runner, job.params, skip);
    const summary = await saveResults(sql, deps.checker ?? new EmailChecker(), job.project_id, jobId, result);
    await sql`UPDATE discovery_jobs SET status = 'done', finished_at = now(), message = ${result.stoppedEarly},
                spent_usd = ${runner.spent}, found = ${summary.found}, with_email = ${summary.withEmail},
                new_to_project = ${summary.newToProject}
              WHERE id = ${jobId}`;
    const early = result.stoppedEarly ? `（${result.stoppedEarly}，提前停止）` : "";
    await notifyFeishu(job.webhook, `${job.project} 找人任务 #${jobId} 完成${early}：找到 ${summary.found} 人，` +
      `${summary.withEmail} 人有邮箱，新增 ${summary.newToProject} 人待审核，约花费 $${runner.spent.toFixed(2)}。${link}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (finalAttempt) {
      await sql`UPDATE discovery_jobs SET status = 'failed', finished_at = now(), message = ${message} WHERE id = ${jobId}`;
      await notifyFeishu(job.webhook, `${job.project} 找人任务 #${jobId} 失败：${message}${link}`);
    } else {
      await sql`UPDATE discovery_jobs SET status = 'queued', message = ${`稍后重试：${message}`} WHERE id = ${jobId}`;
    }
    throw err;
  }
}

export async function startQueue(sql: Sql, cfg: Config): Promise<Queue> {
  const boss = new PgBoss(cfg.databaseUrl);
  boss.on("error", (err) => console.error("queue error", err));
  await boss.start();
  await boss.createQueue(DISCOVERY, {
    expireInSeconds: DISCOVERY_EXPIRE_SECONDS, retryLimit: DISCOVERY_RETRIES, retryDelay: 60, retryBackoff: true,
  });
  // Discovery is slow and mostly waits on Apify; two at a time keeps spend predictable.
  await boss.work<{ jobId: number }>(DISCOVERY, { localConcurrency: 2 }, async (jobs: Job<{ jobId: number }>[]) => {
    for (const job of jobs) {
      await runDiscoveryJob(sql, cfg, job.data.jobId, job.retryCount >= DISCOVERY_RETRIES);
    }
  });
  return {
    async enqueueDiscovery(jobId) {
      await boss.send(DISCOVERY, { jobId });
    },
    stop: () => boss.stop(),
  };
}
