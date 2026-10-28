import { describe, expect, it } from "vitest";
import { agentArgs } from "../../src/kolpick/agent.js";

describe("agent command line", () => {
  it("runs claude on the operator's subscription, not the relay in their personal settings", () => {
    const { bin, args } = agentArgs({ kind: "claude" } as any, "do it", "http://127.0.0.1:4791/mcp", "s1");
    expect(bin).toBe("claude");
    expect(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2)).toEqual(["--setting-sources", "project,local"]);
    expect(args.slice(-2)).toEqual(["--resume", "s1"]);
  });
});
