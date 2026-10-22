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

### Hand-built example scenarios, and what they caught

Beyond harvested real-world text, `fixtures/example-*.json` + `.config.json`
pairs are purpose-built scenarios — pick one with `--fixture-data`:

- `example-simple`: a flat one-collection app. Scores near 0 - mostly
  mechanical porting.
- `example-messy`: deliberately maximal across every dimension (schema
  drift, confirmed + suspected denormalization, multi-tenancy, six
  background-trigger functions across every trigger family, deep RTDB
  nesting, a confirmed extension alongside a suspected one, serverless
  clashing with a scheduled function). Scores "substantial."
- `example-fittrack`, `example-bloghub`: mid-complexity scenarios built to
  specifically exercise paths the two above hadn't - an empty `get_users`
  result, a shallow (not deep) RTDB path, a `functionSideEffects` override
  on a non-background-trigger function, a subcollection declared both via
  config and discoverable from rules (checks for a duplicate-sampling bug;
  there wasn't one), and a 3-level-deep rules chain in the *flat*
  multi-segment form specifically, as a second, independent check on a fix
  described below.
- `example-faultinjection`: every live-sampling call fails (simulating a
  service account missing specific IAM roles, which the setup instructions
  above can easily lead to in practice) via `mockClient.ts`'s `__throw__`
  fixture sentinel, added specifically to make this scenario possible -
  before it existed, every `catch` block in every collector was provably
  unreachable in `--mock` mode, since a tool name either had a fixture
  entry (so every call to it always succeeded) or didn't (so the collector
  never called it at all). There was no way to express "this tool exists
  and usually works, but this specific call fails."

Building these four caught real bugs, each the same shape: a value gets
computed and attached to a finding or the report, and nothing downstream
ever reads it back.

- The Data Connect "discount" described earlier in this README never
  actually did anything: `Finding.weight` is set throughout the codebase
  but read nowhere, and `collectDataConnect` hardcoded its dimension score
  to `0` regardless of whether services were present. Fixed by returning a
  genuinely negative dimension score when Data Connect is in use, which is
  what the overall weighted average actually reads.
- `wildcardDepth`'s own capturing group (`[^\{]+`) structurally excluded
  the `{` characters the very next line searched for — not "rarely
  triggers," mathematically guaranteed to always compute `0`, for any
  rules file, ever. Replaced with `maxNestingDepth`, computed from the
  already real-world-validated collection tree in `rulesParser.ts`, and
  confirmed firing via two independent cases (block-nested and flat-form).
- `FirestoreFieldShape.nullable` was set in `schemaInference.ts` and read
  nowhere - wired into a real finding (a sometimes-null field needs a
  nullable Dart type, not a `NOT NULL` column).
- `AssessmentReport.userProvidedContext` was computed correctly but never
  rendered in the markdown report (only present in the JSON output) - now
  a line near the top of every report.
- `AssessmentReport.skipped` had dedicated rendering logic in `report.ts`
  but was hardcoded to `[]` in `cli.ts` and populated by nothing - the
  "Not assessed" section could never appear under any input. Removed
  rather than wired up, since doing it properly needs each collector to
  signal "I didn't run at all" through a side channel, which is a bigger
  change than this pass called for.
- `collectAuth` produced zero findings when `get_users` returned an empty
  array despite real UIDs being requested - no way to tell "wrong/stale
  UIDs" from "genuinely no users" apart. Now says so explicitly.
- Two inconsistent-severity bugs surfaced by fault injection specifically:
  a blocked rules read and a failed Remote Config fetch were both marked
  `low` severity, while every other collector's identical "got nothing
  back" case was already `medium` - standardized.
- The sharpest one: `collectDataConnect`'s bare `catch {}` reported a
  permission error identically to "called successfully, confirmed zero
  services" - meaning a real project using Data Connect could silently
  lose its complexity discount to nothing more than a missing IAM role,
  with the report claiming "No effect on the assessment" with total
  unearned confidence. Fixed to distinguish the two explicitly.
