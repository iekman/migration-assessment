import { extractResultData, type IMcpClient } from "../firebaseMcpClient.js";
import type { DimensionResult, Finding } from "../types.js";

function maxDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== "object") return depth;
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) return depth;
  return Math.max(...entries.map((v) => maxDepth(v, depth + 1)));
}

export async function collectRealtimeDatabase(client: IMcpClient, paths: string[]): Promise<DimensionResult> {
  const findings: Finding[] = [];
  let complexityPoints = 0;

  if (paths.length === 0) {
    return {
      dimension: "Realtime Database -> Relational Schema",
      score: 0,
      findings: [
        {
          dimension: "rtdb",
          severity: "low",
          weight: 0,
          summary: "No Realtime Database paths configured",
          detail: "Either unused, or supply realtimeDatabasePaths to assess it.",
        },
      ],
    };
  }

  const toolName = await client.resolveToolName("database_get_data", "get_data");
  if (!toolName) {
    findings.push({
      dimension: "rtdb",
      severity: "medium",
      weight: 1,
      summary: "get_data tool not found on MCP server",
      detail: "Realtime Database surface could not be assessed.",
    });
    return { dimension: "Realtime Database -> Relational Schema", score: 5, findings };
  }

  complexityPoints += 1;
  findings.push({
    dimension: "rtdb",
    severity: "medium",
    weight: 1,
    summary: "Realtime Database is in use",
    detail:
      "A second, differently-shaped data store than Firestore (if both are used) roughly doubles " +
      "the schema-design work, since RTDB's tree structure and Firestore's document/collection " +
      "structure both need their own relational mapping.",
  });

  for (const path of paths) {
    try {
      const result = await client.callReadOnlyTool(toolName, { path });
      const data = extractResultData(result);
      const depth = maxDepth(data);
      if (depth >= 4) {
        complexityPoints += 2;
        findings.push({
          dimension: "rtdb",
          severity: "high",
          weight: 2,
          summary: `Path "${path}" is deeply nested (depth ${depth})`,
          detail:
            "Deep JSON trees in RTDB are usually denormalized for fan-out reads. A relational schema " +
            "needs this flattened into proper tables with foreign keys, which is a design task, not a " +
            "mechanical conversion.",
        });
      } else {
        findings.push({
          dimension: "rtdb",
          severity: "low",
          weight: 0.5,
          summary: `Path "${path}" is shallow (depth ${depth})`,
          detail: "Likely maps to one or two tables without much redesign.",
        });
      }
    } catch (err) {
      findings.push({
        dimension: "rtdb",
        severity: "medium",
        weight: 1,
        outcome: "failed",
        uncertaintyCategory: "call-failed",
        summary: `Failed to read path "${path}"`,
        detail: String(err instanceof Error ? err.message : err),
      });
    }
  }

  return { dimension: "Realtime Database -> Relational Schema", score: Math.min(10, complexityPoints), findings };
}
