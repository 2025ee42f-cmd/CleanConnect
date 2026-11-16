import { reportsStore, usersStore, feedbackStore, requireAuth, canTransition, json, preflight } from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST" && event.httpMethod !== "PATCH") {
    return json(405, { error: "Method not allowed" });
  }

  const { session, error } = await requireAuth(event, ["crew", "admin"]);
  if (error) return error;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const { reportId, action } = body;
  if (!reportId || !action) {
    return json(400, { error: "reportId and action are required." });
  }

  const store = reportsStore();
  const key = `report:${reportId}`;
  const report = await store.get(key, { type: "json" });
  if (!report) return json(404, { error: "Report not found." });

  const now = new Date().toISOString();

  if (action === "approve" || action === "reject") {
    if (session.role !== "admin") return json(403, { error: "Only admin can review submitted reports." });
    if (report.status !== "Submitted") {
      return json(409, { error: `Only newly submitted reports can be reviewed. Current status: "${report.status}".` });
    }
    if (report.reviewStatus === "Accepted" && action === "approve") {
      return json(200, { report });
    }
    if (action === "reject") {
      await store.delete(key);
      await feedbackStore().delete(`feedback:${reportId}`);
      return json(200, { deleted: true, reportId, message: "Report rejected and removed." });
    }
    report.reviewStatus = "Accepted";
    report.reviewedAt = now;
    report.reviewedBy = session.email;
    report.timeline = Array.isArray(report.timeline) ? report.timeline : [];
    report.timeline.push({ status: "Accepted", at: now, by: session.email });
    report.updatedAt = now;
    await store.setJSON(key, report);
    return json(200, { report, message: "Report accepted and ready for crew assignment." });
  }

  if (action === "assign") {
    if (session.role !== "admin") return json(403, { error: "Only admin can assign crew." });
    if (report.status !== "Submitted" || report.reviewStatus !== "Accepted") {
      return json(409, { error: "Only an accepted submitted report can be assigned to crew." });
    }
    const { crewEmail } = body;
    if (!crewEmail) return json(400, { error: "crewEmail is required." });

    const uStore = usersStore();
    const crewUser = await uStore.get(`user:${crewEmail.toLowerCase()}`, { type: "json" });
    if (!crewUser || crewUser.role !== "crew") {
      return json(400, { error: "That email does not belong to a crew member." });
    }

    report.assignedCrew = { id: crewUser.id, name: crewUser.name, email: crewUser.email };
    report.updatedAt = now;
    await store.setJSON(key, report);
    return json(200, { report });
  }

  if (action === "start") {
    // Accepted Submitted -> In Progress
    if (report.status === "Submitted" && report.reviewStatus !== "Accepted") {
      return json(409, { error: "This report is waiting for admin review." });
    }
    if (!canTransition(report.status, "In Progress")) {
      return json(409, { error: `Cannot start work: report is currently "${report.status}".` });
    }
    if (session.role === "crew") {
      report.assignedCrew = report.assignedCrew || {
        id: session.userId,
        name: session.email,
        email: session.email,
      };
      if (report.assignedCrew.email !== session.email) {
        return json(403, { error: "This report is assigned to a different crew member." });
      }
    }
    report.status = "In Progress";
    report.timeline.push({ status: "In Progress", at: now, by: session.email });
    report.updatedAt = now;
    await store.setJSON(key, report);
    return json(200, { report });
  }

  if (action === "resolve") {
    // In Progress -> Resolved, requires after photo
    if (!canTransition(report.status, "Resolved")) {
      return json(409, { error: `Cannot resolve: report is currently "${report.status}".` });
    }
    const { afterPhoto } = body;
    if (!afterPhoto) {
      return json(400, { error: "An after-cleaning evidence photo is required to resolve." });
    }
    if (session.role === "crew" && report.assignedCrew?.email !== session.email) {
      return json(403, { error: "This report is assigned to a different crew member." });
    }
    report.afterPhoto = afterPhoto;
    report.status = "Resolved";
    report.timeline.push({ status: "Resolved", at: now, by: session.email });
    report.updatedAt = now;
    await store.setJSON(key, report);
    return json(200, { report });
  }

  return json(400, { error: `Unknown action "${action}".` });
};