- Fault injection also exposed a report-level gap, not a collector bug:
  when most collectors fail, the headline "X/10, trivial" number reads as
  "this project is simple" when the truth is "almost nothing could be
  read." Every catch-block finding now carries `outcome: "failed"`
  (deliberately distinct from "this MCP server doesn't support that tool,"
  a separate, already-documented structural gap), and the report leads
  with an explicit warning whenever any are present, naming which
  dimensions failed and stating plainly that the score below is a lower
  bound, not a verdict.

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

## Report structure and audience

The report isn't a single-audience technical dump. It's built in layers,
each for a different reader:

1. **Executive summary** — plain-language verdict, framed constructively
   (a `major-rewrite` band gets "this is real cost, and here's what it
   buys you" rather than only "this is bad") plus a handful of genuinely
   Serverpod-relevant wins derived from this specific project's own data
   (`src/strengths.ts`) — not generic marketing copy pasted in regardless
   of project shape. Written to be shared with a non-technical stakeholder
   for a go/no-go call.
2. **Where the effort concentrates** — the dimension score table, for
   anyone who wants the numeric breakdown.
3. **What needs confirming before this estimate is final** — replaces a
   static "known blind spots" list with this project's actual open
   questions (`src/unknowns.ts`), grouped by kind. Each group states what's
   unknown, *when* you'd likely discover the surprise if it's left
   unresolved, and the fastest way to close it, with its specific
   instances underneath as a single, continuously-numbered checklist
   (`- [ ] 1.`, `2.`, ... straight through every group, not restarting per
   group) — each item worded to stand alone, so a non-technical reader can
   copy any one line directly into a ticket without needing the
   surrounding prose. Populated only with categories that actually have
   instances this run, never the full taxonomy regardless of relevance.
   Ends with a one-line "biggest remaining uncertainty" call-out, by total
   severity-weighted instance count. Written for whoever is deciding what
   to do before kickoff, not necessarily an engineer.
4. **Detailed findings** — the full per-dimension technical record
   everything above is derived from, for whoever actually scopes or
   implements the migration.
5. **Methodology notes** — the remaining structural, always-true caveats
   (no Firestore listing tool, sampling is capped, etc.) that apply to
   every run regardless of project and aren't specific enough to belong
   in section 3.

This section of the README is the dev-facing version of the same
information — more detail, no audience-shaping:

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
  report.ts                  Markdown/JSON rendering, layered by audience (see above)
  strengths.ts                data-driven "why Serverpod fits" bullets for the executive summary -
                              keep to infrastructure/cost/ownership claims, not dev-tooling-quality
                              or marketing language (a "tooling has matured" bullet was cut for
                              exactly this). WARNING: its conditional bullets detect project signals
                              by pattern-matching other collectors' finding.summary text - this is
                              fragile by nature (confirmed: a pluralization pass once silently broke
                              two of its regexes with no type error, since both sides are just
                              strings) and scripts/test-real-world.mjs's Suite 3 exists specifically
                              to catch that class of regression by running the real pipeline, not a
                              reimplementation of it - extend that suite's expectations rather than
                              trusting a new conditional bullet by inspection alone.
  unknowns.ts                  per-project "what needs confirming" groups, replacing static
                              boilerplate - deliberately NOT string-matching (see Finding.uncertaintyCategory
                              in types.ts, set explicitly at each collector's finding-creation site);
                              prefer that pattern over strengths.ts's for any new derivation.
  serverpodOracle.ts         optional serverpod_mcp Q&A enrichment
  collectors/                one file per Firebase surface, plus userContext.ts
                              for config-only signals (extensions, multi-tenancy,
                              deployment model)
fixtures/
  mock-project.json          canned MCP responses for --mock
  mock-project.config.json   matching AssessorConfig for --mock
```
