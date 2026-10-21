import type { DimensionResult } from "../types.js";

/**
 * Cloud Storage exposes exactly one MCP tool: get_object_download_url, which
 * needs an already-known object path. There is no bucket/prefix listing
 * tool, so this dimension can never be assessed from data — it's a fixed
 * advisory finding rather than a scored collector.
 */
export function assessStorage(): DimensionResult {
  return {
    dimension: "Cloud Storage -> Object Storage",
    score: 3,
    findings: [
      {
        dimension: "storage",
        severity: "medium",
        weight: 1,
        summary: "Cloud Storage cannot be enumerated via MCP",
        detail:
          "The storage tool group only exposes get_object_download_url, which requires an already-" +
          "known object path — there's no list-objects or list-buckets tool. Bucket layout, object " +
          "count, and total size must be checked with `gsutil ls -r` or the console. Migrating storage " +
          "itself is usually mechanical (Serverpod's CloudStorage abstraction has official S3/GCS/R2 " +
          "modules) — the actual cost is almost always in security-rule-driven access control on " +
          "objects, which shows up in the Security Rules dimension above, not here.",
      },
    ],
  };
}
