// Usage: npm run build
// Bundles src/kolpick/cli.ts into bin/kolpick.mjs, the one file `kolpick install` copies and runs.
import { build } from "esbuild";

await build({
  entryPoints: ["src/kolpick/cli.ts"],
  outfile: "bin/kolpick.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // The console page is one HTML file, inlined as a string.
  loader: { ".html": "text" },
  banner: {
    // apify-client is CommonJS and calls require() at load time; an ES module has none of its own.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __kpCreateRequire } from "node:module";',
      "const require = __kpCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
