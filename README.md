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
2. Reads `firestore.rules` / `storage.rules` / `database.rules` and parses
   the Firestore rules text with a real brace-depth-aware scanner
   (`src/rulesParser.ts`) — not a flat regex sweep — to build an actual
   collection/subcollection tree. It understands both ways Firestore rules
   nest a subcollection (a `match` block physically nested inside another,
   and the flat `match /parent/{id}/child/{id2}` single-header form), and
   flags cross-document `get()`/`exists()` calls (relational authorization
   logic baked into rules — no Serverpod equivalent) along the way.
3. Samples each Firestore collection (config-seeded ∪ rules-discovered),
   plus every subcollection the parser found nested under it — merged
   with anything you additionally name in `knownSubcollections`, which is
   now only needed for a subcollection that carries no explicit rule of
   its own (nothing can discover those) — and infers a field-shape
   summary: reference fields, GeoPoints, array-of-map fields, and
   cross-document schema drift. It also flags *suspected* denormalized
   fields on its own (an `xId` field alongside an `xDisplayName`/`xName`/
   etc. sibling), at low confidence, distinct from a `denormalizedFields`
   entry you've confirmed in config — confirming or dismissing a
   suspicion never produces a duplicate finding.
4. Lists Cloud Functions and classifies each by trigger type — from
   structured metadata when available, otherwise a naming-convention
   guess — unless you've described its real side effects in
   `functionSideEffects`, which always wins over the guess, and names
   the specific functions still worth filling in.
5. Samples Auth users by uid for provider mix and custom-claims usage.
6. Samples Realtime Database paths for nesting depth, if configured.
7. Reads the Remote Config template for feature-flag/targeting complexity.
8. Checks for Data Connect services — a positive signal (already
   Postgres + GraphQL) rather than a cost.
9. Folds in everything no MCP tool can ever see, surfacing a suspicion
   wherever there's a pattern to go on instead of asking blind: scans
   rules text and sampled fields for tenant/org-like identifiers (a
   multi-tenancy hint), matches sampled collection names against a small
   curated list of default collections several common Firebase
   Extensions create, and reads `deploymentModel` (serverless vs.
   persistent — this changes whether Serverpod's `FutureCall` scheduling
   is even available) and `multiTenant`/`installedExtensions` once
   you've confirmed them.
10. Weights everything into an overall 0–10 score and writes a Markdown
    and/or JSON report.

## Testing against real-world material

Neither Firebase's MCP server nor serverpod_mcp lets you point this tool at
a public GitHub repo directly — the MCP server calls live Google APIs for a
specific project, not a checked-out codebase. What *is* testable without any
live project or credentials: the parsing/heuristic logic, against real text
pulled from public repos.

- `fixtures/real-world-rules/` holds real `firestore.rules` files harvested
  from [29ki/29k](https://github.com/29ki/29k) (production app, flat
  multi-segment subcollection form), [firebase/quickstart-js](https://github.com/firebase/quickstart-js)
  (official sample, block-nested subcollection form), and
  [satansdeer/firebase-albums](https://github.com/satansdeer/firebase-albums)
  (the default wide-open template with no named collection at all — a good
  check that the parser doesn't hallucinate a name from a bare wildcard),
  plus one hand-authored file covering block comments and three-level
  nesting that the harvested set didn't happen to exercise.
- `fixtures/real-world-functions.json` holds real function names and
  trigger types pulled from [firebase/functions-samples](https://github.com/firebase/functions-samples)
  (2nd-gen Node quickstarts).
- `npm run test` runs both against the actual parser/classifier (not
  separate reimplementations) and reports results.

This caught two real bugs no amount of staring at the code (or testing only
against our own hand-written mock fixtures) turned up:

1. `classify()` in `src/collectors/functions.ts` passed real GCP event-type
   strings (`google.cloud.firestore.document.v1.created`) straight through
   as the trigger type, instead of normalizing them into this tool's
   internal `*-trigger` buckets — so the *structured-metadata* path, meant
   to be the ground-truth case, silently fell into the weakest
   "undetermined" bucket for exactly the input shape a real project would
   send. Fixed in `normalizeExplicitTrigger`.
2. Pub/Sub-triggered functions (`onMessagePublished`) were bucketed with
   true cron scheduling (`onSchedule`) just because both names can contain
   "pubsub"/"scheduled"-ish substrings. They're a different migration
   pattern — Pub/Sub triggers need call-site injection like the other
   background triggers, not FutureCall rescheduling — so they now get their
   own `pubsub-trigger` bucket in the same high-severity family as
   Firestore/RTDB/Storage/Auth triggers.

It also produced an honest, measured (not guessed) number worth knowing:
on 9 real 2nd-gen function names, the naming-convention fallback (used only
when `list_functions` doesn't return structured trigger metadata) guessed
correctly **2 times out of 9**. Most modern function names
(`makeuppercase`, `addmessage`, `generateThumbnail`, `validateNewUser`)
carry no trigger-indicating substring at all. That's not a defect to fix —
there's no naming convention to lean on harder — it's a quantified reason
to treat the naming fallback as a last resort, and to lean on
`functionSideEffects` in config whenever `list_functions` doesn't return
rich metadata for a project.

**What testing couldn't reach, and why:** the live-sampling collectors
(`query_collection`, `get_users`, `list_functions`, `get_data`,
`get_security_rules`) need either a real deployed project or the Firebase
Local Emulator Suite. Checking the firebase-tools source directly (not
guessing) found emulator support is narrow: only `firestore.query_collection`,
`storage.get_object_download_url`, and Data Connect's tools can target an
emulator (via a `use_emulator` flag resolved through the Emulator Hub,
confirmed from `src/mcp/index.ts`'s `getEmulatorUrl`) — `auth.get_users`,
`realtime_database.get_data`/`set_data`, `functions.list_functions`, and
`core.get_security_rules` have no emulator path at all and always hit the
live project. Since rules-reading and function-listing are central to this
tool and neither supports the emulator, a local emulator buys relatively
little beyond what the harvested-text approach above already covers for
rules, and nothing for functions or auth — a disposable real Firebase
project remains the only way to exercise those end to end, which is real
setup cost, not something to take on without deciding it's worth it first.

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
- The rules parser (`src/rulesParser.ts`) is brace-depth-aware and handles
  both subcollection nesting forms, but it still only understands `match`
  path nesting — not the rules expression language. A subcollection with
  no explicit rule of its own (inheriting access, or unprotected) leaves
  nothing in the text to find; that's inherent, not a parser limitation,
  and is why `knownSubcollections` in config still exists as a fallback.
- The rules parser's tree can represent arbitrarily deep nesting
  (`orgs/{id}/teams/{id}/members`), but the sampling plan in
  `collectFirestore` only walks one level down from each top-level seed
  collection — a subcollection nested two or more levels deep gets
  correctly discovered but not sampled. Found by testing the parser
  against a deliberately 3-level-deep case; not yet fixed.
- Denormalized-field, multi-tenancy, and installed-Extension detection
  are pattern matches on naming conventions, not certainty — each one is
  surfaced as a low-confidence "suspected" finding that invites
  confirmation (or dismissal) in config, never silently assumed true.
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
