import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Mailbox {
  address: string;
  /** The option name this mailbox has in the 渠道 / 联系渠道 / 发送渠道 selects. */
  channel: string;
  dailyExternal: number;
}

export interface Config {
  baseToken: string;
  timezone: string;
  tables: {
    profiles: string; followups: string; contacts: string; reviews: string;
    oplog: string; runs: string; control: string; posts: string; settlements: string;
  };
  mailboxes: Mailbox[];
  companyDailyExternal: number;
  perMinute: number;
  followup: {
    firstAfterDays: number;
    secondAfterDays: number;
    closeAfterDays: number;
    /** Only invitations sent on or after this day are chased automatically. */
    onlyInvitedOnOrAfter: string;
    skipLevels: string[];
    skipDemands: string[];
    skipChannels: string[];
  };
  templatesDir: string;
}

/** The plugin root: the bundled script lives in <root>/scripts/, the sources in src/kolops/. */
export function pluginRoot(): string {
  if (process.env.KOL_PLUGIN_ROOT) return process.env.KOL_PLUGIN_ROOT;
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith("scripts") ? dirname(here) : join(here, "..", "..", "plugins", "kol-ops");
}

export function loadConfig(root = pluginRoot()): Config {
  return JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
}

export function mailboxFor(cfg: Config, channel: string): Mailbox | undefined {
  return cfg.mailboxes.find((m) => m.channel === channel || m.address === channel);
}
