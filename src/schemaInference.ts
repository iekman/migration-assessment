import type { FirestoreFieldShape, FirestoreCollectionShape } from "./types.js";

function jsType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    // Firestore MCP tools typically serialize special types with a
    // discriminator once round-tripped through JSON, e.g.
    // { "__type__": "geopoint", latitude, longitude } or a plain
    // { _latitude, _longitude } shape, and DocumentReference as a path
    // string or { "__type__": "reference", path }. Support both loosely.
    if ("_latitude" in v || "latitude" in v) return "geopoint";
    if ("__type__" in v && v.__type__ === "reference") return "reference";
    if ("__type__" in v && v.__type__ === "geopoint") return "geopoint";
    return "map";
  }
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "timestamp-like-string";
    return "string";
  }
  return typeof value; // number, boolean
}

export function inferCollectionShape(
  name: string,
  docs: Array<Record<string, unknown>>,
): FirestoreCollectionShape {
  const fields = new Map<string, FirestoreFieldShape>();
  let hasReferenceFields = false;
  let hasGeoPointFields = false;
  let hasArrayOfMapFields = false;

  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      const t = jsType(value);
      const existing = fields.get(key) ?? {
        types: new Set<string>(),
        nullable: false,
        sampleCount: 0,
      };
      existing.types.add(t);
      existing.sampleCount += 1;
      if (t === "null") existing.nullable = true;
      if (t === "map" && value && typeof value === "object") {
        existing.nestedKeys = new Set([
          ...(existing.nestedKeys ?? []),
          ...Object.keys(value as object),
        ]);
      }
      if (t === "reference") hasReferenceFields = true;
      if (t === "geopoint") hasGeoPointFields = true;
      if (t === "array" && Array.isArray(value) && value.some((v) => jsType(v) === "map")) {
        hasArrayOfMapFields = true;
      }
      fields.set(key, existing);
    }
  }

  return {
    name,
    docsSampled: docs.length,
    fields,
    hasSubcollectionsHint: false,
    hasReferenceFields,
    hasGeoPointFields,
    hasArrayOfMapFields,
  };
}

/** Fields whose observed type set has more than one non-null entry: schema drift Postgres won't tolerate for free. */
export function polymorphicFields(shape: FirestoreCollectionShape): string[] {
  const out: string[] = [];
  for (const [key, f] of shape.fields) {
    const nonNull = [...f.types].filter((t) => t !== "null");
    if (nonNull.length > 1) out.push(`${key} (${nonNull.join("/")})`);
  }
  return out;
}
