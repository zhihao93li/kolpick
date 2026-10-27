import { useResolver } from "../../src/kolpick/mx.js";

/** No test reaches the network: every domain takes mail except nowhere.invalid. */
useResolver(async (domain) => {
  if (domain === "nowhere.invalid") throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  return [{ exchange: `mx.${domain}`, priority: 10 }];
}, async () => ["203.0.113.1"]);
