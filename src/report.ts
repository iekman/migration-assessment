import type { AssessmentReport, Severity } from "./types.js";
import { deriveServerpodStrengths } from "./strengths.js";
import { deriveOpenQuestions } from "./unknowns.js";

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_ICON: Record<Severity, string> = { blocker: "⛔", high: "🔴", medium: "🟠", low: "⚪️" };
const SEVERITY_WEIGHT: Record<Severity, number> = { blocker: 4, high: 3, medium: 2, low: 1 };

const BAND_LABEL: Record<AssessmentReport["band"], string> = {
  trivial: "Trivial — mostly mechanical porting",
  moderate: "Moderate — real work, no surprises expected",
  substantial: "Substantial — plan for a dedicated migration project",
  "major-rewrite": "Major rewrite — the Firebase-specific design is load-bearing",
};

const STAKEHOLDER_VERDICT: Record<AssessmentReport["band"], string> = {
  trivial:
    "This looks like a clean, low-risk move. Most of what you have today ports over with minimal " +
    "rework, and you gain real relational guarantees — transactions, joins, an enforced schema — " +
    "that Firestore doesn't give you.",
  moderate:
    "This is a solid, well-bounded project. The core of your app moves over cleanly; a handful of " +
    "specific areas, named below, need deliberate design work rather than a straight port.",
  substantial:
    "This is real engineering work, not a weekend port — but it's concentrated in a few identifiable " +
    "subsystems, not spread evenly across everything. Scope it as its own project, with the specific " +
    "items below as the agenda.",
  "major-rewrite":
    "The parts of your app that lean hardest on Firebase-specific automation — background triggers, " +
    "declarative security rules — will need to be redesigned, not ported. That's real cost, and it " +
    "should be budgeted as such. It's also where moving to a codebase your team fully owns pays off " +
    "most: those same subsystems become code you can read, test, and change yourselves, instead of " +
    "behavior you only partially control today.",
};

