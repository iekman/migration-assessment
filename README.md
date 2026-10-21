# fb-to-serverpod-assessor

A standalone CLI that connects to a Firebase project's [MCP server](https://firebase.google.com/docs/ai-assistance/mcp-server)
with read-only access and produces a **migration-complexity report** for
moving the backend to [Serverpod](https://serverpod.dev). It also tries
[`serverpod_mcp`](https://github.com/serverpod/serverpod_mcp) for
Serverpod-side narrative context on the highest-severity findings.

## Why this exists / what it actually does

Firebase's MCP server is not a full admin-SDK export tool. Its real,
per-service surface is narrow:

| Area | Tools | What that means here |
|---|---|---|
| firestore | `query_collection` only | no collection listing — you must supply seed names |
| realtime database | `get_data`, `set_data` | no schema/listing tool |
| auth | `get_users`, `update_user`, `set_sms_region_policy` | no bulk export — sample by uid |
| storage | `get_object_download_url` only | no bucket/object listing at all |
| functions | `list_functions`, `get_logs` | no source code read |
| remote config | `get_template`, `update_template` | fine |
| dataconnect | `list_services`, `compile`, `execute` | fine (and a *good* migration signal, see below) |
| core | `get_project`, `list_apps`, `get_security_rules`, `validate_security_rules`, ... | fine |

`serverpod_mcp`, in turn, is **not** a codebase-introspection server — it
only exposes Serverpod's own docs as MCP resources plus a Gemini-backed
Q&A tool. It cannot tell you anything about a specific Firebase or
Serverpod project. This tool uses it only as an optional, best-effort
oracle for "how is X idiomatically done in Serverpod" narrative snippets.

Given those constraints, this tool:

1. Connects to `firebase mcp` over stdio as an MCP **client**, enforcing
   a hard read-only allowlist in code (`src/firebaseMcpClient.ts`) —
   refuses any tool name matching a mutating verb (`set_`, `update_`,
   `create_`, `delete_`, `deploy`, `send_`, `login`, `init`, ...) or an
   explicit denylist entry (`dataconnect_execute`). Defense in depth,
   not a substitute for real IAM scoping — see "Real usage" below.
2. Reads `firestore.rules` / `storage.rules` / `database.rules`, scrapes
   `match /name/{id}` paths out of the Firestore rules text to
   auto-discover likely top-level collections, and flags cross-document
   `get()`/`exists()` calls (relational authorization logic baked into
   rules — no Serverpod equivalent).
3. Samples each Firestore collection (config-seeded ∪ rules-discovered),
   plus any subcollections you name in `knownSubcollections` (nothing
   discovers these on its own), and infers a field-shape summary:
   reference fields, GeoPoints, array-of-map fields, and cross-document
   schema drift.
4. Lists Cloud Functions and classifies each by trigger type — from
   structured metadata when available, otherwise a naming-convention
   guess — unless you've described its real side effects in
   `functionSideEffects`, which always wins over the guess.
5. Samples Auth users by uid for provider mix and custom-claims usage.
6. Samples Realtime Database paths for nesting depth, if configured.
7. Reads the Remote Config template for feature-flag/targeting complexity.
8. Checks for Data Connect services — a positive signal (already
   Postgres + GraphQL) rather than a cost.
9. Folds in everything no MCP tool can ever see: denormalized fields,
   multi-tenancy, installed Firebase Extensions, and target deployment
   model (serverless vs. persistent — this changes whether Serverpod's
   `FutureCall` scheduling is even available).
10. Weights everything into an overall 0–10 score and writes a Markdown
    and/or JSON report.

## Try it without any credentials

```bash
npm install
npm run mock
# writes ./report.md and ./report.json from fixtures/mock-project.json
```

## Real usage

1. Get **read-only** access to the target project — prefer a service
   account bound to viewer-only roles over your own user login:

   ```bash
   gcloud iam service-accounts create fb-migration-audit
   gcloud projects add-iam-policy-binding <PROJECT_ID> \
     --member="serviceAccount:fb-migration-audit@<PROJECT_ID>.iam.gserviceaccount.com" \
     --role="roles/viewer"
   gcloud projects add-iam-policy-binding <PROJECT_ID> \
     --member="serviceAccount:fb-migration-audit@<PROJECT_ID>.iam.gserviceaccount.com" \
     --role="roles/datastore.viewer"
   gcloud projects add-iam-policy-binding <PROJECT_ID> \
     --member="serviceAccount:fb-migration-audit@<PROJECT_ID>.iam.gserviceaccount.com" \
     --role="roles/firebaseauth.viewer"
   gcloud iam service-accounts keys create key.json \
     --iam-account=fb-migration-audit@<PROJECT_ID>.iam.gserviceaccount.com
   export GOOGLE_APPLICATION_CREDENTIALS="$PWD/key.json"
   ```

2. Install the Firebase CLI (`npm i -g firebase-tools`) so `firebase mcp`
   is on your `PATH`.

3. Write a config file (see `fixtures/mock-project.config.json` for the
   full shape). Beyond `projectId` and `firestoreCollections`, fill in
   whatever you know that no scan can discover:

   ```jsonc
   {
     "projectId": "my-project",
     "firestoreCollections": ["users", "notes"],
     "knownSubcollections": { "notes": ["comments"] },
     "denormalizedFields": [
       { "collection": "notes", "field": "ownerDisplayName", "sourceOfTruth": "users.displayName" }
     ],
     "multiTenant": false,
     "installedExtensions": ["firestore-stripe-payments"],
     "deploymentModel": "persistent",
     "functionSideEffects": {
       "onUserDelete": "cascades: deletes the user's notes and removes them from shared notes"
     }
   }
   ```

   The more of this you fill in, the less the report is "here's what I
   could see" and the more it's "here's what I could see, corrected
   against what you told me" — a materially more trustworthy result,
   especially for Cloud Functions, where source code literally cannot be
   read via MCP at all.

4. Run it:

   ```bash
   npm run build
   node dist/cli.js --config my-project.config.json --format both
   ```

## Known blind spots (also printed at the end of every report)

- No Firestore/Storage listing tool — anything not named in your config
  or discoverable in the rules text is invisible to this report.
- No Cloud Functions source-read tool — trigger classification is a
  best-effort guess from naming unless overridden by `functionSideEffects`.
- The rules-text collection scraper is naive regex matching, not a real
  parser — it doesn't track nesting depth, so a collection name nested
  under another collection (e.g. `notes/{id}/comments/{id}`) also gets
  scraped as if it were top-level, and gets sampled (harmlessly, as an
  empty result) at the wrong path. Known cosmetic noise, not a
  correctness issue — cross-check anything scraped against your own
  knowledge of the schema.
- Sampling is capped (`sampleSize` in the config) — rare field shapes
  outside the sample won't be caught.
- The overall score and dimension weights (`src/scoring.ts`) are
  judgment calls, not a validated formula — treat the report as a
  starting point for a real migration estimate, not a verdict.

## Layout

```
src/
  cli.ts                 entry point / arg parsing / orchestration
  firebaseMcpClient.ts    stdio MCP client + read-only allowlist enforcement
  mockClient.ts           fixture-backed stand-in used by --mock
  config.ts                AssessorConfig loading
  schemaInference.ts       Firestore document shape inference
  scoring.ts                dimension weighting -> overall score/band
  report.ts                  Markdown/JSON rendering
  serverpodOracle.ts         optional serverpod_mcp Q&A enrichment
  collectors/                one file per Firebase surface, plus userContext.ts
                              for config-only signals (extensions, multi-tenancy,
                              deployment model)
fixtures/
  mock-project.json          canned MCP responses for --mock
  mock-project.config.json   matching AssessorConfig for --mock
```
