/**
 * The project's kol-data API (docs/data-api.md): look up codes, create and extend trial codes, open partner
 * campaigns. Keys stay in the local config.
 */

export interface CodeInfo {
  code: string;
  found: boolean;
  kind?: "trial" | "partner" | "other";
  active?: boolean;
  maxUses?: number | null;
  used?: number;
  expiresAt?: string | null;
  paidOrders?: number;
  refundedOrders?: number;
  visitors?: number;
  refLink?: string;
  ledgerLink?: string;
  percentOff?: number;
  partnerId?: string;
  id?: string;
}

/** The API said no (4xx): nothing changed, and the message says why. */
export class Refused extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Code names: letters, digits, _ and -, 2 to 64 characters. */
export const CODE_RULE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
/** TAFU's own limits, checked before asking. */
export const TRIAL_LIMITS = { maxUses: 10, days: 60 };

export class TafuApi {
  constructor(private url: string, private keys: { dataApi?: string; trial?: string; partner?: string }, private fetchImpl: typeof fetch = fetch) {}

  private base(): string {
    if (!this.url) throw new Refused("NO_API", "设置里没填业务数据接口");
    return this.url.replace(/\/+$/, "");
  }

  /** Keyed "kind:code" in lower case; trial and partner codes may share a name. */
  async lookup(codes: string[]): Promise<Map<string, CodeInfo>> {
    if (!this.keys.dataApi) throw new Refused("NO_KEY", "这台电脑没有业务数据接口的只读密钥（kolpick setup）");
    const out = new Map<string, CodeInfo>();
    for (let i = 0; i < codes.length; i += 200) {
      const res = await this.fetchImpl(`${this.base()}/codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.keys.dataApi}` },
        body: JSON.stringify({ codes: codes.slice(i, i + 200) }),
      });
      if (res.status === 401) throw new Refused("UNAUTHORIZED", "业务数据接口拒绝了只读密钥（401）");
      if (!res.ok) throw new Error(`业务数据接口出错（${res.status}）`);
      const data: any = await res.json();
      for (const c of data?.codes ?? []) if (c.found) out.set(`${c.kind}:${String(c.code).toLowerCase()}`, c);
    }
    return out;
  }

  /** Same kolRef + same name returns the code made the first time, so a create may be asked again. */
  createTrial(body: { code: string; maxUses: number; days: number; kolName: string; followupId: string; operator: string }) {
    return this.write(this.keys.trial, "体验码写密钥", "/trial-codes", body);
  }

  /** Not idempotent: never asked twice for one approval. */
  extendTrial(code: string, body: { days: number; operator: string }) {
    return this.write(this.keys.trial, "体验码写密钥", `/trial-codes/${encodeURIComponent(code)}/extend`, body);
  }

  /** Same kolRef + same name returns the campaign opened the first time (docs/data-api.md), so it may be asked again. */
  createPartner(body: { code: string; partnerName: string; contact: string; market: string; percentOff: number; followupId: string; operator: string }) {
    return this.write(this.keys.partner, "活动码写密钥", "/partner-codes", body);
  }

  private async write(key: string | undefined, what: string, path: string, body: object): Promise<{ created?: boolean; code: CodeInfo }> {
    if (!key) throw new Refused("NO_KEY", `这台电脑没有${what}（kolpick setup）`);
    const res = await this.fetchImpl(`${this.base()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Refused("UNAUTHORIZED", `业务数据接口拒绝了${what}（401）`);
    if (res.status === 503) throw new Refused("NOT_CONFIGURED", "项目后台还没开通这个接口（503）");
    // A server error may come after the write went through: not a refusal.
    if (res.status >= 500) throw new Error(`业务数据接口出错（${res.status}）`);
    if (!res.ok) throw new Refused(String(data.error ?? res.status), String(data.message ?? `业务数据接口出错（${res.status}）`));
    return data;
  }
}

/** 15 → 「85 折」. */
export function discountWords(percentOff: number): string {
  const rest = 100 - percentOff;
  return `${rest % 10 ? rest : rest / 10} 折`;
}

/** A code name from the KOL's handle, the way codes have been named by hand. */
export function suggestCode(handle: string | null, name: string | null): string {
  const raw = (handle || name || "").replace(/^@+/, "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+/, "").slice(0, 64);
  return CODE_RULE.test(raw) ? raw : "";
}
