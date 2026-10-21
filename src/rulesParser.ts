/**
 * A real brace-depth-aware scan of Firestore rules text, replacing the old
 * flat "find /name/{ anywhere" regex. Firestore rules nest collections two
 * ways, and both need to produce the same tree:
 *
 *   block form:  match /notes/{id} { match /comments/{id2} { ... } }
 *   flat form:   match /notes/{id}/comments/{id2} { ... }
 *
 * This only needs to understand `match <path> { ... }` nesting — not the
 * rules expression language — so everything else that opens a brace
 * (a `function foo() { ... }` body, the outer `service` block) is tracked
 * only enough to keep brace-depth counting correct; its contents are
 * never inspected.
 */

export interface CollectionNode {
  name: string;
  children: Map<string, CollectionNode>;
}

export interface ParsedRules {
  /** Top-level collection names - the root's direct children. */
  topLevelCollections: string[];
  /** parent collection name -> immediate subcollection names, one level deep (matches AssessorConfig.knownSubcollections' shape). */
  subcollections: Record<string, string[]>;
  /** Tenant/org-like identifiers referenced anywhere in the text (e.g. "orgId"), a multi-tenancy hint. */
  tenantHints: string[];
  /** Deepest collection/subcollection chain found (1 = only top-level collections, no nesting). */
  maxNestingDepth: number;
}

const TENANT_TOKEN_RE =
  /\b(tenantId|tenant_id|orgId|org_id|organizationId|organization_id|workspaceId|workspace_id|accountId|account_id|companyId|company_id)\b/g;

// Requires one or more complete (literalSegment, {wildcard}) pairs immediately
// before the opening brace. A bare literal with no following wildcard (as in
// the rules-root wrapper `/databases/{db}/documents {`, where "documents" has
// no wildcard after it) will not satisfy this and is deliberately left to
// fall through as a plain, uninteresting brace - no special-casing needed to
// keep "databases"/"documents" out of the collection tree.
const MATCH_HEADER_PAIR_RE = /\/([A-Za-z0-9_-]+)\/\{[^}]+\}/g;

function stripComments(text: string): string {
  // CEL (which the Firestore/Storage rules language is built on) supports
  // both comment forms; strip block comments first so a "//" inside one
  // doesn't swallow the rest of the block.
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

export function parseCollectionTree(rawText: string): ParsedRules {
  const text = stripComments(rawText);

  const tenantHints = new Set<string>();
  for (const m of text.matchAll(TENANT_TOKEN_RE)) tenantHints.add(m[0]);

  const root: CollectionNode = { name: "__root__", children: new Map() };
  const matchStack: CollectionNode[] = [root];
  const braceOpensMatch: boolean[] = [];

  const EVENT_RE = /match\s+((?:\/[A-Za-z0-9_-]+\/\{[^}]+\})+)\s*\{|\{|\}/g;
  let m: RegExpExecArray | null;
  while ((m = EVENT_RE.exec(text))) {
    if (m[1] !== undefined) {
      const segments = [...m[1].matchAll(MATCH_HEADER_PAIR_RE)].map((seg) => seg[1]);
      let current = matchStack[matchStack.length - 1];
      for (const seg of segments) {
        if (!current.children.has(seg)) current.children.set(seg, { name: seg, children: new Map() });
        current = current.children.get(seg)!;
      }
      // One stack entry regardless of how many segments this header chained
      // through - they all share the single brace this header opens, and
      // close together on its matching "}".
      matchStack.push(current);
      braceOpensMatch.push(true);
    } else if (m[0] === "{") {
      braceOpensMatch.push(false);
    } else {
      const openedMatch = braceOpensMatch.pop();
      if (openedMatch) matchStack.pop();
    }
  }

  const subcollections: Record<string, string[]> = {};
  const collectSubcollections = (node: CollectionNode) => {
    if (node.children.size > 0) {
      subcollections[node.name] = [...node.children.keys()];
    }
    for (const child of node.children.values()) collectSubcollections(child);
  };
  for (const child of root.children.values()) collectSubcollections(child);

  const depthOf = (node: CollectionNode): number =>
    node.children.size === 0 ? 1 : 1 + Math.max(...[...node.children.values()].map(depthOf));
  const maxNestingDepth = root.children.size === 0 ? 0 : Math.max(...[...root.children.values()].map(depthOf));

  return {
    topLevelCollections: [...root.children.keys()],
    subcollections,
    tenantHints: [...tenantHints],
    maxNestingDepth,
  };
}
