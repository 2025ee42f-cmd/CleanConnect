import { reportsStore, feedbackStore, requireAuth, json, preflight } from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const { error } = await requireAuth(event, ["admin"]);
  if (error) return error;

  const store = reportsStore();
  const feedback = feedbackStore();
  const { blobs } = await store.list({ prefix: "report:" });
  let deletedCount = 0;

  for (const blob of blobs) {
    const report = await store.get(blob.key, { type: "json" });
    if (report?.status !== "Resolved") continue;
    await store.delete(blob.key);
    await feedback.delete(`feedback:${report.id}`);
    deletedCount += 1;
  }

  return json(200, {
    deletedCount,
    message: `${deletedCount} resolved report(s) cleared.`,
  });
};
