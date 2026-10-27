import { defineConfig } from "vitest/config";

export default defineConfig({
  // The console page is plain HTML imported as text, the same way esbuild bundles it into kol.mjs.
  plugins: [{ name: "html-as-text", transform: (code, id) => (id.endsWith(".html") ? `export default ${JSON.stringify(code)};` : undefined) }],
  test: { setupFiles: ["tests/kolops/dns-setup.ts", "tests/kolpick/setup.ts"] },
});
