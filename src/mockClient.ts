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
    if (typeof entry === "object" && entry !== null && "__byArg__" in (entry as object)) {
      const spec = entry as { __byArg__: string; values: Record<string, unknown> };
      const key = String(args[spec.__byArg__]);
      const value = spec.values[key] ?? spec.values.default ?? {};
      return { content: [{ type: "text", text: JSON.stringify(value) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(entry) }] };
  }
}
