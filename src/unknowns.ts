import type { AssessmentReport, Finding, UncertaintyCategory } from "./types.js";

interface CategoryMeta {
  title: string;
  whenYoudHitIt: string;
  howToResolve: string;
}

/**
 * One fixed entry per UncertaintyCategory - the "when would this surprise
 * you, and how do you close it" text is a property of the *kind* of
 * unknown, written once, well. What makes the report specific to a given
 * project is which categories actually have instances this run (see
 * deriveOpenQuestions) and what those instances name - this file supplies
 * the general framing, not the specifics.
 */
const UNCERTAINTY_CATEGORY_META: Record<UncertaintyCategory, CategoryMeta> = {
  "function-behavior-unknown": {
    title: "What a background function actually does",
    whenYoudHitIt:
      "During the first pass of porting each one - when you open its source and discover it touches " +
      "more than its own document (another write, an email, a third-party call).",
    howToResolve:
      "Read the function's source now - it's already in your repo - and describe what it does in " +
      "functionSideEffects. This is the cheapest point in the whole project to close this gap: the " +
      "information already exists and costs a few minutes of reading, not a design decision.",
  },
  "denormalization-suspected": {
    title: "Whether a field is really a stored copy of data owned elsewhere",
    whenYoudHitIt:
      "When deciding whether to drop a column or wire a join in its place - get it wrong and you " +
      "either lose a field silently or carry dead sync logic forward into the new system.",
    howToResolve:
      "Confirm or dismiss it in denormalizedFields in config, or check your Cloud Functions source " +
      "for writes to that field.",
  },
  "multitenancy-suspected": {
    title: "Whether this project serves multiple customer organizations from one database",
    whenYoudHitIt:
      "Immediately, ideally - before any schema design starts. If true, it changes the shape of " +
      "nearly every table, and finding out partway through means redoing work, not adding to it.",
    howToResolve:
      "One conversation with whoever owns the product. Set multiTenant in config either way, so " +
      "this is settled before the project starts rather than discovered during it.",
  },
  "extension-suspected": {
    title: "Whether a specific Firebase Extension (billing, email, etc.) is actually installed",
    whenYoudHitIt:
      "During the Firestore/Functions porting pass, when a collection shows up that doesn't belong " +
      "to your own application code and nobody remembers adding.",
    howToResolve: "Check the Firebase console's Extensions tab - a five-minute look.",
  },
  "subcollection-unconfirmed": {
    title: "Whether a collection has child data this scan couldn't see",
    whenYoudHitIt:
      "Usually only once you're deep into porting that specific collection and a feature references " +
      "data that isn't anywhere in the schema you built from this report.",
    howToResolve: "A direct look at that collection in the Firestore console's data browser.",
  },
  "deep-sampling-limit": {
    title: "The actual shape of data nested two or more levels deep",
    whenYoudHitIt:
      "When you reach that specific nested feature - everything above it in the hierarchy is " +
      "accounted for in this report, this one layer isn't.",
    howToResolve: "Sample it directly with its full path, or check it in the console.",
  },
  "empty-sample": {
    title: "Whether a zero-result sample means the data genuinely isn't there, or something was misconfigured",
    whenYoudHitIt:
      "Right away, ideally - before anyone reads a zero-result as \"nothing to migrate here\" and " +
      "quietly drops it from the project plan.",
    howToResolve: "Double-check the exact path or UIDs used and re-run - a five-minute fix either way.",
  },
  "call-failed": {
    title: "An entire area this run could not read at all",
    whenYoudHitIt:
      "Now - the score for that area reflects nothing about the actual project. Treating it as " +
      "\"simple\" because it happened to score low would be a mistake, not a finding.",
    howToResolve:
      "Fix the underlying permission or credential issue (see this tool's README for the IAM roles " +
      "it expects) and re-run before trusting any number from that area.",
  },
};

export interface OpenQuestionGroup extends CategoryMeta {
  category: UncertaintyCategory;
  instances: Finding[];
}

/** Only returns categories with at least one real instance this run - never the full static taxonomy. */
export function deriveOpenQuestions(report: AssessmentReport): OpenQuestionGroup[] {
  const allFindings = report.dimensions.flatMap((d) => d.findings);
  const groups: OpenQuestionGroup[] = [];
  for (const category of Object.keys(UNCERTAINTY_CATEGORY_META) as UncertaintyCategory[]) {
    const instances = allFindings.filter((f) => f.uncertaintyCategory === category);
    if (instances.length === 0) continue;
    groups.push({ category, instances, ...UNCERTAINTY_CATEGORY_META[category] });
  }
  return groups;
}
