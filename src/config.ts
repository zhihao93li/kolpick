// Settings come from environment variables (Zeabur service variables in production, .env locally).
import { existsSync, readFileSync } from "node:fs";

/** Read KEY=VALUE lines from .env into process.env; variables already set win. */
export function loadDotenv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}，见 README 的「部署」一节`);
  return value;
}

export function loadConfig() {
  loadDotenv();
  return {
    port: Number(process.env.PORT || 8080),
    databaseUrl: required("DATABASE_URL"),
    // Optional so the site starts without it; discovery jobs fail with a clear message instead.
    apifyToken: process.env.APIFY_TOKEN || "",
    // scrypt hash from `npm run hash-password`; ADMIN_PASSWORD (plain) is accepted for local use.
    adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || "",
    adminPassword: process.env.ADMIN_PASSWORD || "",
    sessionSecret: required("SESSION_SECRET"),
    publicUrl: (process.env.PUBLIC_URL || "").replace(/\/+$/, ""),
  };
}

export type Config = ReturnType<typeof loadConfig>;
