import { extractResultData, type IMcpClient } from "../firebaseMcpClient.js";
import type { DimensionResult, Finding } from "../types.js";

export async function collectDataConnect(client: IMcpClient): Promise<DimensionResult> {
  const toolName = await client.resolveToolName("dataconnect_list_services", "list_services");
  if (!toolName) {
    return {
      dimension: "Data Connect -> Already Postgres",
      score: 0,
      findings: [{ dimension: "dataconnect", severity: "low", weight: 0, summary: "list_services tool not found", detail: "Skipped." }],
    };
  }

  try {
    const result = await client.callReadOnlyTool(toolName, {});
    const data = extractResultData(result) as { services?: unknown[] } | unknown[];
    const services = Array.isArray(data) ? data : data.services ?? [];
    const findings: Finding[] = [];

    if (services.length > 0) {
      findings.push({
        dimension: "dataconnect",
        severity: "low",
        weight: -1.5, // negative: this REDUCES overall complexity, not adds to it
        summary: `${services.length} Data Connect service(s) in use`,
        detail:
          "Data Connect is already backed by Cloud SQL Postgres with a typed GraphQL schema. This is " +
          "the single best migration signal in the whole assessment: the data model is already " +
          "relational, so it largely maps straight onto Serverpod's Postgres-backed model classes. " +
          "The Firestore/RTDB findings above are the actual migration cost; this slice is comparatively cheap.",
        serverpodNote: "Port the GraphQL schema's types directly into Serverpod .spy.yaml model definitions.",
      });
      // The dimension score itself carries the discount - scoreOverall()
      // multiplies this by a fixed positive dimension weight, so a
      // negative score here is what actually pulls the overall number
      // down. A finding's own `weight` field is informational/display
      // only; nothing reads it back for scoring.
      return { dimension: "Data Connect -> Already Postgres", score: -1.5, findings };
    }
    return { dimension: "Data Connect -> Already Postgres", score: 0, findings };
  } catch {
    return {
      dimension: "Data Connect -> Already Postgres",
      score: 0,
      findings: [{ dimension: "dataconnect", severity: "low", weight: 0, summary: "No Data Connect services (or not enabled on this project)", detail: "No effect on the assessment." }],
    };
  }
}
