import { promises as dns } from "node:dns";

// Free first-pass check: the address is well formed and its domain accepts mail.
// It only rules out obvious mistakes; deliverability stays unknown until a send.
// Only a hard bounce marks an address invalid, so a failed check here is "unknown".

const SYNTAX = /^[^\s@]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export type CheckStatus = "basic_ok" | "unknown";

export class EmailChecker {
  private domains = new Map<string, Promise<boolean>>();

  constructor(private resolve: (domain: string) => Promise<boolean> = acceptsMail) {}

  async check(email: string): Promise<CheckStatus> {
    if (!SYNTAX.test(email)) return "unknown";
    const domain = email.split("@")[1].toLowerCase();
    let ok = this.domains.get(domain);
    if (!ok) {
      ok = this.resolve(domain).catch(() => false);
      this.domains.set(domain, ok);
    }
    return (await ok) ? "basic_ok" : "unknown";
  }
}

async function acceptsMail(domain: string): Promise<boolean> {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.some((r) => r.exchange && r.exchange !== ".")) return true;
  } catch {
    // fall through: a domain with no MX record still receives mail at its A record
  }
  try {
    return (await dns.resolve4(domain)).length > 0;
  } catch {
    return false;
  }
}
