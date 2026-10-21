import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Tool-name verbs that mutate project state. Any MCP tool whose name starts
 * with one of these (after its feature prefix, e.g. "auth_update_user") is
 * refused, regardless of what the live `firebase mcp` server happens to
 * expose in whatever version is installed. This is a defense-in-depth
 * belt: the recommended real defense is running this assessor against
 * credentials scoped to a read-only IAM role (roles/viewer,
 * roles/datastore.viewer, roles/firebaseauth.viewer, etc).
 */
const MUTATING_VERBS = [
  "set_",
  "update_",
  "create_",
  "delete_",
  "remove_",
  "send_",
  "deploy",
  "init",
  "login",
  "logout",
];

/**
 * Tool names that don't match a mutating verb prefix but are still unsafe
 * for a read-only audit (e.g. dataconnect's `execute` can run arbitrary
 * GraphQL mutations against the connected Postgres instance).
 */
const EXPLICIT_DENYLIST = new Set(["execute", "dataconnect_execute"]);

function isReadOnlyToolName(name: string): boolean {
  const lower = name.toLowerCase();
  if (EXPLICIT_DENYLIST.has(lower)) return false;
  return !MUTATING_VERBS.some((verb) => {
    const idx = lower.indexOf(verb);
    if (idx === -1) return false;
    // only treat it as the "verb position" if it starts the string or
    // immediately follows a feature-name prefix separator ("_").
    return idx === 0 || lower[idx - 1] === "_";
  });
}

export interface McpToolSummary {
  name: string;
  description?: string;
  readOnly: boolean;
}

/**
 * The subset of client behavior collectors depend on. Implemented by both
 * ReadOnlyMcpClient (real, stdio-spawned server) and the mock client used
 * by `--mock` mode, so collector code is identical in both paths.
 */
export interface IMcpClient {
  listTools(): Promise<McpToolSummary[]>;
  resolveToolName(...candidates: string[]): Promise<string | null>;
  callReadOnlyTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * MCP tool results carry either `structuredContent` (preferred, already
 * JSON) or a `content` array of text/etc blocks. Firebase's MCP tools
 * mostly return JSON serialized into a text block, so fall back to
 * parsing that when there's no structured content.
 */
export function extractResultData(result: unknown): unknown {
  const r = result as {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
  };
  if (r.structuredContent && Object.keys(r.structuredContent).length > 0) {
    return r.structuredContent;
  }
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) return r.content;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A thin wrapper around the MCP SDK client that spawns a target MCP
 * server over stdio and hard-blocks any tool call whose name looks
 * mutating. Used both for the Firebase MCP server and (optionally) the
 * serverpod_mcp docs/Q&A server.
 */
export class ReadOnlyMcpClient implements IMcpClient {
  private client: Client;
  private transport: StdioClientTransport;
  private connected = false;
  private toolCache: McpToolSummary[] | null = null;

  constructor(
    private readonly label: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ) {
    this.transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...env } as Record<string, string>,
      stderr: "pipe",
    });
    this.client = new Client({ name: "fb-to-serverpod-assessor", version: "0.1.0" }, {});
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.transport.close();
      this.connected = false;
    }
  }

  async listTools(): Promise<McpToolSummary[]> {
    if (this.toolCache) return this.toolCache;
    const { tools } = await this.client.listTools();
    this.toolCache = tools.map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: isReadOnlyToolName(t.name),
    }));
    return this.toolCache;
  }

  /** Returns the first tool name available on the server matching any of the given candidates. */
  async resolveToolName(...candidates: string[]): Promise<string | null> {
    const tools = await this.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const c of candidates) {
      if (names.has(c)) return c;
    }
    // fall back to suffix match, since exact prefixing conventions can
    // change between firebase-tools versions (e.g. "firestore_query_collection"
    // vs "query_collection").
    for (const c of candidates) {
      const hit = [...names].find((n) => n.endsWith(c) || n === c);
      if (hit) return hit;
    }
    return null;
  }

  async callReadOnlyTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!isReadOnlyToolName(name)) {
      throw new Error(
        `[${this.label}] refusing to call "${name}": name matches a mutating-verb pattern. ` +
          `This assessor only ever calls read/list/get/query-shaped tools.`,
      );
    }
    const tools = await this.listTools();
    const found = tools.find((t) => t.name === name);
    if (!found) {
      throw new Error(`[${this.label}] tool "${name}" is not exposed by this MCP server.`);
    }
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const text = Array.isArray(result.content)
        ? result.content.map((c: any) => c.text ?? "").join("\n")
        : String(result.content);
      throw new Error(`[${this.label}] tool "${name}" returned an error: ${text}`);
    }
    return result;
  }
}
