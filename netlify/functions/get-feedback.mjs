import { feedbackStore, reportsStore, requireAuth, json, preflight } from "./_utils.mjs";

// Returns true if this session is allowed to see feedback for the given report:
// admins see everything, public users see feedback on reports they filed,
// crew see feedback on reports assigned to them.
function canSeeReport(session, report) {
  if (!report) return false;
  if (session.role === "admin") return true;
  if (session.role === "public") return report.reportedBy?.email === session.email;
  if (session.role === "crew") return report.assignedCrew?.email === session.email;
  return false;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();

  const { session, error } = await requireAuth(event);
  if (error) return error;

  const params = event.queryStringParameters || {};
  const store = feedbackStore();
  const rStore = reportsStore();

  if (params.reportId) {
    const report = await rStore.get(`report:${params.reportId}`, { type: "json" });
    if (!canSeeReport(session, report)) {
      return json(403, { error: "You do not have permission to view feedback for this report." });
    }
    const feedback = await store.get(`feedback:${params.reportId}`, { type: "json" });
    return json(200, { feedback: feedback || null });
  }

  // Admin-only: listing feedback across every report is an administrative view.
  const { error: adminError } = await requireAuth(event, ["admin"]);
  if (adminError) {
    return json(403, { error: "Only admins can list feedback across all reports. Pass a reportId to view a specific report's feedback." });
  }

  const { blobs } = await store.list({ prefix: "feedback:" });
  const feedbackList = [];
  for (const b of blobs) {
    const f = await store.get(b.key, { type: "json" });
    if (f) feedbackList.push(f);
  }
  feedbackList.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return json(200, { feedback: feedbackList });
};
