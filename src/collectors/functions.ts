import { extractResultData, type IMcpClient } from "../firebaseMcpClient.js";
import type { DimensionResult, Finding } from "../types.js";
import type { AssessorConfig } from "../config.js";

export interface FunctionInfo {
  name: string;
  triggerType?: string;
  raw: Record<string, unknown>;
}

// Real GCP/Firebase event-type strings (what list_functions' structured
// metadata actually looks like for a 2nd-gen function, confirmed against
// real examples from firebase/functions-samples) aren't yet in our
// internal "-trigger" vocabulary on their own — map them in, rather than
// passing them through raw and having them silently miss every switch
// case downstream in collectFunctions (which is what happened before this
// was caught by testing against real-world function metadata).
const EVENT_TYPE_PATTERNS: Array<[RegExp, string]> = [
  [/firestore\.document/i, "firestore-trigger"],
  [/firebase\.database\.ref/i, "rtdb-trigger"],
  [/cloud\.storage\.object/i, "storage-trigger"],
  [/cloud\.auth|firebase\.auth/i, "auth-trigger"],
  [/cloud\.pubsub\.topic/i, "pubsub-trigger"],
];

function normalizeExplicitTrigger(raw: string): string {
  for (const [pattern, bucket] of EVENT_TYPE_PATTERNS) {
    if (pattern.test(raw)) return bucket;
  }
  return raw; // genuinely unrecognized - falls through to the "undetermined" bucket downstream, which is honest
}

export function classify(raw: Record<string, unknown>): FunctionInfo {
  const name = String(raw.name ?? raw.id ?? raw.functionName ?? "unknown");
  const explicitTrigger =
    (raw.triggerType as string) ??
    (raw.trigger as string) ??
    ((raw.httpsTrigger ? "https" : undefined) as string | undefined) ??
    ((raw.eventTrigger as Record<string, unknown> | undefined)?.eventType as string | undefined);

  if (explicitTrigger) return { name, triggerType: normalizeExplicitTrigger(explicitTrigger), raw };

  // No structured trigger metadata surfaced by list_functions in this
  // server version — fall back to Firebase's own naming conventions.
  // Real-world testing against firebase/functions-samples' 2nd-gen
  // function names found this catches a small minority of cases (2/9 in
  // that sample) - most real names (makeuppercase, addmessage,
  // generateThumbnail, validateNewUser) carry no trigger-indicating
  // substring at all. This is a known, measured weakness, not treated as
  // reliable - see fixtures/real-world-functions.json.
  const lower = name.toLowerCase();
  let guessed: string | undefined;
  if (/oncall|callable/.test(lower)) guessed = "callable";
  else if (/onrequest|https?/.test(lower)) guessed = "https";
  else if (/onschedule|scheduled|cron/.test(lower)) guessed = "scheduled";
  else if (/pubsub/.test(lower)) guessed = "pubsub-trigger";
  else if (/oncreate|onupdate|ondelete|onwrite|firestore/.test(lower)) guessed = "firestore-trigger";
  else if (/rtdb|database/.test(lower)) guessed = "rtdb-trigger";
  else if (/onauth|beforecreate|beforesignin|auth/.test(lower)) guessed = "auth-trigger";
  else if (/storage|onfinalize|onarchive/.test(lower)) guessed = "storage-trigger";

  return { name, triggerType: guessed ?? "unknown", raw };
}

