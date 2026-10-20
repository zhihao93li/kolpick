import type { Sql } from "./db.js";
import type { EmailChecker } from "./emailcheck.js";
import { normalizeHandle, type Platform } from "./discovery/models.js";
import type { DiscoveryResult } from "./discovery/run.js";

/** Handles this project already has on a platform, so a job doesn't pay to look them up again. */
export async function projectHandles(sql: Sql, projectId: number, platform: Platform): Promise<Set<string>> {
  const rows = await sql<{ handle: string }[]>`
    SELECT k.handle FROM project_kols pk JOIN kols k ON k.id = pk.kol_id
    WHERE pk.project_id = ${projectId} AND k.platform = ${platform}`;
  return new Set(rows.map((r) => r.handle));
}

export interface SaveSummary {
  found: number;
  withEmail: number;
  newToProject: number;
}

/**
 * Save a job's kept creators into the shared pool and add them to the project as candidates.
 * Filtered creators (private, outside the follower range, ...) are not saved.
 * Existing KOLs get fresher profile fields; their project status is left alone.
 */
export async function saveResults(sql: Sql, checker: Pick<EmailChecker, "check">, projectId: number, jobId: number,
                                  result: DiscoveryResult): Promise<SaveSummary> {
  const summary: SaveSummary = { found: 0, withEmail: 0, newToProject: 0 };
  for (const { creator: c, status } of result.creators) {
    if (status.startsWith("filtered:")) continue;
    summary.found++;
    if (c.email) summary.withEmail++;
    const checks = await Promise.all(c.emails.map((e) => checker.check(e.email)));
    await sql.begin(async (tx) => {
      const [kol] = await tx<{ id: number }[]>`
        INSERT INTO kols (platform, handle, profile_url, name, followers, is_business, is_private, bio, external_url)
        VALUES (${c.platform}, ${normalizeHandle(c.handle)}, ${c.profileUrl}, ${c.name}, ${c.followers},
                ${c.isBusiness}, ${c.isPrivate}, ${c.bio}, ${c.externalUrl})
        ON CONFLICT (platform, handle) DO UPDATE SET
          profile_url  = COALESCE(NULLIF(EXCLUDED.profile_url, ''), kols.profile_url),
          name         = COALESCE(NULLIF(EXCLUDED.name, ''), kols.name),
          followers    = COALESCE(EXCLUDED.followers, kols.followers),
          is_business  = COALESCE(EXCLUDED.is_business, kols.is_business),
          is_private   = COALESCE(EXCLUDED.is_private, kols.is_private),
          bio          = COALESCE(NULLIF(EXCLUDED.bio, ''), kols.bio),
          external_url = COALESCE(NULLIF(EXCLUDED.external_url, ''), kols.external_url),
          refreshed_at = now()
        RETURNING id`;
      for (const [i, e] of c.emails.entries()) {
        const sourceUrl = e.source === "link_page" ? c.externalUrl : c.profileUrl;
        await tx`
          INSERT INTO kol_emails (kol_id, email, source, source_url, check_status)
          VALUES (${kol.id}, ${e.email.toLowerCase()}, ${e.source}, ${sourceUrl}, ${checks[i]})
          ON CONFLICT (kol_id, email) DO UPDATE SET
            last_seen_at = now(),
            -- never lift an address back out of invalid; only a person or a bounce decides that
            check_status = CASE WHEN kol_emails.check_status = 'invalid' THEN 'invalid' ELSE EXCLUDED.check_status END`;
      }
      const added = await tx`
        INSERT INTO project_kols (project_id, kol_id, discovered_by, job_id)
        VALUES (${projectId}, ${kol.id}, ${c.discoveredBy}, ${jobId})
        ON CONFLICT (project_id, kol_id) DO NOTHING
        RETURNING kol_id`;
      summary.newToProject += added.length;
    });
  }
  return summary;
}
