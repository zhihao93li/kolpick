import { describe, expect, it } from "vitest";
import { launcher } from "../../src/kolpick/install.js";

describe("kolpick.app", () => {
  it("starts the service only when it isn't answering, then opens the console", () => {
    const sh = launcher("/usr/local/bin/node", "/Users/me/.kolpick/bin/kolpick.mjs", "/Users/me/.kolpick/logs", 4791);
    expect(sh).toMatch(/if ! curl .*api\/local"; then\n  nohup '\/usr\/local\/bin\/node' '\/Users\/me\/\.kolpick\/bin\/kolpick\.mjs' serve/);
    expect(sh).toContain('--app="$URL"');
  });
});
