import { requireAuth, json, preflight } from "./_utils.mjs";
import { applicationsStore } from "./submit-crew-application.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const { error } = await requireAuth(event, ["admin"]);
  if (error) return error;

  const store = applicationsStore();
  const { blobs } = await store.list({ prefix: "application:" });
  let deletedCount = 0;

  for (const blob of blobs) {
    const application = await store.get(blob.key, { type: "json" });
    if (application?.status !== "rejected") continue;
    await store.delete(blob.key);
    deletedCount += 1;
  }

  return json(200, {
    deletedCount,
    message: `${deletedCount} rejected recruitment application(s) cleared.`,
  });
};
