import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Deploy identity, resolved once at process start. Railway sets
// RAILWAY_GIT_COMMIT_SHA / RAILWAY_GIT_BRANCH automatically on each deploy; the
// others are fallbacks for other hosts (Heroku → SOURCE_VERSION). This is the
// same source the /health endpoint reports — exposed as an MCP tool so the
// running commit is checkable from inside a conversation, without curling /health.
const DEPLOY_SHA =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT_SHA ||
  process.env.SOURCE_VERSION ||
  "unknown";
const DEPLOY_BRANCH = process.env.RAILWAY_GIT_BRANCH || process.env.GIT_BRANCH || "unknown";
const STARTED_AT = new Date().toISOString();

export function registerVersionTools(server: McpServer): void {
  server.tool(
    "get_server_version",
    "Report the running server's deployed git commit SHA, branch, and start time. Use this to verify a specific fix/commit is actually LIVE before assuming a tool's output reflects the latest code — e.g. confirm the deployed SHA is at or past the commit you expect. Reads the deploy SHA from the host's git env var (Railway sets it per deploy); 'unknown' means no such var is set in this environment.",
    {},
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              git_sha: DEPLOY_SHA,
              git_sha_short: DEPLOY_SHA === "unknown" ? "unknown" : DEPLOY_SHA.slice(0, 7),
              git_branch: DEPLOY_BRANCH,
              started_at: STARTED_AT,
              note:
                DEPLOY_SHA === "unknown"
                  ? "No deploy SHA env var set (RAILWAY_GIT_COMMIT_SHA / GIT_COMMIT_SHA / SOURCE_VERSION). On Railway this is populated automatically on each deploy."
                  : undefined,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}
