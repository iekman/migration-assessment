import { extractResultData, type IMcpClient } from "../firebaseMcpClient.js";
import type { DimensionResult, Finding } from "../types.js";

interface UserRecord {
  providerData?: Array<{ providerId?: string }>;
  customClaims?: Record<string, unknown>;
  phoneNumber?: string;
  email?: string;
}

export async function collectAuth(client: IMcpClient, sampleUids: string[]): Promise<DimensionResult> {
  const findings: Finding[] = [];
  let complexityPoints = 0;

  if (sampleUids.length === 0) {
    findings.push({
      dimension: "auth",
      severity: "low",
      weight: 1,
      summary: "No auth sample UIDs configured",
      detail:
        "get_users requires specific identifiers (uid/email/phone) — there is no bulk export tool. " +
        "Supply a handful of representative UIDs in authSampleUids to assess provider/claims mix.",
    });
    return { dimension: "Firebase Auth -> Serverpod Auth", score: 3, findings };
  }

  const toolName = await client.resolveToolName("auth_get_users", "get_users");
  if (!toolName) {
    findings.push({
      dimension: "auth",
      severity: "medium",
      weight: 1,
      summary: "get_users tool not found on MCP server",
      detail: "Auth surface could not be sampled.",
    });
    return { dimension: "Firebase Auth -> Serverpod Auth", score: 5, findings };
  }

  try {
    const result = await client.callReadOnlyTool(toolName, { uids: sampleUids });
    const data = extractResultData(result) as { users?: UserRecord[] } | UserRecord[];
    const users = (Array.isArray(data) ? data : data.users ?? []) as UserRecord[];

    const providers = new Set<string>();
    let withClaims = 0;
    for (const u of users) {
      for (const p of u.providerData ?? []) {
        if (p.providerId) providers.add(p.providerId);
      }
      if (u.customClaims && Object.keys(u.customClaims).length > 0) withClaims += 1;
    }

    const nonPasswordProviders = [...providers].filter((p) => p !== "password");
    if (providers.has("phone")) {
      complexityPoints += 2;
      findings.push({
        dimension: "auth",
        severity: "high",
        weight: 2,
        summary: "Phone-number auth in use",
        detail: "Serverpod's built-in auth module doesn't ship phone/SMS auth — needs a custom provider wired to an SMS vendor.",
      });
    }
    if (nonPasswordProviders.some((p) => p.includes(".com") || p === "anonymous")) {
      complexityPoints += 1.5;
      findings.push({
        dimension: "auth",
        severity: "medium",
        weight: 1.5,
        summary: `OAuth/anonymous providers observed: ${nonPasswordProviders.join(", ")}`,
        detail:
          "Google/Apple/Facebook/anonymous sign-in each need their own Serverpod auth module " +
          "(serverpod_auth_idp identity providers), configured and their tokens re-verified server-side.",
      });
    }
    if (withClaims > 0) {
      complexityPoints += 1.5;
      findings.push({
        dimension: "auth",
        severity: "medium",
        weight: 1.5,
        summary: `${withClaims}/${users.length} sampled users carry custom claims`,
        detail:
          "Firebase custom claims (roles/permissions baked into the ID token) map to Serverpod's " +
          "Set<Scope> on a user, checked via requiredScopes on an endpoint — a real analog, but " +
          "coarser: a scope check is endpoint/method-level, not an arbitrary per-record expression.",
      });
    }
    if (providers.size <= 1 && providers.has("password") && withClaims === 0) {
      findings.push({
        dimension: "auth",
        severity: "low",
        weight: 0.5,
        summary: "Email/password only, no custom claims in sample",
        detail: "Closest fit to Serverpod's out-of-the-box email auth module — lowest-cost case.",
      });
    }
  } catch (err) {
    findings.push({
      dimension: "auth",
      severity: "medium",
      weight: 1,
      summary: "Failed to sample users",
      detail: String(err instanceof Error ? err.message : err),
    });
  }

  return { dimension: "Firebase Auth -> Serverpod Auth", score: Math.min(10, complexityPoints), findings };
}
