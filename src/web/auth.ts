// One shared login (you decided: non-core parts stay simple). The operator types their name at
// login so reviews record who did them.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_DAYS = 30;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 32).toString("hex")}`;
}

export function checkPassword(password: string, opts: { hash: string; plain: string }): boolean {
  if (opts.hash) {
    const [kind, salt, hash] = opts.hash.split("$");
    if (kind !== "scrypt" || !salt || !hash) return false;
    const got = scryptSync(password, Buffer.from(salt, "hex"), 32);
    return timingSafeEqual(got, Buffer.from(hash, "hex"));
  }
  if (!opts.plain) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(opts.plain);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function makeSession(secret: string, operator: string, now = Date.now()): string {
  const value = `${now + SESSION_DAYS * 86400_000}.${Buffer.from(operator).toString("base64url")}`;
  return `${value}.${sign(secret, value)}`;
}

/** The operator name of a valid, unexpired session cookie, or null. */
export function readSession(secret: string, cookie: string | undefined, now = Date.now()): string | null {
  if (!cookie) return null;
  const i = cookie.lastIndexOf(".");
  const value = cookie.slice(0, i);
  const sig = Buffer.from(cookie.slice(i + 1));
  const want = Buffer.from(sign(secret, value));
  if (i < 0 || sig.length !== want.length || !timingSafeEqual(sig, want)) return null;
  const [expires, name] = value.split(".");
  if (Number(expires) < now) return null;
  return Buffer.from(name ?? "", "base64url").toString() || null;
}

/** At most 10 failed logins per address per 15 minutes. */
export class LoginLimiter {
  private failures = new Map<string, number[]>();

  blocked(ip: string, now = Date.now()): boolean {
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
    this.failures.set(ip, recent);
    return recent.length >= 10;
  }

  fail(ip: string, now = Date.now()): void {
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), now]);
  }
}
