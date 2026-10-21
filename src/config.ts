import { readFileSync } from "node:fs";

export interface DenormalizedField {
  collection: string;
  field: string;
  sourceOfTruth: string;
  note?: string;
}

export interface AssessorConfig {
  /** Firebase project id to assess. Required in real mode. */
  projectId: string;
  /**
   * Firestore has no "list collections" MCP tool, so top-level collections
   * to sample must be supplied. Seed this from your own knowledge of the
   * app, or from names discovered in firestore.rules (the tool also tries
   * to scrape `match /x/{id}` paths out of the rules text automatically).
   */
  firestoreCollections: string[];
  /**
   * No MCP tool lists subcollections either, ever. If you know a top-level
   * collection has subcollections, name them here (parent -> list of
   * subcollection names) so they get sampled instead of silently missed.
   */
  knownSubcollections: Record<string, string[]>;
  /**
   * Fields you know are denormalized copies of data owned elsewhere (a
   * common Firestore pattern to avoid joins). Each one is almost always
   * backed by sync logic in a Cloud Function that has to be found and
   * removed once the data lives in one relational place.
   */
  denormalizedFields: DenormalizedField[];
  /** How many documents to sample per collection for schema inference. */
  sampleSize: number;
  /** Realtime Database top-level paths to sample, if the project uses RTDB. */
  realtimeDatabasePaths: string[];
  /** How many auth users to sample (via get_users) for provider/claims mix. */
  authSampleUids: string[];
  /**
   * One Firebase project serving multiple customer orgs, isolated only by
   * a tenantId field and rules, is real extra rewrite work: every future
   * query and endpoint needs that scoping rebuilt explicitly.
   */
  multiTenant: boolean;
  tenantIsolationNote?: string;
  /**
   * Installed Firebase Extensions (Stripe billing, image resizing, Algolia
   * sync, etc.) are completely invisible to the MCP server - no tool lists
   * them. Name them here or they won't appear in the report at all.
   */
  installedExtensions: string[];
  /**
   * Whether the target deployment is serverless (pay-per-use) or a
   * persistent server. FutureCall - the scheduled-function replacement -
   * is disabled entirely in Serverpod's serverless mode, which changes
   * how the "scheduled functions" finding should be read.
   */
  deploymentModel: "serverless" | "persistent" | "undecided";
  /**
   * The functions tool group has no source-read tool, so trigger
   * classification is a naming-convention guess. Fill in what a function
   * actually does (side effects: emails, other writes, cascading
   * deletes, third-party API calls) to replace the guess with ground
   * truth and get an honest complexity read instead of a shrug.
   */
  functionSideEffects: Record<string, string>;
  /** Command used to spawn the Firebase MCP server. */
  mcpCommand: string;
  mcpArgs: string[];
  /** Optional: enable the best-effort serverpod_mcp narrative lookups. */
  useServerpodOracle: boolean;
  serverpodMcpCommand: string;
  serverpodMcpArgs: string[];
}

export const DEFAULT_CONFIG: Omit<AssessorConfig, "projectId"> = {
  firestoreCollections: [],
  knownSubcollections: {},
  denormalizedFields: [],
  sampleSize: 25,
  realtimeDatabasePaths: [],
  authSampleUids: [],
  multiTenant: false,
  installedExtensions: [],
  deploymentModel: "undecided",
  functionSideEffects: {},
  mcpCommand: "firebase",
  mcpArgs: ["mcp"],
  useServerpodOracle: false,
  serverpodMcpCommand: "dart",
  serverpodMcpArgs: ["pub", "global", "run", "serverpod_mcp"],
};

export function loadConfig(path: string): AssessorConfig {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (!raw.projectId) {
    throw new Error(`Config at ${path} is missing required "projectId"`);
  }
  return { ...DEFAULT_CONFIG, ...raw };
}
