export type Severity = "low" | "medium" | "high" | "blocker";

/**
 * Names a specific, recurring *kind* of open question this tool can leave
 * behind - tagged explicitly at the point each finding is created, not
 * inferred later from its text. Each category has a fixed, general
 * "when would this surprise you, and how do you resolve it" description
 * (see unknowns.ts) that applies regardless of which project triggered it;
 * the per-run instances (which function, which collection, which path)
 * are what make the report's "what needs confirming" section specific to
 * this project instead of generic boilerplate.
 */
export type UncertaintyCategory =
  | "function-behavior-unknown"
  | "denormalization-suspected"
  | "multitenancy-suspected"
  | "extension-suspected"
  | "subcollection-unconfirmed"
  | "deep-sampling-limit"
  | "empty-sample"
  | "call-failed";

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
  /** See UncertaintyCategory. Only set on findings that represent a real open question, not on routine results. */
  uncertaintyCategory?: UncertaintyCategory;
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
  appPlatforms: string[]; // client platforms this project ships to, for the executive summary
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
