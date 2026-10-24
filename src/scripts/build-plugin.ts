// Usage: npm run build:plugin
// Bundles src/kolops/cli.ts into plugins/kol-ops/scripts/kol.mjs, the one file the plugin runs.
import { build } from "esbuild";

await build({
  entryPoints: ["src/kolops/cli.ts"],
  outfile: "plugins/kol-ops/scripts/kol.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    // apify-client and its dependencies are CommonJS and call require("fs") at load time. An ES module has no
    // require, so without this the script dies on startup with "Dynamic require of "fs" is not supported".
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __kolCreateRequire } from "node:module";',
      "const require = __kolCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
