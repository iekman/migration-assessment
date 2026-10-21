import { extractResultData, type IMcpClient } from "../firebaseMcpClient.js";
import type { DimensionResult, Finding } from "../types.js";

export interface RulesCollectorResult {
  dimension: DimensionResult;
  discoveredFirestoreCollections: string[];
}

function extractRuleText(data: unknown): string {
  if (typeof data === "string") return data;
  const d = data as { source?: string; rules?: string; content?: string };
  return d.source ?? d.rules ?? d.content ?? JSON.stringify(data);
}

/** Pulls top-level collection names out of `match /name/{id} { ... }` style paths. */
function scrapeCollectionNames(rulesText: string): string[] {
  const names = new Set<string>();
  const re = /match\s+\/(?:databases\/[^/]+\/documents\/)?([a-zA-Z0-9_-]+)\/\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rulesText))) {
    names.add(m[1]);
  }
  // The Firestore rules root is always `match /databases/{db}/documents { ... }`
  // (note: no trailing slash before the opening brace of the wrapper itself,
  // unlike nested `match /name/{id} {` rules) — the regex above can still
  // pick up "databases" as a false-positive top-level "collection" from that
  // wrapper line, so drop it explicitly.
  names.delete("databases");
  return [...names];
}

function countOccurrences(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

export async function collectRules(
  client: IMcpClient,
  multiTenant: boolean,
  tenantIsolationNote?: string,
): Promise<RulesCollectorResult> {
  const findings: Finding[] = [];
  let discoveredFirestoreCollections: string[] = [];
  let complexityPoints = 0;

  const toolName = await client.resolveToolName("get_security_rules", "core_get_security_rules");
  if (!toolName) {
    findings.push({
      dimension: "security-rules",
      severity: "medium",
      weight: 1,
      summary: "Could not locate get_security_rules tool on the MCP server",
      detail:
        "Security rules complexity could not be assessed automatically. Review firestore.rules, " +
        "storage.rules, and database.rules by hand.",
    });
    return {
      dimension: { dimension: "Security Rules -> Authorization Logic", score: 5, findings },
      discoveredFirestoreCollections,
    };
  }

  for (const type of ["firestore", "storage", "database"] as const) {
    try {
      const result = await client.callReadOnlyTool(toolName, { type });
      const text = extractRuleText(extractResultData(result));

      if (type === "firestore") {
        discoveredFirestoreCollections = scrapeCollectionNames(text);
      }

      const getExistsCalls = countOccurrences(text, /\b(get|exists|getAfter)\s*\(/g);
      const customFunctions = countOccurrences(text, /function\s+\w+\s*\(/g);
      const allowStatements = countOccurrences(text, /allow\s+\w/g);
      const wildcardDepth = Math.max(
        0,
        ...([...text.matchAll(/match\s+([^\{]+)\{/g)] as RegExpMatchArray[]).map(
          (m) => (m[1].match(/\{[^}]+\}/g) ?? []).length,
        ),
      );

      if (getExistsCalls > 0) {
        complexityPoints += 2;
        findings.push({
          dimension: "security-rules",
          severity: "high",
          weight: 2,
          summary: `${type}.rules makes ${getExistsCalls} cross-document get()/exists() call(s)`,
          detail:
            "Rules that read other documents to authorize a request encode relational business " +
            "logic in the rules layer. Serverpod has no declarative rules engine — this becomes " +
            "hand-written authorization code inside each endpoint method, including re-implementing " +
            "whatever the get()/exists() lookups were checking.",
          serverpodNote:
            "Port this as an auth-guard helper called at the top of each affected endpoint method.",
        });
      }
      if (customFunctions > 0) {
        complexityPoints += 1;
        findings.push({
          dimension: "security-rules",
          severity: "medium",
          weight: 1,
          summary: `${type}.rules defines ${customFunctions} custom helper function(s)`,
          detail: "Each helper encodes a reusable authorization predicate to reimplement in Dart.",
        });
      }
      if (wildcardDepth >= 3) {
        complexityPoints += 1;
        findings.push({
          dimension: "security-rules",
          severity: "medium",
          weight: 1,
          summary: `${type}.rules has deeply nested path matches (depth ${wildcardDepth})`,
          detail:
            "Deep nesting usually mirrors a deep subcollection hierarchy, which doesn't map to a " +
            "flat relational schema without denormalization or join tables.",
        });
      }
      if (allowStatements === 0) {
        findings.push({
          dimension: "security-rules",
          severity: "low",
          weight: 0.5,
          summary: `${type}.rules has no allow statements (locked down / unused)`,
          detail: "Likely unused or fully locked-down; low migration cost for this surface.",
        });
      }
    } catch (err) {
      findings.push({
        dimension: "security-rules",
        severity: "low",
        weight: 0.5,
        summary: `Could not read ${type} rules`,
        detail: String(err instanceof Error ? err.message : err),
      });
    }
  }

  if (multiTenant) {
    complexityPoints += 2.5;
    findings.push({
      dimension: "security-rules",
      severity: "high",
      weight: 2.5,
      summary: "Project is multi-tenant (user-confirmed)",
      detail:
        (tenantIsolationNote
          ? `Tenant isolation today: ${tenantIsolationNote}. `
          : "") +
        "Every future query and endpoint needs tenant scoping rebuilt explicitly — there's no " +
        "equivalent to rules-enforced tenant isolation, so a missed check is a cross-tenant data " +
        "leak rather than a cosmetic bug. Budget real review time here, not just porting time.",
    });
  }

  const score = Math.min(10, complexityPoints);
  return {
    dimension: { dimension: "Security Rules -> Authorization Logic", score, findings },
    discoveredFirestoreCollections,
  };
}
