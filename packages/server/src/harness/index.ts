/**
 * Public API for the custom agent harness.
 *
 * Re-exports types and the main entry point.
 */

export { runAgentLoop } from "./loop";
export { registerTool, getTool, getAllTools, getToolDefinitions } from "./tools";
export type { HarnessResult, HarnessOptions, ToolDefinition, ToolExecutor, ToolContext, ToolResult } from "./types";
export { estimateCost } from "./types";
export { getSecret } from "./secrets";
export { McpClient, McpManager, type McpServerConfig } from "./mcp";
