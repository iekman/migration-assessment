#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ReadOnlyMcpClient, type IMcpClient } from "./firebaseMcpClient.js";
import { MockMcpClient } from "./mockClient.js";
import { loadConfig, type AssessorConfig } from "./config.js";
import { collectRules } from "./collectors/rules.js";
import { collectFirestore } from "./collectors/firestore.js";
import { collectFunctions } from "./collectors/functions.js";
import { collectAuth } from "./collectors/auth.js";
import { collectRealtimeDatabase } from "./collectors/realtimeDatabase.js";
import { collectRemoteConfig } from "./collectors/remoteConfig.js";
import { collectDataConnect } from "./collectors/dataConnect.js";
import { assessStorage } from "./collectors/storage.js";
import { collectProject } from "./collectors/project.js";
import { collectUserContext } from "./collectors/userContext.js";
import { scoreOverall } from "./scoring.js";
import { renderMarkdown, renderJson } from "./report.js";
import { enrichWithServerpodOracle } from "./serverpodOracle.js";
import type { AssessmentReport, DimensionResult } from "./types.js";

interface CliArgs {
  config?: string;
  mock: boolean;
  out: string;
  format: "md" | "json" | "both";
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mock: false, out: "report", format: "md" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") args.config = argv[++i];
    else if (a === "--mock") args.mock = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--format") args.format = argv[++i] as CliArgs["format"];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printHelp();
      process.exit(1);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`fb-to-serverpod-assessor

Usage:
  fb-to-serverpod-assessor --config <path> [--out report] [--format md|json|both]
  fb-to-serverpod-assessor --mock --config fixtures/mock-project.config.json

Options:
  --config <path>   Path to an AssessorConfig JSON file (see fixtures/mock-project.config.json
                     for the shape). Required.
  --mock            Use canned fixture data instead of spawning a real Firebase MCP server.
  --out <path>      Output file path without extension (default: "report").
  --format          "md" (default), "json", or "both".

Real-mode setup:
  1. Authenticate read-only access — prefer a service account bound to viewer-only
     roles (roles/viewer, roles/datastore.viewer, roles/firebaseauth.viewer,
     roles/cloudfunctions.viewer) and set GOOGLE_APPLICATION_CREDENTIALS.
  2. Install firebase-tools so \`firebase mcp\` is on your PATH, or point
     mcpCommand/mcpArgs in your config file at however you invoke it.
  3. Fill in what MCP can't discover on its own: firestoreCollections,
     knownSubcollections, denormalizedFields, multiTenant, installedExtensions,
     deploymentModel, functionSideEffects — see README.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    console.error("Missing required --config <path>. Run with --help for usage.");
    process.exit(1);
  }

  const config: AssessorConfig = loadConfig(args.config);
  const client: IMcpClient = args.mock
    ? new MockMcpClient(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "mock-project.json"))
    : new ReadOnlyMcpClient("firebase-mcp", config.mcpCommand, config.mcpArgs);

  if (client instanceof ReadOnlyMcpClient) {
    console.error(`Connecting to Firebase MCP server: ${config.mcpCommand} ${config.mcpArgs.join(" ")}`);
    await client.connect();
  }

  try {
    const project = await collectProject(client, config.projectId);
    console.error(`Assessing project: ${project.displayName ?? project.projectId} (${project.apps.length} app(s))`);

    const rulesResult = await collectRules(client, config.multiTenant, config.tenantIsolationNote);
    const seedCollections = [...new Set([...config.firestoreCollections, ...rulesResult.discoveredFirestoreCollections])];

    const dimensions: DimensionResult[] = [
      rulesResult.dimension,
      await collectFirestore(client, seedCollections, config.knownSubcollections, config.denormalizedFields, config.sampleSize),
      await collectFunctions(client, config.deploymentModel, config.functionSideEffects),
      await collectAuth(client, config.authSampleUids),
      await collectRealtimeDatabase(client, config.realtimeDatabasePaths),
      await collectRemoteConfig(client),
      await collectDataConnect(client),
      assessStorage(),
      collectUserContext(config),
    ];

    const { overallScore, band } = scoreOverall(dimensions);

    const report: AssessmentReport = {
      projectId: config.projectId,
      generatedAt: new Date().toISOString(),
      mock: args.mock,
      overallScore,
      band,
      dimensions,
      skipped: [],
      userProvidedContext: [
        ...(config.multiTenant ? ["multiTenant"] : []),
        ...(config.installedExtensions.length > 0 ? ["installedExtensions"] : []),
        ...(Object.keys(config.knownSubcollections).length > 0 ? ["knownSubcollections"] : []),
        ...(config.denormalizedFields.length > 0 ? ["denormalizedFields"] : []),
        ...(Object.keys(config.functionSideEffects).length > 0 ? ["functionSideEffects"] : []),
      ],
    };

    await enrichWithServerpodOracle(report, config);

    if (args.format === "md" || args.format === "both") {
      writeFileSync(`${args.out}.md`, renderMarkdown(report), "utf-8");
      console.error(`Wrote ${args.out}.md`);
    }
    if (args.format === "json" || args.format === "both") {
      writeFileSync(`${args.out}.json`, renderJson(report), "utf-8");
      console.error(`Wrote ${args.out}.json`);
    }

    console.error(`\nOverall complexity: ${overallScore.toFixed(1)}/10 (${band})`);
  } finally {
    if (client instanceof ReadOnlyMcpClient) await client.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
