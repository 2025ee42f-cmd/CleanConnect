import { reportsStore, requireAuth, json, preflight } from "./_utils.mjs";

// Lets crew (while resolving) or the original reporter (during community
// verification) attach/replace the after-cleaning evidence photo.
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const { session, error } = await requireAuth(event, ["crew", "admin", "public"]);
  if (error) return error;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const { reportId, photo } = body;
  if (!reportId || !photo) {
    return json(400, { error: "reportId and photo are required." });
  }

  const store = reportsStore();
  const key = `report:${reportId}`;
  const report = await store.get(key, { type: "json" });
  if (!report) return json(404, { error: "Report not found." });

  const isOwner = report.reportedBy?.email === session.email;
  const isAssignedCrew = report.assignedCrew?.email === session.email;
  if (session.role === "public" && !isOwner) {
    return json(403, { error: "Only the reporter can attach evidence for this report." });
  }
  if (session.role === "crew" && !isAssignedCrew) {
    return json(403, { error: "Only the assigned crew member can attach evidence for this report." });
  }
  if (!["In Progress", "Resolved"].includes(report.status)) {
    return json(409, { error: "After-cleaning evidence can only be added once work has started." });
  }

  report.afterPhoto = photo;
  report.updatedAt = new Date().toISOString();
  await store.setJSON(key, report);

  return json(200, { report });
};
