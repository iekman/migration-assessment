import type { AssessmentReport, Severity } from "./types.js";

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_ICON: Record<Severity, string> = { blocker: "⛔", high: "🔴", medium: "🟠", low: "⚪️" };

const BAND_LABEL: Record<AssessmentReport["band"], string> = {
  trivial: "Trivial — mostly mechanical porting",
  moderate: "Moderate — real work, no surprises expected",
  substantial: "Substantial — plan for a dedicated migration project",
  "major-rewrite": "Major rewrite — the Firebase-specific design is load-bearing",
};

export function renderMarkdown(report: AssessmentReport): string {
  const lines: string[] = [];
  lines.push(`# Firebase → Serverpod migration complexity report`);
  lines.push("");
  lines.push(`**Project:** \`${report.projectId}\`${report.mock ? " _(mock data)_" : ""}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Overall complexity:** ${report.overallScore.toFixed(1)} / 10 — ${BAND_LABEL[report.band]}`);
  lines.push("");

  lines.push(`## Dimension scores`);
  lines.push("");
  lines.push(`| Dimension | Score /10 |`);
  lines.push(`|---|---|`);
  for (const d of [...report.dimensions].sort((a, b) => b.score - a.score)) {
    lines.push(`| ${d.dimension} | ${d.score.toFixed(1)} |`);
  }
  lines.push("");

  for (const d of [...report.dimensions].sort((a, b) => b.score - a.score)) {
    lines.push(`## ${d.dimension} (${d.score.toFixed(1)}/10)`);
    lines.push("");
    const sorted = [...d.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    for (const f of sorted) {
      lines.push(`- ${SEVERITY_ICON[f.severity]} **${f.summary}**`);
      lines.push(`  ${f.detail}`);
      if (f.serverpodNote) lines.push(`  > Serverpod: ${f.serverpodNote}`);
    }
    lines.push("");
  }

  if (report.skipped.length > 0) {
    lines.push(`## Not assessed`);
    lines.push("");
    for (const s of report.skipped) lines.push(`- ${s}`);
    lines.push("");
  }

  lines.push(`## Known blind spots in this tool`);
  lines.push("");
  lines.push(
    "- Firestore/Storage have no MCP list tool — collections/buckets must be seeded via config or " +
      "scraped from security rules; anything not named there is invisible to this report.",
  );
  lines.push(
    "- Cloud Functions source code isn't readable via MCP — trigger types are inferred from naming " +
      "conventions unless overridden by functionSideEffects in config; verify manually otherwise.",
  );
  lines.push(
    "- Sampling is capped (see --sample-size) — rare field shapes outside the sample won't be caught.",
  );
  lines.push(
    "- serverpod_mcp is a docs/Q&A server, not a target-codebase scanner — it cannot tell you " +
      "anything about an existing Serverpod project, only general Serverpod guidance.",
  );
  lines.push(
    "- Several things have no MCP signal at all and are only in this report if you put them in " +
      "config: subcollections, denormalized fields, multi-tenancy, installed Extensions, deployment " +
      "model, and per-function side effects.",
  );

  return lines.join("\n");
}

export function renderJson(report: AssessmentReport): string {
  return JSON.stringify(report, (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value), 2);
}
