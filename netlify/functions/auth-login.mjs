import {
  usersStore,
  verifyPassword,
  createSession,
  json,
  preflight,
  safeUser,
  ensureAdminSeeded,
  sessionCookieHeader,
} from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    await ensureAdminSeeded();
  } catch (error) {
    console.error("Admin seed failed:", error);
    return json(500, { error: "Server storage is not configured correctly." });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!email || !password) {
    return json(400, { error: "Email and password are required." });
  }

  let user;
  try {
    const store = usersStore();
    user = await store.get(`user:${email}`, { type: "json" });
  } catch (error) {
    console.error("User lookup failed:", error);
    return json(500, { error: "Unable to access user database." });
  }

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return json(401, { error: "Incorrect email or password." });
  }

  try {
    const token = await createSession(user);
    return json(200, { user: safeUser(user) }, { "Set-Cookie": sessionCookieHeader(token) });
  } catch (error) {
    console.error("Session creation failed:", error);
    return json(500, { error: "Unable to create login session." });
  }
};
