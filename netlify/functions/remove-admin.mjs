import { usersStore, requireAuth, json, preflight } from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST" && event.httpMethod !== "DELETE") {
    return json(405, { error: "Method not allowed" });
  }

  const { session, error } = await requireAuth(event, ["admin"]);
  if (error) return error;

  const primaryEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!primaryEmail) {
    return json(500, { error: "Primary admin is not configured." });
  }
  if ((session.email || "").trim().toLowerCase() !== primaryEmail) {
    return json(403, { error: "Only the main administrator can remove other administrator accounts." });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid request body." }); }

  const email = (body.email || event.queryStringParameters?.email || "").trim().toLowerCase();
  if (!email) return json(400, { error: "Administrator email is required." });
  if (email === primaryEmail) return json(400, { error: "The main administrator account cannot be removed." });

  const store = usersStore();
  const key = `user:${email}`;
  const user = await store.get(key, { type: "json" });
  if (!user) return json(404, { error: "Administrator not found." });
  if (user.role !== "admin") return json(400, { error: "The selected account is not an administrator." });

  await store.delete(key);
  return json(200, { message: `Administrator ${email} was removed successfully.` });
};
