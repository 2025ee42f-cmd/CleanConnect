import { reportsStore, requireAuth, json, preflight } from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();

  const { session, error } = await requireAuth(event);
  if (error) return error;

  const store = reportsStore();
  const { blobs } = await store.list({ prefix: "report:" });

  let reports = [];
  for (const b of blobs) {
    const r = await store.get(b.key, { type: "json" });
    if (r) reports.push(r);
  }

  const params = event.queryStringParameters || {};

  // Scope visibility by role
  if (session.role === "public") {
    reports = reports.filter((r) => r.reportedBy.email === session.email);
  } else if (session.role === "crew") {
    reports = reports.filter((r) => r.reviewStatus === "Accepted");
    if (params.scope === "mine") {
      reports = reports.filter((r) => r.assignedCrew?.email === session.email);
    }
  }
  // admin sees everything

  if (params.status) {
    reports = reports.filter((r) => r.status === params.status);
  }

  reports.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return json(200, { reports });
};
