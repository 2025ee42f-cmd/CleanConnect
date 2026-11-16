import { randomUUID } from "node:crypto";
import { feedbackStore, reportsStore, requireAuth, json, preflight } from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const { session, error } = await requireAuth(event, ["public", "admin"]);
  if (error) return error;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const { reportId, resolved, rating, comment } = body;
  if (!reportId || typeof resolved !== "boolean") {
    return json(400, { error: "reportId and resolved (Yes/No) are required." });
  }

  const rStore = reportsStore();
  const report = await rStore.get(`report:${reportId}`, { type: "json" });
  if (!report) return json(404, { error: "Report not found." });

  if (report.reportedBy?.email !== session.email && session.role !== "admin") {
    return json(403, { error: "Only the original reporter can give feedback on this report." });
  }
  if (report.status !== "Resolved") {
    return json(409, { error: "Feedback can only be given once a report is marked Resolved." });
  }

  const fStore = feedbackStore();
  const feedback = {
    id: randomUUID(),
    reportId,
    resolved,
    rating: typeof rating === "number" ? Math.max(1, Math.min(5, rating)) : null,
    comment: (comment || "").trim(),
    submittedBy: session.email,
    createdAt: new Date().toISOString(),
  };
  await fStore.setJSON(`feedback:${reportId}`, feedback);

  return json(201, {
    feedback,
    message: resolved
      ? "Community confirmed resolution. Please upload an after-cleaning photo if you haven't already."
      : "Thanks for the feedback. This report will be reviewed further.",
  });
};
