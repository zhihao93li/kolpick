import { useResolver, useTxtResolver } from "../../src/kolops/mx.js";

/** No test reaches the network: every domain takes mail, except the ones named here. */
export const NO_SUCH_DOMAIN = new Set(["gmail.com.tw", "nowhere.invalid"]);
/** Domains with no MX record but an address, like ms35.hinet.net. */
export const NO_MX = new Set(["ms35.hinet.net", "gmial.com"]);
useResolver(async (domain) => {
  if (NO_SUCH_DOMAIN.has(domain)) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  if (NO_MX.has(domain)) throw Object.assign(new Error("no data"), { code: "ENODATA" });
  return [{ exchange: `mx.${domain}`, priority: 10 }];
}, async () => ["203.0.113.1"]);

useTxtResolver(async (name) => {
  if (name === "tafu.me") return [["v=spf1 +include:_netblocks.m.feishu.cn -all"]];
  if (name === "_dmarc.tafu.me") return [["v=DMARC1; p=none"]];
  return [];
});
