// How Claude Code names the tools of MCP servers: mcp__<server>__<tool>, where <server> is the server's name with
// every character outside [A-Za-z0-9_-] replaced by an underscore.

export interface McpToolName {
  /** The server's name as it appears in the tool name. */
  server: string;
  tool: string;
}

export function mcpToolName(name: string): McpToolName | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1], tool: match[2] } : undefined;
}

/** A server's name as it appears inside its tool names. */
export function mcpServerKey(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}
