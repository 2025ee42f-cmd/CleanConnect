import { requireAuth, json, preflight } from "./_utils.mjs";
import { applicationsStore } from "./submit-crew-application.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });

  const { error } = await requireAuth(event, ["admin"]);
  if (error) return error;

  const store = applicationsStore();
  const { blobs } = await store.list({ prefix: "application:" });
  const applications = [];

  for (const b of blobs) {
    const app = await store.get(b.key, { type: "json" });
    if (app) {
      const { passwordHash, ...safe } = app;
      applications.push(safe);
    }
  }

  applications.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json(200, {
    applications,
    pendingCount: applications.filter((a) => a.status === "pending").length,
  });
};
