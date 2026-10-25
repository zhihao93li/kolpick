import { promises as dns } from "node:dns";

type Resolver = (domain: string) => Promise<{ exchange: string; priority: number }[]>;
type HostResolver = (domain: string) => Promise<string[]>;
let resolver: Resolver = (d) => dns.resolveMx(d);
let hosts: HostResolver = (d) => dns.resolve4(d).catch(() => dns.resolve6(d));

/** Tests swap in their own resolvers so nothing goes to the network. */
export function useResolver(fn: Resolver, hostFn?: HostResolver): void {
  resolver = fn;
  if (hostFn) hosts = hostFn;
}

/**
 * Why mail to this address can't be delivered, judged from its domain's MX records, or "" when it can (or when
 * DNS couldn't say: a lookup that times out never holds a mail back). Cached per domain for the run.
 */
export async function undeliverable(address: string, cache: Map<string, Promise<string>>): Promise<string> {
  const domain = address.split("@")[1]?.trim().toLowerCase() ?? "";
  if (!domain) return "收件人邮箱格式不对";
  if (!cache.has(domain)) cache.set(domain, check(domain));
  return cache.get(domain)!;
}

async function check(domain: string): Promise<string> {
  try {
    const mx = await resolver(domain);
    // A null MX ("." or empty) is the domain saying it takes no mail at all.
    if (!mx.length || mx.every((r) => !r.exchange || r.exchange === ".")) return `邮箱域名 ${domain} 声明不收邮件`;
    return "";
  } catch (err: any) {
    if (err?.code === "ENOTFOUND") return `邮箱域名 ${domain} 不存在（拼错了或已经停用）${typoHint(domain)}`;
    if (err?.code !== "ENODATA") return "";
    // No MX: mail goes to the domain's own address (many Taiwanese ISP domains, like ms35.hinet.net, work this
    // way), unless the domain is a slip of a common one. gmial.com has an address too, but nobody reads mail there.
    const hint = typoHint(domain);
    if (hint) return `邮箱域名 ${domain} 多半是拼错了${hint}`;
    const addresses = await hosts(domain).catch(() => [] as string[]);
    return addresses.length ? "" : `邮箱域名 ${domain} 没有收信服务器（没有 MX 记录，也没有地址）`;
  }
}

const COMMON = ["gmail.com", "yahoo.com", "yahoo.com.tw", "hotmail.com", "outlook.com", "icloud.com", "msn.com", "live.com", "qq.com", "163.com"];

/** 「，是不是 gmail.com？」 for a domain one or two letters off a common one. */
function typoHint(domain: string): string {
  const near = COMMON.find((c) => c !== domain && distance(c, domain) <= 2);
  return near ? `，是不是 ${near}？` : "";
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
