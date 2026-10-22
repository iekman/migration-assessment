import { readFileSync } from "node:fs";
import type { IMcpClient, McpToolSummary } from "./firebaseMcpClient.js";

/**
 * Fixture-backed stand-in for ReadOnlyMcpClient, used by `--mock` so the
 * full pipeline can run and be demoed without live Firebase credentials
 * or a spawned `firebase mcp` process.
 */
export class MockMcpClient implements IMcpClient {
  private fixtures: Record<string, unknown>;
  private toolNames: string[];

  constructor(fixturePath: string) {
    this.fixtures = JSON.parse(readFileSync(fixturePath, "utf-8"));
    this.toolNames = Object.keys(this.fixtures.responses as Record<string, unknown>);
  }

  async listTools(): Promise<McpToolSummary[]> {
    return this.toolNames.map((name) => ({ name, readOnly: true }));
  }

  async resolveToolName(...candidates: string[]): Promise<string | null> {
    for (const c of candidates) {
      if (this.toolNames.includes(c)) return c;
    }
    return null;
  }

  async callReadOnlyTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const responses = this.fixtures.responses as Record<string, unknown>;
    const entry = responses[name];
    if (entry === undefined) {
      throw new Error(`[mock] no fixture response registered for tool "${name}"`);
    }
    throwIfThrowSentinel(entry, name);
    if (typeof entry === "object" && entry !== null && "__byArg__" in (entry as object)) {
      const spec = entry as { __byArg__: string; values: Record<string, unknown> };
      const key = String(args[spec.__byArg__]);
      const value = spec.values[key] ?? spec.values.default ?? {};
      throwIfThrowSentinel(value, `${name} (${spec.__byArg__}="${key}")`);
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(entry) }] };
  }
}

/**
 * Lets a fixture simulate a call-time failure for one specific tool call or
 * one specific __byArg__ key, instead of only "this tool doesn't exist at
 * all" (which resolveToolName already screens out before any collector's
 * try/catch is reached). Without this, every catch block in every collector
 * is structurally unreachable in --mock mode: a tool name either has a
 * fixture entry (so every call to it always succeeds) or it doesn't (so
 * resolveToolName returns null and the collector never calls it at all) -
 * there was no way to say "this tool exists and usually works, but this one
 * call fails" (a permission error on one collection, a transient RPC
 * failure on one path), which is a completely realistic real-project case.
 * Write { "__throw__": "message" } as the value anywhere a real response
 * would go to simulate it.
 */
function throwIfThrowSentinel(value: unknown, context: string): void {
  if (typeof value === "object" && value !== null && "__throw__" in value) {
    throw new Error(`[mock ${context}] ${(value as { __throw__: string }).__throw__}`);
  }
}
