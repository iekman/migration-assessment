import type { AssessmentReport } from "./types.js";

/**
 * Derives genuine, project-specific reasons a move to Serverpod pays off,
 * from signals already computed elsewhere in the report - never generic
 * marketing copy pasted in regardless of what this project actually looks
 * like. Each one is a true statement about Serverpod (grounded in its own
 * docs/source, same as the rest of this tool), surfaced only when this
 * project's own data makes it relevant or always-true structurally.
 */
export function deriveServerpodStrengths(report: AssessmentReport): string[] {
  const strengths: string[] = [];
  const allFindings = report.dimensions.flatMap((d) => d.findings);

  const platformPhrase =
    report.appPlatforms.length > 1
      ? ` across all ${report.appPlatforms.length} platforms you ship to today (${report.appPlatforms.join(", ")})`
      : report.appPlatforms.length === 1
        ? ` for the ${report.appPlatforms[0].toLowerCase()} client you ship today`
        : "";
  strengths.push(
    `A single, typed Dart codebase for your server and every client${platformPhrase} — once your ` +
      `server defines a type, every caller gets that exact shape at compile time, not a hand-matched ` +
      `REST or Firestore SDK call that can silently drift out of sync with what the server actually sends.`,
  );

  const ruleComplexitySignals = allFindings.filter(
    (f) => f.dimension === "security-rules" && /cross-document get\(\)\/exists\(\) call|custom helper function/.test(f.summary),
  );
  strengths.push(
    ruleComplexitySignals.length > 0
      ? "This project's rules already encode real authorization logic (cross-document lookups, " +
        "custom helper functions) - today, all of it only runs inside Firebase's proprietary rules " +
        "engine: not unit-testable like ordinary code, not portable if you ever want to self-host or " +
        "switch providers, and not reviewable in a normal code review. Moving it into Serverpod " +
        "endpoints turns it into application code your team owns outright - testable, versioned " +
        "alongside everything else, and yours to run anywhere, not dependent on one vendor's engine."
      : "Your authorization and business logic live in code you write, read, and test yourself - not " +
        "in a separate rules file whose execution you depend entirely on one vendor to run, and whose " +
        "logic you could never take with you to another host.",
  );

  const bgTriggerCount = allFindings
    .filter((f) => f.dimension === "functions" && /^\d+ \w+ background-trigger function\(s\)/.test(f.summary))
    .reduce((sum, f) => sum + Number(f.summary.match(/^(\d+)/)?.[1] ?? 0), 0);
  strengths.push(
    bgTriggerCount > 0
      ? `This project has ${bgTriggerCount} background-triggered function(s) today. Each one is a ` +
        "separate billed invocation stacked on top of the write that triggered it - a classic source " +
        "of Firebase's per-operation costs climbing faster than usage actually grows, since one user " +
        "action can cascade into several billed events instead of one. In Serverpod, the equivalent " +
        "logic runs inline within the request that caused it, on infrastructure you pay a flat, " +
        "predictable cost for - not per read, write, or triggered invocation."
      : "Firebase bills per read, write, and function invocation - costs that climb with usage in a " +
        "way that's hard to predict or cap in advance. Serverpod runs on infrastructure you provision " +
        "(your own servers, or Serverpod Cloud) at a predictable cost independent of call volume - " +
        "the tradeoff is taking on server operations yourself, but the billing surprises common to " +
        "pay-per-operation pricing go away.",
  );

  const dataConnectDimension = report.dimensions.find((d) => d.dimension === "Data Connect -> Already Postgres");
  if (dataConnectDimension && dataConnectDimension.score < 0) {
    strengths.push(
      "You're already running on Postgres via Data Connect - of everything in this report, this is " +
        "the strongest possible starting position: your data layer largely maps straight onto " +
        "Serverpod's native format, no document-to-relational redesign required for that part.",
    );
  }

  const hasSimpleFunctions = allFindings.some((f) => /\d+ (https|callable) function\(s\)/.test(f.summary));
  if (hasSimpleFunctions) {
    strengths.push(
      "Your request/response-style functions port close to one-to-one onto Serverpod endpoint " +
        "methods - real, demonstrable progress in the first week of work, not months out.",
    );
  }

  const authIsSimple = allFindings.some((f) => f.summary === "Email/password only, no custom claims in sample");
  if (authIsSimple) {
    strengths.push(
      "Your sign-in setup (email/password, no custom claims in the sample) is close to a drop-in " +
        "match for Serverpod's built-in auth module - one of the lowest-risk pieces of this migration.",
    );
  }

  const firestoreFindings = allFindings.filter((f) => f.dimension === "firestore-schema" && /^Collection ".*": \d+ docs sampled/.test(f.summary));
  const flatFirestoreFindings = firestoreFindings.filter((f) => f.detail.startsWith("Looks like a flat, uniform shape"));
  if (firestoreFindings.length > 0 && flatFirestoreFindings.length / firestoreFindings.length >= 0.5) {
    strengths.push(
      "Most of your sampled Firestore data is already flat and consistent - it becomes a clean " +
        "relational schema with comparatively little redesign, and you gain real SQL joins and " +
        "transactions Firestore doesn't offer natively.",
    );
  }

  strengths.push(
    "Serverpod's own tooling has matured quickly: the current release added full-stack hot reload " +
      "and a zero-setup embedded Postgres for local development, so your team spends its first days " +
      "writing code, not fighting infrastructure. (It's a young major version - expect some rough " +
      "edges as it stabilizes, same as any fast-moving framework.)",
  );

  return strengths;
}
