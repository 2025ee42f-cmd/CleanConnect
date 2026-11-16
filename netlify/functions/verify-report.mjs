import { reportsStore, feedbackStore, requireAuth, canTransition, json, preflight, awardEcoPointsForVerifiedReport } from "./_utils.mjs";

// A lightweight, rule-based "AI-assisted" pre-check. It never has final
// authority -- it only surfaces a suggestion. Only an admin action with
// action: "confirm" actually moves a report to Verified.
function assistedReview({ report, feedback }) {
  const checks = {
    statusResolved: report.status === "Resolved",
    communityConfirmed: !!feedback && feedback.resolved === true,
    hasAfterPhoto: !!report.afterPhoto,
  };
  const allPass = Object.values(checks).every(Boolean);

  return {
    checks,
    result: allPass ? "Likely resolved" : "Not enough evidence",
    note: "Human confirmation required. This automated check does not have final authority.",
    readyForAdminConfirmation: allPass,
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const { session, error } = await requireAuth(event, ["admin"]);
  if (error) return error;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const { reportId, action } = body; // action: "review" | "confirm" | "reject"
  if (!reportId) return json(400, { error: "reportId is required." });

  const rStore = reportsStore();
  const key = `report:${reportId}`;
  const report = await rStore.get(key, { type: "json" });
  if (!report) return json(404, { error: "Report not found." });

  const fStore = feedbackStore();
  const feedback = await fStore.get(`feedback:${reportId}`, { type: "json" });

  const review = assistedReview({ report, feedback });

  if (!action || action === "review") {
    return json(200, { review });
  }

  if (action === "reject") {
    return json(409, { error: "Work rejection is not handled here. Reject suspicious reports during the initial Admin review." });
  }

  if (action === "confirm") {
    if (!review.readyForAdminConfirmation) {
      return json(409, {
        error: "This report does not yet meet the requirements for verification.",
        review,
      });
    }
    if (!canTransition(report.status, "Verified")) {
      return json(409, { error: `Cannot verify: report is currently "${report.status}".` });
    }
    const now = new Date().toISOString();
    report.status = "Verified";
    report.timeline.push({ status: "Verified", at: now, by: session.email });
    report.updatedAt = now;
    await rStore.setJSON(key, report);

    const ecoPoints = await awardEcoPointsForVerifiedReport(report);

    return json(200, { report, review, ecoPoints });
  }

  return json(400, { error: `Unknown action "${action}".` });
};
