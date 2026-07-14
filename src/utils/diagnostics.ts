import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Internal diagnostic/probe tools (debug_bill_fields, test_update_line_item,
// test_update_time_entry, probe_billing_write_apis, probe_clio_report_apis,
// dump_compare_layout) are for developing against Clio API quirks — they are
// not part of the everyday tool surface and confuse users when they show up
// in the connector's tool list (reported 2026-07-03). They register only when
// ENABLE_DIAGNOSTIC_TOOLS=true is set on the deployment.

// Lenient truthy parse: dashboards (Railway etc.) hand back whatever casing
// the operator typed, and a strict === "true" silently no-ops on "True"/"1"
// (bitten 2026-07-14 — flag set, tools never registered, no signal anywhere).
export function diagnosticToolsEnabled(): boolean {
  const raw = (process.env.ENABLE_DIAGNOSTIC_TOOLS ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

const noopRegistrar = {
  tool: (..._args: unknown[]) => undefined,
} as unknown as Pick<McpServer, "tool">;

/**
 * Registration gate for diagnostic tools: use
 * `diagnosticTool(server).tool(...)` instead of `server.tool(...)` at the
 * registration site. When diagnostics are disabled the registration is a
 * no-op, so the tool never appears in tools/list.
 */
export function diagnosticTool(server: McpServer): Pick<McpServer, "tool"> {
  return diagnosticToolsEnabled() ? server : noopRegistrar;
}
