import type { DimensionResult, Finding } from "../types.js";
import type { AssessorConfig } from "../config.js";

/**
 * Everything here is information no MCP tool can discover: installed
 * Firebase Extensions (no listing tool exists for them at all), and the
 * target deployment model, which changes how several other findings
 * should be read (see collectFunctions). This collector just surfaces
 * what the user told us as its own findings so nothing gets lost.
 */
export function collectUserContext(config: AssessorConfig): DimensionResult {
  const findings: Finding[] = [];
  let complexityPoints = 0;

  if (config.installedExtensions.length > 0) {
    complexityPoints += config.installedExtensions.length * 1;
    findings.push({
      dimension: "operational-context",
      severity: "medium",
      weight: config.installedExtensions.length,
      summary: `${config.installedExtensions.length} Firebase Extension(s) installed (user-confirmed): ${config.installedExtensions.join(", ")}`,
      detail:
        "Extensions are entirely invisible to the MCP server — no tool lists them. Each one is its " +
        "own migration item (e.g. a Stripe billing extension becomes direct Stripe API calls from a " +
        "Serverpod endpoint; an Algolia-sync extension becomes a manual sync call on write).",
    });
  }

  if (config.deploymentModel === "undecided") {
    findings.push({
      dimension: "operational-context",
      severity: "low",
      weight: 0.5,
      summary: "Target deployment model not yet decided",
      detail:
        "Several findings (notably scheduled Cloud Functions, see the Functions dimension) read " +
        "differently depending on serverless vs. persistent-server deployment — FutureCall, " +
        "Serverpod's scheduling mechanism, is disabled entirely in serverless mode. Deciding this " +
        "early sharpens every scheduling-related finding in this report.",
    });
  } else {
    findings.push({
      dimension: "operational-context",
      severity: "low",
      weight: 0,
      summary: `Target deployment model: ${config.deploymentModel} (user-confirmed)`,
      detail: "Used to qualify the scheduled-functions finding in the Functions dimension.",
    });
  }

  return { dimension: "Operational Context", score: Math.min(10, complexityPoints), findings };
}
