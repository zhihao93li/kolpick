/**
 * What lives only on this computer: database URLs, API keys, which database and project are in use, and the
 * command the console uses to call the local agent. File: ~/.kolpick/config.json (KOLPICK_HOME to move it).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProjectKeys {
  /** kol-data read key, trial-code write key, partner-code write key (docs/data-api.md). */
  dataApi?: string;
  trial?: string;
  partner?: string;
}

export interface AgentCommand {
  /** "claude" or "codex"; decides how the console passes the MCP server, reads the session id and resumes. */
  kind: "claude" | "codex";
  /** The executable; defaults to the kind's name. */
  bin?: string;
  /** Extra arguments, e.g. ["--model", "opus"]. */
  args?: string[];
}

export interface LocalConfig {
  /** Which database is in use: "test" or "prod". */
  env: "test" | "prod";
  databases: Partial<Record<"test" | "prod", string>>;
  /** Project the console and tools work on when none is named. */
  project: string;
  keys: Record<string, ProjectKeys>;
  apifyToken?: string;
  agent: AgentCommand;
  /** Port of the console and the MCP server (same process). */
  port: number;
}

export function home(): string {
  return process.env.KOLPICK_HOME || join(homedir(), ".kolpick");
}

const DEFAULT: LocalConfig = { env: "test", databases: {}, project: "tafu", keys: {}, agent: { kind: "claude" }, port: 4791 };

export function loadConfig(): LocalConfig {
  const file = join(home(), "config.json");
  if (!existsSync(file)) return structuredClone(DEFAULT);
  const stored = JSON.parse(readFileSync(file, "utf8"));
  return { ...structuredClone(DEFAULT), ...stored, agent: { ...DEFAULT.agent, ...(stored.agent ?? {}) } };
}

export function saveConfig(c: LocalConfig): void {
  mkdirSync(home(), { recursive: true });
  writeFileSync(join(home(), "config.json"), JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function databaseUrl(c: LocalConfig = loadConfig()): string {
  const url = process.env.KOLPICK_DATABASE_URL || c.databases[c.env];
  if (!url) throw new Error(`还没配置${c.env === "prod" ? "正式" : "测试"}数据库：运行 kolpick setup`);
  return url;
}
