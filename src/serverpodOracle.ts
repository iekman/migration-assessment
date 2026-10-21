import { extractResultData, ReadOnlyMcpClient } from "./firebaseMcpClient.js";
import type { AssessorConfig } from "./config.js";
import type { AssessmentReport } from "./types.js";

/**
 * serverpod_mcp is NOT a codebase-introspection server — it only exposes
 * Serverpod's docs as MCP resources plus a Gemini-backed natural-language
 * Q&A tool (see https://github.com/serverpod/serverpod_mcp). It cannot
 * tell us anything about a specific project. Its only useful role here is
 * as a best-effort, optional oracle: ask it "how is X typically handled in
 * Serverpod" for the highest-severity findings, to enrich the report with
 * grounded doc context instead of this tool's own guesses.
 */
export async function enrichWithServerpodOracle(report: AssessmentReport, config: AssessorConfig): Promise<void> {
  if (!config.useServerpodOracle) return;

  let client: ReadOnlyMcpClient | null = null;
  try {
    client = new ReadOnlyMcpClient("serverpod_mcp", config.serverpodMcpCommand, config.serverpodMcpArgs);
    await client.connect();
    const tools = await client.listTools();
    const askTool = tools.find((t) => /ask|question|search/i.test(t.name));
    if (!askTool) return;

    const highSeverity = report.dimensions
      .flatMap((d) => d.findings)
      .filter((f) => f.severity === "high" || f.severity === "blocker")
      .slice(0, 5);

    for (const finding of highSeverity) {
      if (finding.serverpodNote) continue;
      try {
        const result = await client.callReadOnlyTool(askTool.name, {
          question: `In Serverpod, what's the idiomatic way to handle: ${finding.summary}?`,
        });
        const data = extractResultData(result);
        finding.serverpodNote =
          typeof data === "string" ? data : ((data as { answer?: string })?.answer ?? undefined);
      } catch {
        // best-effort: one failed question shouldn't sink the report
      }
    }
  } catch (err) {
    console.error(`[serverpod_mcp] oracle unavailable, skipping (${err instanceof Error ? err.message : err})`);
  } finally {
    await client?.close();
  }
}
