export type Severity = "low" | "medium" | "high" | "blocker";

export interface Finding {
  dimension: string;
  severity: Severity;
  weight: number;
  summary: string;
  detail: string;
  serverpodNote?: string;
  /**
   * Set only on findings created inside a catch block for a genuine
   * call-time failure (a thrown error - permission denied, timeout, a
   * malformed response), never for "this MCP server doesn't support that
   * tool" (a structural, well-documented gap, not a live failure this run).
   * A dimension that failed outright contributes a low/zero score the
   * same as a dimension that was genuinely simple - this flag is what
   * lets the report tell the two apart in its headline instead of only
   * in prose a reader might skim past.
   */
  outcome?: "failed";
}

export interface DimensionResult {
  dimension: string;
  score: number; // 0-10, 10 = hardest to migrate
  findings: Finding[];
}

export interface AssessmentReport {
  projectId: string;
  generatedAt: string;
  mock: boolean;
  overallScore: number; // 0-10
  band: "trivial" | "moderate" | "substantial" | "major-rewrite";
  dimensions: DimensionResult[];
  userProvidedContext: string[]; // human-supplied notes folded into the report, see config.ts
}

export interface FirestoreFieldShape {
  types: Set<string>;
  nullable: boolean;
  sampleCount: number;
  nestedKeys?: Set<string>;
}

export interface FirestoreCollectionShape {
  name: string;
  docsSampled: number;
  fields: Map<string, FirestoreFieldShape>;
  hasSubcollectionsHint: boolean;
  hasReferenceFields: boolean;
  hasGeoPointFields: boolean;
  hasArrayOfMapFields: boolean;
}
