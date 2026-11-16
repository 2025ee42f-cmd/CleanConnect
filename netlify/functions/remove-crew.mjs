import { usersStore, requireAuth, json, preflight } from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "DELETE" && event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const { session, error } = await requireAuth(event, ["admin"]);
  if (error) return error;

  let body = {};
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid request body." }); }

  const email = (body.email || event.queryStringParameters?.email || "").trim().toLowerCase();
  if (!email) return json(400, { error: "Crew email is required." });
  if (email === session.email) return json(400, { error: "You cannot remove your own admin account." });

  const store = usersStore();
  const key = `user:${email}`;
  const user = await store.get(key, { type: "json" });

  if (!user) return json(404, { error: "User not found." });
  if (user.role !== "crew") return json(400, { error: "Only crew members can be removed here." });

  await store.delete(key);
  return json(200, { message: `Crew member ${email} was removed.` });
};
