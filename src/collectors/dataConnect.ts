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
    return {
      dimension: "Data Connect -> Already Postgres",
      score: 0,
      findings: [{ dimension: "dataconnect", severity: "low", weight: 0, summary: "No Data Connect services found", detail: "The tool call succeeded and returned zero services - genuinely not in use." }],
    };
  } catch (err) {
    // Deliberately distinct from the "called successfully, zero services"
    // case above: a thrown error (e.g. a permission error on this specific
    // API) means usage is actually UNKNOWN, not confirmed absent - and since
    // Data Connect is the one dimension that gives a discount when present,
    // silently treating "the call failed" the same as "confirmed not in
    // use" risks a real project losing that discount to nothing more than
    // a missing IAM role.
    return {
      dimension: "Data Connect -> Already Postgres",
      score: 0,
      findings: [{
        dimension: "dataconnect",
        severity: "medium",
        weight: 1,
        outcome: "failed",
        uncertaintyCategory: "call-failed",
        summary: "Could not determine Data Connect usage - call failed",
        detail: `${String(err instanceof Error ? err.message : err)} This is unknown, not confirmed absent - if this project does use Data Connect, this run missed the complexity discount that would otherwise apply. Check manually (firebase dataconnect:services:list) or fix the permission and re-run.`,
      }],
    };
  }
}
