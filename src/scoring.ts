import type { AssessmentReport, DimensionResult } from "./types.js";

const DIMENSION_WEIGHTS: Record<string, number> = {
  "Firestore Schema -> Relational Schema": 2.5,
  "Cloud Functions -> Endpoints & Hooks": 2.5,
  "Security Rules -> Authorization Logic": 2,
  "Firebase Auth -> Serverpod Auth": 1.5,
  "Realtime Database -> Relational Schema": 1,
  "Remote Config -> Feature Flags": 0.5,
  "Cloud Storage -> Object Storage": 0.5,
  "Data Connect -> Already Postgres": 0.5,
  "Operational Context": 0.5,
};

export function scoreOverall(dimensions: DimensionResult[]): {
  overallScore: number;
  band: AssessmentReport["band"];
} {
  let weightedSum = 0;
  let weightTotal = 0;
  for (const d of dimensions) {
    const w = DIMENSION_WEIGHTS[d.dimension] ?? 1;
    weightedSum += d.score * w;
    weightTotal += w;
  }
  const overallScore = weightTotal > 0 ? Math.max(0, Math.min(10, weightedSum / weightTotal)) : 0;

  let band: AssessmentReport["band"];
  if (overallScore <= 2.5) band = "trivial";
  else if (overallScore <= 5) band = "moderate";
  else if (overallScore <= 7.5) band = "substantial";
  else band = "major-rewrite";

  return { overallScore: Math.round(overallScore * 10) / 10, band };
}
