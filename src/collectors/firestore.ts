import { extractResultData, type IMcpClient } from "../firebaseMcpClient.js";
import { inferCollectionShape, polymorphicFields } from "../schemaInference.js";
import type { DimensionResult, Finding, FirestoreCollectionShape } from "../types.js";
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

const COPY_SUFFIXES = ["DisplayName", "Name", "Title", "Email", "Avatar", "Photo", "Username"];

/**
 * Heuristic, not a fact: a field named "<x>Id" alongside a sibling field
 * named "<x>DisplayName"/"<x>Name"/etc in the SAME document commonly means
 * the sibling is a denormalized copy kept in sync by a Cloud Function,
 * rather than something owned by this collection. We can't know the real
 * source of truth from one collection's shape alone, so this is surfaced
 * as a candidate to confirm (and given a fraction of the weight a
 * user-confirmed denormalizedFields entry gets), not asserted as fact.
 */
function suspectDenormalizedFields(
  shape: FirestoreCollectionShape,
  alreadyConfirmed: Set<string>,
): Array<{ field: string; likelyIdField: string }> {
  const fieldNames = [...shape.fields.keys()];
  const out: Array<{ field: string; likelyIdField: string }> = [];
  for (const idField of fieldNames) {
    const m = /^(.+)Id$/.exec(idField);
    if (!m) continue;
    const prefix = m[1];
    for (const suffix of COPY_SUFFIXES) {
      const candidate = `${prefix}${suffix}`;
      const hit = fieldNames.find((f) => f.toLowerCase() === candidate.toLowerCase());
      if (hit && !alreadyConfirmed.has(`${shape.name}.${hit}`)) {
        out.push({ field: hit, likelyIdField: idField });
      }
    }
  }
  return out;
}

export async function collectFirestore(
  client: IMcpClient,
  collections: string[],
  knownSubcollections: Record<string, string[]>,
  denormalizedFields: DenormalizedField[],
  sampleSize: number,
): Promise<{ dimension: DimensionResult; shapes: Map<string, FirestoreCollectionShape> }> {
  const findings: Finding[] = [];
  const shapes = new Map<string, FirestoreCollectionShape>();
  let complexityPoints = 0;
  const confirmed = new Set(denormalizedFields.map((d) => `${d.collection}.${d.field}`));

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
    return { dimension: { dimension: "Firestore Schema -> Relational Schema", score: 5, findings }, shapes };
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
    return { dimension: { dimension: "Firestore Schema -> Relational Schema", score: 5, findings }, shapes };
  }

  // Full sampling plan: top-level collections, plus subcollections -
  // whether discovered straight out of the rules text (ground truth,
  // already merged into knownSubcollections by the caller) or hand-supplied
  // in config for ones with no explicit rule to parse.
  const plan: Array<{ path: string; label: string; parent?: string }> = [];
  for (const name of collections) {
    plan.push({ path: name, label: name });
    for (const sub of knownSubcollections[name] ?? []) {
      plan.push({ path: `${name}/*/${sub}`, label: `${name}/{id}/${sub}`, parent: name });
    }
  }

  for (const item of plan) {
    try {
      const result = await client.callReadOnlyTool(toolName, { collection_path: item.path, limit: sampleSize });
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
      shapes.set(item.label, shape);
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
      const nullableFields = [...shape.fields.entries()].filter(([, f]) => f.nullable).map(([name]) => name);
      if (nullableFields.length > 0) {
        complexityPoints += 0.5;
        notes.push(`has nullable field(s) (${nullableFields.join(", ")}) - these need a nullable Dart type and no NOT NULL constraint, rather than assuming every field is always present`);
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

      const suspects = suspectDenormalizedFields(shape, confirmed);
      for (const s of suspects) {
        complexityPoints += 0.5; // smaller than a confirmed entry (+1) - this is a guess, not ground truth
        findings.push({
          dimension: "firestore-schema",
          severity: "low",
          weight: 0.5,
          summary: `Suspected denormalized field: "${item.label}.${s.field}" (user-confirmed subcollections and denormalizedFields entries always suppress this)`,
          detail:
            `Sits alongside "${s.likelyIdField}" in the same document — a common Firestore pattern ` +
            `for avoiding a join by copying the referenced entity's name/title/email at write time. ` +
            `Not confirmed: if this is right, add an entry to denormalizedFields in config — ` +
            `{ collection: "${item.label}", field: "${s.field}", sourceOfTruth: "<collection ${s.likelyIdField} points at>.<field>" } ` +
            `— to turn this into a full-weight finding with the real sync-logic warning attached; ` +
            `if it's not a copy, ignore it.`,
        });
      }

      if (!item.parent && !knownSubcollections[item.label]) {
        findings.push({
          dimension: "firestore-schema",
          severity: "low",
          weight: 0.5,
          summary: `Collection "${item.label}": no subcollections found in rules text`,
          detail:
            "The rules-text parser found none nested under this collection, and none were named in " +
            "knownSubcollections either. If it has subcollections that carry no explicit rule of " +
            "their own (inheriting access from elsewhere, or unprotected), nothing can detect them — " +
            "add them to knownSubcollections in config if you know of any.",
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

  return { dimension: { dimension: "Firestore Schema -> Relational Schema", score: Math.min(10, complexityPoints), findings }, shapes };
}
