export type Severity = "low" | "medium" | "high" | "blocker";

export interface Finding {
  dimension: string;
  severity: Severity;
  weight: number;
  summary: string;
  detail: string;
  serverpodNote?: string;
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
  skipped: string[];
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
