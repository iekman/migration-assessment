import { extractResultData, type IMcpClient } from "../firebaseMcpClient.js";
import type { DimensionResult, Finding } from "../types.js";
import { pluralize } from "../text.js";

export async function collectRemoteConfig(client: IMcpClient): Promise<DimensionResult> {
  const findings: Finding[] = [];
  const toolName = await client.resolveToolName("remoteconfig_get_template", "get_template");
  if (!toolName) {
    return {
      dimension: "Remote Config -> Feature Flags",
      score: 0,
      findings: [
        { dimension: "remote-config", severity: "low", weight: 0, summary: "get_template tool not found", detail: "Skipped." },
      ],
    };
  }

  try {
    const result = await client.callReadOnlyTool(toolName, {});
    const data = extractResultData(result) as { parameters?: Record<string, unknown>; conditions?: unknown[] };
    const paramCount = Object.keys(data.parameters ?? {}).length;
    const conditionCount = (data.conditions ?? []).length;

    if (paramCount === 0) {
      return {
        dimension: "Remote Config -> Feature Flags",
        score: 0,
        findings: [
          { dimension: "remote-config", severity: "low", weight: 0, summary: "No Remote Config parameters defined", detail: "Nothing to migrate on this axis." },
        ],
      };
    }

    const score = Math.min(10, paramCount * 0.3 + conditionCount * 0.8);
    findings.push({
      dimension: "remote-config",
      severity: conditionCount > 0 ? "medium" : "low",
      weight: 1,
      summary: `${pluralize(paramCount, "parameter")}, ${pluralize(conditionCount, "targeting condition")}`,
      detail:
        conditionCount > 0
          ? "Conditional/targeted rollout logic (percentage rollouts, audience conditions) has no " +
            "Serverpod equivalent — needs a bespoke flag service or a third-party feature-flag package."
          : "Simple key/value config; can become a settings table or config file with modest effort.",
    });
    return { dimension: "Remote Config -> Feature Flags", score, findings };
  } catch (err) {
    return {
      dimension: "Remote Config -> Feature Flags",
      score: 3,
      findings: [
        {
          dimension: "remote-config",
          severity: "medium",
          weight: 1,
          outcome: "failed",
          uncertaintyCategory: "call-failed",
          summary: "Failed to fetch Remote Config template",
          detail: `${String(err instanceof Error ? err.message : err)} Unknown, not confirmed simple - this dimension's score is a placeholder, not a real read.`,
        },
      ],
    };
  }
}
