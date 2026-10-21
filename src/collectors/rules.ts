import { extractResultData, type IMcpClient } from "../firebaseMcpClient.js";
import { parseCollectionTree } from "../rulesParser.js";
import type { DimensionResult, Finding } from "../types.js";

export interface RulesCollectorResult {
  dimension: DimensionResult;
  discoveredFirestoreCollections: string[];
  /** parent -> subcollection names, parsed straight out of the rules text - ground truth, not a guess. */
  discoveredSubcollections: Record<string, string[]>;
}

function extractRuleText(data: unknown): string {
  if (typeof data === "string") return data;
  const d = data as { source?: string; rules?: string; content?: string };
  return d.source ?? d.rules ?? d.content ?? JSON.stringify(data);
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
  let discoveredSubcollections: Record<string, string[]> = {};
  const allTenantHints = new Set<string>();
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
      discoveredSubcollections,
    };
  }

  for (const type of ["firestore", "storage", "database"] as const) {
    try {
      const result = await client.callReadOnlyTool(toolName, { type });
      const text = extractRuleText(extractResultData(result));

      let firestoreNestingDepth = 0;
      if (type === "firestore") {
        const parsed = parseCollectionTree(text);
        discoveredFirestoreCollections = parsed.topLevelCollections;
        discoveredSubcollections = parsed.subcollections;
        firestoreNestingDepth = parsed.maxNestingDepth;
        for (const hint of parsed.tenantHints) allTenantHints.add(hint);
      } else {
        // storage/database rules don't have Firestore-style collection
        // nesting, but can still reference tenant-like fields in conditions.
        for (const m of text.matchAll(
          /\b(tenantId|tenant_id|orgId|org_id|organizationId|organization_id|workspaceId|workspace_id|accountId|account_id|companyId|company_id)\b/g,
        )) {
          allTenantHints.add(m[0]);
        }
      }

      const getExistsCalls = countOccurrences(text, /\b(get|exists|getAfter)\s*\(/g);
      const customFunctions = countOccurrences(text, /function\s+\w+\s*\(/g);
      const allowStatements = countOccurrences(text, /allow\s+\w/g);

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
      if (firestoreNestingDepth >= 3) {
        complexityPoints += 1;
        findings.push({
          dimension: "security-rules",
          severity: "medium",
          weight: 1,
          summary: `${type}.rules has deeply nested collections (${firestoreNestingDepth} levels)`,
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
        (tenantIsolationNote ? `Tenant isolation today: ${tenantIsolationNote}. ` : "") +
        "Every future query and endpoint needs tenant scoping rebuilt explicitly — there's no " +
        "equivalent to rules-enforced tenant isolation, so a missed check is a cross-tenant data " +
        "leak rather than a cosmetic bug. Budget real review time here, not just porting time.",
    });
  } else if (allTenantHints.size > 0) {
    // We didn't ask and get told "yes" — we noticed something and should
    // say so before asking, rather than posing multiTenant as a blind
    // yes/no question the user has to research from scratch.
    complexityPoints += 1; // small, unconfirmed bump - full weight only applies once confirmed above
    findings.push({
      dimension: "security-rules",
      severity: "medium",
      weight: 1,
      summary: `Suspected multi-tenancy: rules reference ${[...allTenantHints].join(", ")}`,
      detail:
        "Not confirmed — this is a pattern match on field/claim names in the rules text, not a " +
        "declaration of intent. If this project does serve multiple customer orgs from one " +
        'project, set "multiTenant": true (and ideally "tenantIsolationNote") in config to turn ' +
        "this into a fully-weighted finding; if these fields mean something else here, ignore it.",
    });
  }

  const score = Math.min(10, complexityPoints);
  return {
    dimension: { dimension: "Security Rules -> Authorization Logic", score, findings },
    discoveredFirestoreCollections,
    discoveredSubcollections,
  };
}
