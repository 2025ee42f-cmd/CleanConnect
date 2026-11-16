import { getSession, usersStore, json, preflight, safeUser } from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();

  const session = await getSession(event);
  if (!session) return json(401, { error: "Not authenticated." });

  const store = usersStore();
  const user = await store.get(`user:${session.email}`, { type: "json" });
  if (!user) return json(401, { error: "Session user no longer exists." });

  return json(200, { user: safeUser(user) });
};