export async function collectFunctions(
  client: IMcpClient,
  deploymentModel: AssessorConfig["deploymentModel"],
  functionSideEffects: Record<string, string>,
): Promise<DimensionResult> {
  const findings: Finding[] = [];
  let complexityPoints = 0;

  const toolName = await client.resolveToolName("functions_list_functions", "list_functions");
  if (!toolName) {
    findings.push({
      dimension: "functions",
      severity: "medium",
      weight: 1,
      summary: "list_functions tool not found on MCP server",
      detail: "Cloud Functions surface could not be assessed.",
    });
    return { dimension: "Cloud Functions -> Endpoints & Hooks", score: 5, findings };
  }

  try {
    const result = await client.callReadOnlyTool(toolName, {});
    const data = extractResultData(result) as { functions?: unknown[] } | unknown[];
    const list = (Array.isArray(data) ? data : data.functions ?? []) as Record<string, unknown>[];

    if (list.length === 0) {
      findings.push({
        dimension: "functions",
        severity: "low",
        weight: 0,
        summary: "No Cloud Functions deployed",
        detail: "Nothing to migrate on this axis.",
      });
      return { dimension: "Cloud Functions -> Endpoints & Hooks", score: 0, findings };
    }

    const classified = list.map(classify);

    // Human-confirmed side effects take priority over the naming-convention
    // guess entirely — ground truth beats a heuristic every time.
    for (const f of classified) {
      const sideEffect = functionSideEffects[f.name];
      if (!sideEffect) continue;
      complexityPoints += 2;
      findings.push({
        dimension: "functions",
        severity: "high",
        weight: 2,
        summary: `"${f.name}": ${sideEffect}`,
        detail:
          "User-confirmed side effect, not a naming-convention guess. Audit every write path that " +
          "would have fired this trigger and hand-place the equivalent logic there.",
        serverpodNote: "Treat as ground truth over the trigger-type guess below for this function.",
      });
    }

    const byTrigger = new Map<string, number>();
    for (const f of classified) {
      if (functionSideEffects[f.name]) continue; // already covered above with better info
      byTrigger.set(f.triggerType ?? "unknown", (byTrigger.get(f.triggerType ?? "unknown") ?? 0) + 1);
    }

    for (const [trigger, count] of byTrigger) {
      if (trigger === "https" || trigger === "callable") {
        complexityPoints += count * 0.5;
        findings.push({
          dimension: "functions",
          severity: "low",
          weight: count * 0.5,
          summary: `${count} ${trigger} function(s)`,
          detail: "These map fairly directly onto Serverpod endpoint methods (request/response shape changes, logic mostly ports as-is).",
          serverpodNote: "One Serverpod endpoint method per function; move the handler body largely unchanged.",
        });
      } else if (trigger === "scheduled") {
        complexityPoints += count * 1.5;
        const serverlessWarning =
          deploymentModel === "serverless"
            ? " Target deployment is serverless (per config) — FutureCall, Serverpod's scheduling " +
              "mechanism, is disabled entirely in serverless mode, so these need a different answer " +
              "(an external scheduler hitting an HTTPS endpoint) rather than a direct port."
            : "";
        findings.push({
          dimension: "functions",
          severity: deploymentModel === "serverless" ? "high" : "medium",
          weight: count * 1.5,
          summary: `${count} scheduled (cron) function(s)`,
          detail:
            "Serverpod has a future-call/cron-style scheduling mechanism, but the schedule + retry " +
            "semantics need re-declaring, not just moving code." +
            serverlessWarning,
        });
      } else if (trigger.endsWith("-trigger")) {
        complexityPoints += count * 3;
        // Same filter as the byTrigger tally above - a function already
        // covered by a functionSideEffects override is reported there with
        // better information and shouldn't also show up here, or the name
        // list and the count it's attached to disagree (found by testing
        // this against mock data where onUserDelete has such an override
        // and shares a trigger type with another function that doesn't).
        const names = classified
          .filter((f) => f.triggerType === trigger && !functionSideEffects[f.name])
          .map((f) => f.name);
        findings.push({
          dimension: "functions",
          severity: "high",
          weight: count * 3,
          uncertaintyCategory: "function-behavior-unknown",
          summary: `${count} ${trigger.replace("-trigger", "")} background-trigger function(s): ${names.join(", ")}`,
          detail:
            "Firestore/RTDB/Auth/Storage triggers auto-fire on writes, and Pub/Sub triggers auto-fire " +
            "on a published message - none have a direct Serverpod equivalent. Each one has to become " +
            "explicit application code: called from the write path (the Serverpod endpoint or " +
            "repository method that performs the equivalent write), or, for Pub/Sub, from wherever " +
            "the message would have been published, since there's no database- or queue-level " +
            "change-trigger to hook into out of the box.",
          serverpodNote:
            `Highest-risk category: audit each of ${names.join(", ")} for side effects (emails, ` +
            "other writes, cascading deletes) and hand-place the equivalent calls in the " +
            `corresponding endpoint(s). Add functionSideEffects entries for ${names.join(", ")} to ` +
            "turn this guess into a ground-truth finding above, one function at a time.",
        });
      } else {
        complexityPoints += count * 1;
        findings.push({
          dimension: "functions",
          severity: "medium",
          weight: count * 1,
          uncertaintyCategory: "function-behavior-unknown",
          summary: `${count} function(s) with undetermined trigger type`,
          detail: `Names: ${classified.filter((f) => f.triggerType === trigger && !functionSideEffects[f.name]).map((f) => f.name).join(", ")}. list_functions didn't expose structured trigger metadata in this server version — verify manually, or fill in functionSideEffects in config.`,
        });
      }
    }

    findings.push({
      dimension: "functions",
      severity: "low",
      weight: 0.5,
      summary: "Function source code is not readable via MCP",
      detail:
        "The functions tool group only exposes list_functions and get_logs — no source read tool. " +
        "Trigger classification above is a best-effort guess from naming/metadata unless overridden " +
        "by functionSideEffects in config; each function's actual body still needs manual review " +
        "to port unless it has such an override.",
    });
  } catch (err) {
    findings.push({
      dimension: "functions",
      severity: "medium",
      weight: 1,
      outcome: "failed",
      uncertaintyCategory: "call-failed",
      summary: "Failed to list functions",
      detail: String(err instanceof Error ? err.message : err),
    });
  }

  return {
    dimension: "Cloud Functions -> Endpoints & Hooks",
    score: Math.min(10, complexityPoints),
    findings,
  };
}
