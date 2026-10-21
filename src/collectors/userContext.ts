import type { DimensionResult, Finding } from "../types.js";
import type { AssessorConfig } from "../config.js";

/**
 * Firebase Extensions have no MCP listing tool at all, but several of the
 * common ones create recognizable default collections. A match here is a
 * pattern, not proof - surfaced as a suspicion to confirm or dismiss, same
 * as the multi-tenancy and denormalization heuristics elsewhere.
 */
const EXTENSION_SIGNATURES: Array<{ extension: string; signatureCollections: string[] }> = [
  { extension: "firestore-stripe-payments", signatureCollections: ["customers", "products", "prices", "subscriptions"] },
  { extension: "firestore-send-email", signatureCollections: ["mail"] },
  { extension: "firestore-counter", signatureCollections: ["counters", "counter_shards"] },
  { extension: "firestore-bigquery-export", signatureCollections: ["bigquery_export"] },
  { extension: "delete-user-data", signatureCollections: ["deletion_queue"] },
];

function detectSuspectedExtensions(
  seenCollections: string[],
  alreadyConfirmed: string[],
): Array<{ extension: string; matched: string[] }> {
  const seenLower = new Set(seenCollections.map((c) => c.toLowerCase()));
  const confirmed = new Set(alreadyConfirmed.map((e) => e.toLowerCase()));
  const out: Array<{ extension: string; matched: string[] }> = [];
  for (const sig of EXTENSION_SIGNATURES) {
    if (confirmed.has(sig.extension.toLowerCase())) continue; // already told us - don't ask again
    const matched = sig.signatureCollections.filter((c) => seenLower.has(c.toLowerCase()));
    if (matched.length > 0) out.push({ extension: sig.extension, matched });
  }
  return out;
}

/**
 * Everything here is information no MCP tool can discover on its own:
 * installed Firebase Extensions, and the target deployment model, which
 * changes how several other findings should be read (see collectFunctions).
 */
export function collectUserContext(config: AssessorConfig, sampledCollectionNames: string[]): DimensionResult {
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
        "Each one is its own migration item (e.g. a Stripe billing extension becomes direct Stripe " +
        "API calls from a Serverpod endpoint; an Algolia-sync extension becomes a manual sync call on write).",
    });
  }

  const suspected = detectSuspectedExtensions(sampledCollectionNames, config.installedExtensions);
  for (const s of suspected) {
    complexityPoints += 0.5;
    findings.push({
      dimension: "operational-context",
      severity: "low",
      weight: 0.5,
      summary: `Suspected Firebase Extension: ${s.extension} (collection name match, unconfirmed)`,
      detail:
        `Found ${s.matched.length === 1 ? "a collection" : "collections"} named ${s.matched.map((c) => `"${c}"`).join(", ")}, ` +
        `which ${s.extension} creates by default. Not confirmed — these names aren't unique to it. ` +
        `If correct, add "${s.extension}" to installedExtensions in config to turn this into a ` +
        "full-weight finding; if this collection is your own and unrelated, ignore it.",
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
