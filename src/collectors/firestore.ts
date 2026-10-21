import { extractResultData, type IMcpClient } from "../firebaseMcpClient.js";
import { inferCollectionShape, polymorphicFields } from "../schemaInference.js";
import type { DimensionResult, Finding } from "../types.js";
import type { DenormalizedField } from "../config.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractDocs(data: unknown): Array<Record<string, unknown>> {
  const arr = Array.isArray(data)
    ? data
    : isPlainObject(data)
      ? (data.documents ?? data.results ?? [])
      : [];
  if (!Array.isArray(arr)) return [];
  return (arr as unknown[]).filter(isPlainObject).map((doc) => {
    const anyDoc = doc as { data?: unknown; fields?: unknown };
    const inner = isPlainObject(anyDoc.data) ? anyDoc.data : isPlainObject(anyDoc.fields) ? anyDoc.fields : doc;
    return inner;
  });
}

export async function collectFirestore(
  client: IMcpClient,
  collections: string[],
  knownSubcollections: Record<string, string[]>,
  denormalizedFields: DenormalizedField[],
  sampleSize: number,
): Promise<DimensionResult> {
  const findings: Finding[] = [];
  let complexityPoints = 0;

  if (collections.length === 0) {
    findings.push({
      dimension: "firestore-schema",
      severity: "medium",
      weight: 1,
      summary: "No Firestore collections were seeded or discovered",
      detail:
        "The Firestore MCP tool set has no list_collections tool, so this assessor cannot discover " +
        "collections on its own. Pass --collections or let the security-rules scrape find them; " +
        "otherwise this dimension is not assessed.",
    });
    return { dimension: "Firestore Schema -> Relational Schema", score: 5, findings };
  }

  const toolName = await client.resolveToolName("firestore_query_collection", "query_collection");
  if (!toolName) {
    findings.push({
      dimension: "firestore-schema",
      severity: "medium",
      weight: 1,
      summary: "query_collection tool not found on MCP server",
      detail: "Could not sample any collection.",
    });
    return { dimension: "Firestore Schema -> Relational Schema", score: 5, findings };
  }

  // Build the full sampling plan: top-level collections, plus any
  // subcollections the user told us about (never discoverable via MCP).
  const plan: Array<{ path: string; label: string; parent?: string }> = [];
  for (const name of collections) {
    plan.push({ path: name, label: name });
    for (const sub of knownSubcollections[name] ?? []) {
      plan.push({ path: `${name}/*/${sub}`, label: `${name}/{id}/${sub}`, parent: name });
    }
  }

  for (const item of plan) {
    try {
      const result = await client.callReadOnlyTool(toolName, {
        collection_path: item.path,
        limit: sampleSize,
      });
      const docs = extractDocs(extractResultData(result));
      if (docs.length === 0) {
        findings.push({
          dimension: "firestore-schema",
          severity: "low",
          weight: 0.5,
          summary: `Collection "${item.label}" sampled 0 documents`,
          detail: "Either empty, or the query returned no results — verify the collection path.",
        });
        continue;
      }

      const shape = inferCollectionShape(item.label, docs);
      const drift = polymorphicFields(shape);
      const notes: string[] = [];

      if (shape.hasReferenceFields) {
        complexityPoints += 1.5;
        notes.push("has DocumentReference fields (map to foreign keys, but IDs must be normalized)");
      }
      if (shape.hasGeoPointFields) {
        complexityPoints += 1;
        notes.push("has GeoPoint fields (no native Serverpod/Postgres type — use PostGIS point or lat/lng columns)");
      }
      if (shape.hasArrayOfMapFields) {
        complexityPoints += 1.5;
        notes.push("has array-of-map fields (needs a typed Dart class + json/serialized column, or a join table)");
      }
      if (drift.length > 0) {
        complexityPoints += Math.min(3, drift.length);
        notes.push(`schema drift across sampled docs on: ${drift.join(", ")}`);
      }
      if (shape.fields.size > 20) {
        complexityPoints += 1;
        notes.push(`wide document shape (${shape.fields.size} distinct fields observed)`);
      }

      findings.push({
        dimension: "firestore-schema",
        severity: notes.length >= 2 ? "high" : notes.length === 1 ? "medium" : "low",
        weight: 1,
        summary: `Collection "${item.label}": ${shape.docsSampled} docs sampled, ${shape.fields.size} fields`,
        detail: notes.length > 0 ? notes.join("; ") : "Looks like a flat, uniform shape — low-cost table mapping.",
        serverpodNote:
          notes.length > 0
            ? `Model "${item.label}" as a Serverpod class in a .spy.yaml; expect hand-authored conversion logic for the flagged fields.`
            : `Model "${item.label}" as a straightforward Serverpod class — generated table should be close to 1:1.`,
      });

      if (!item.parent && !knownSubcollections[item.label]) {
        findings.push({
          dimension: "firestore-schema",
          severity: "low",
          weight: 0.5,
          summary: `Collection "${item.label}": subcollections cannot be detected via MCP`,
          detail:
            "No Firestore MCP tool lists subcollections, and none were named in config for this " +
            "collection. If it has subcollections in the console, they are invisible to this " +
            "assessor and must be enumerated manually — or added to knownSubcollections in config.",
        });
      }
    } catch (err) {
      findings.push({
        dimension: "firestore-schema",
        severity: "medium",
        weight: 1,
        summary: `Failed to sample collection "${item.label}"`,
        detail: String(err instanceof Error ? err.message : err),
      });
    }
  }

  for (const d of denormalizedFields) {
    complexityPoints += 1;
    findings.push({
      dimension: "firestore-schema",
      severity: "medium",
      weight: 1,
      summary: `"${d.collection}.${d.field}" is a denormalized copy (user-confirmed)`,
      detail:
        `Source of truth: "${d.sourceOfTruth}". ${d.note ?? ""} ` +
        "In Firestore this is almost always kept in sync by a Cloud Function on writes to the " +
        "source — find and remove that sync logic once the data lives in one relational place; " +
        "the field itself becomes a join or a computed column instead of a stored copy.",
      serverpodNote: `Drop the stored copy; read "${d.field}" via a join to "${d.sourceOfTruth}" instead.`,
    });
  }

  return {
    dimension: "Firestore Schema -> Relational Schema",
    score: Math.min(10, complexityPoints),
    findings,
  };
}
