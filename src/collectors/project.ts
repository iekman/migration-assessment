import { extractResultData, type IMcpClient } from "../firebaseMcpClient.js";

export interface ProjectSummary {
  projectId: string;
  displayName?: string;
  apps: Array<{ platform: string; appId: string }>;
}

export async function collectProject(client: IMcpClient, projectId: string): Promise<ProjectSummary> {
  const summary: ProjectSummary = { projectId, apps: [] };

  const getProjectTool = await client.resolveToolName("core_get_project", "get_project");
  if (getProjectTool) {
    try {
      const result = await client.callReadOnlyTool(getProjectTool, { project_id: projectId });
      const data = extractResultData(result) as { displayName?: string };
      summary.displayName = data.displayName;
    } catch {
      // non-fatal: project metadata is descriptive only
    }
  }

  const listAppsTool = await client.resolveToolName("core_list_apps", "list_apps");
  if (listAppsTool) {
    try {
      const result = await client.callReadOnlyTool(listAppsTool, { project_id: projectId });
      const data = extractResultData(result) as { apps?: Array<Record<string, unknown>> } | unknown[];
      const apps = Array.isArray(data) ? data : data.apps ?? [];
      summary.apps = apps.map((a) => {
        const app = a as Record<string, unknown>;
        return { platform: String(app.platform ?? app.appType ?? "unknown"), appId: String(app.appId ?? app.id ?? "unknown") };
      });
    } catch {
      // non-fatal
    }
  }

  return summary;
}
