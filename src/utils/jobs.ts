// ============================================================
// Background-job registry for long-running tools (download_dashboard_update).
// ============================================================

// ---- Background-job registry for long-running dashboard updates ----
// download_dashboard_update can take several minutes (classic mode generates a
// revenue report per timekeeper), well past the MCP client's ~180s timeout. So
// it runs as a detached job: the tool returns a job_id immediately and the work
// continues server-side; get_dashboard_status reports progress/result. The Map
// is a module singleton, so it persists across tool calls for the life of the
// server process (jobs are lost only if the process restarts).
export type DashJob = {
  id: string;
  status: "running" | "done" | "error";
  started_at: string;
  finished_at?: string;
  result?: any;
  error?: string;
};
export const dashboardJobs = new Map<string, DashJob>();
export function pruneDashboardJobs() {
  const now = Date.now();
  for (const [id, j] of dashboardJobs) {
    if (j.finished_at && now - new Date(j.finished_at).getTime() > 2 * 3600 * 1000) dashboardJobs.delete(id);
  }
  while (dashboardJobs.size > 50) {
    const oldest = dashboardJobs.keys().next().value;
    if (oldest === undefined) break;
    dashboardJobs.delete(oldest);
  }
}