export function renderMarkdown(report: AssessmentReport): string {
  const lines: string[] = [];
  const allFindings = report.dimensions.flatMap((d) => d.findings);
  const failedFindings = allFindings.filter((f) => f.outcome === "failed");

  lines.push(`# Firebase → Serverpod Migration Assessment`);
  lines.push("");
  lines.push(`**Project:** \`${report.projectId}\`${report.mock ? " _(mock data)_" : ""}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push("");

  // --- Executive summary: for whoever needs to approve this, not just engineers ---
  lines.push(`## Executive summary`);
  lines.push("");
  lines.push(STAKEHOLDER_VERDICT[report.band]);
  lines.push("");
  lines.push(
    `_For reference, this run's internal complexity score is ${report.overallScore.toFixed(1)}/10 ` +
      `(${BAND_LABEL[report.band]}) — see "Where the effort concentrates" below for the breakdown._`,
  );
  lines.push("");

  if (failedFindings.length > 0) {
    const failedDimensions = [...new Set(failedFindings.map((f) => f.dimension))];
    lines.push(
      `**⛔ Before anything else: ${failedFindings.length} check(s) could not be completed this run ` +
        `(${failedDimensions.join(", ")}).** The score above reflects only what this run could actually ` +
        `read — it's a lower bound, not a verdict. Fix the access issue named in each "Failed to..." ` +
        `item further down and re-run before sharing this number any further.`,
    );
    lines.push("");
  }

  lines.push(`### Why this is a good fit for Serverpod`);
  lines.push("");
  for (const s of deriveServerpodStrengths(report)) lines.push(`- ${s}`);
  lines.push("");

  lines.push(`### What this means for planning`);
  lines.push("");
  lines.push(
    report.userProvidedContext.length > 0
      ? `This assessment incorporates input your team already confirmed (${report.userProvidedContext.join(", ")}), ` +
        `in addition to what could be read directly from the project. The "What needs confirming" ` +
        `section below is what's left.`
      : `This run relied entirely on what could be read directly from the project, plus pattern-based ` +
        `guesses clearly marked as such — no manual input was supplied yet. The "What needs confirming" ` +
        `section below will shrink as your team fills that in.`,
  );
  lines.push("");

  // --- Dimension scores: technical breakdown, still useful context for a reader who wants it ---
  lines.push(`## Where the effort concentrates`);
  lines.push("");
  lines.push(`| Area | Score /10 |`);
  lines.push(`|---|---|`);
  for (const d of [...report.dimensions].sort((a, b) => b.score - a.score)) {
    const note = d.score < 0 ? " (reduces the overall score — see below)" : "";
    lines.push(`| ${d.dimension} | ${d.score.toFixed(1)}${note} |`);
  }
  lines.push("");

  // --- What needs confirming: replaces a static "known blind spots" list with
  // this project's actual open questions, grouped by kind, each with a
  // general "when would this surprise you, how do you close it" plus the
  // specific instances this run found. ---
  lines.push(`## What needs confirming before this estimate is final`);
  lines.push("");
  const openQuestions = deriveOpenQuestions(report);
  if (openQuestions.length === 0) {
    lines.push(
      "Nothing. Every check this run attempted completed, and no pattern-based suspicion was left " +
        "unconfirmed. Treat this estimate as final, pending the same caveats any software estimate carries.",
    );
    lines.push("");
  } else {
    lines.push(
      `${openQuestions.length} distinct kind(s) of open question remain, detailed below. Each names ` +
        `what's actually unknown, when you'd likely discover the surprise if it's left unresolved, and ` +
        `the quickest way to close it — most take minutes, not days.`,
    );
    lines.push("");
    for (const group of [...openQuestions].sort(
      (a, b) =>
        b.instances.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0) -
        a.instances.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0),
    )) {
      lines.push(`### ${group.title}`);
      lines.push("");
      lines.push(`**When you'd likely hit this:** ${group.whenYoudHitIt}`);
      lines.push("");
      lines.push(`**How to resolve it:** ${group.howToResolve}`);
      lines.push("");
      lines.push(`**Specific to this project:**`);
      for (const f of group.instances) lines.push(`- ${f.summary}`);
      lines.push("");
    }

    const biggest = [...openQuestions].sort(
      (a, b) =>
        b.instances.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0) -
        a.instances.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0),
    )[0];
    lines.push(
      `**Bottom line:** the single biggest source of remaining uncertainty is "${biggest.title.toLowerCase()}" ` +
        `(${biggest.instances.length} instance(s) this run). Everything else above is smaller or ` +
        `faster to close. Resolving all of it before kicking off implementation is cheap insurance — ` +
        `most items take minutes — against discovering it mid-project instead.`,
    );
    lines.push("");
  }

  // --- Detailed findings: the technical appendix for whoever actually does the work ---
  lines.push(`## Detailed findings (for your engineering team)`);
  lines.push("");
  lines.push(
    "Everything above is derived from what follows — this is the full technical record, organized " +
      "by area, for whoever scopes or implements the migration.",
  );
  lines.push("");
  for (const d of [...report.dimensions].sort((a, b) => b.score - a.score)) {
    lines.push(`### ${d.dimension} (${d.score.toFixed(1)}/10)`);
    lines.push("");
    const sorted = [...d.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    for (const f of sorted) {
      lines.push(`- ${SEVERITY_ICON[f.severity]} **${f.summary}**`);
      lines.push(`  ${f.detail}`);
      if (f.serverpodNote) lines.push(`  > Serverpod: ${f.serverpodNote}`);
    }
    lines.push("");
  }

  lines.push(`## Methodology notes`);
  lines.push("");
  lines.push(
    "- Firestore/Storage have no MCP list tool — collections/buckets must be named in config or " +
      "discoverable from security rules text; anything not named either way is invisible to this report.",
  );
  lines.push(
    "- Cloud Functions source code isn't readable via MCP — trigger classification is a best-effort " +
      "read of structured metadata when available, naming conventions otherwise.",
  );
  lines.push("- Sampling is capped per collection — a rare field shape outside the sample won't be caught.");
  lines.push(
    "- serverpod_mcp is a documentation/Q&A server, not a target-codebase scanner — it was used (if " +
      "enabled) only to add Serverpod-side context to specific findings, never to inspect any project.",
  );

  return lines.join("\n");
}

export function renderJson(report: AssessmentReport): string {
  return JSON.stringify(report, (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value), 2);
}
