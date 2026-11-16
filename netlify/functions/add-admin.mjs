import { randomUUID } from "node:crypto";
import { usersStore, hashPassword, requireAuth, json, preflight, safeUser } from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const { session, error } = await requireAuth(event, ["admin"]);
  if (error) return error;

  const primaryEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!primaryEmail || (session.email || "").trim().toLowerCase() !== primaryEmail) {
    return json(403, { error: "Only the main administrator can create additional administrator accounts." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid request body." }); }

  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!name || !email || !password) {
    return json(400, { error: "Name, email and password are all required." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return json(400, { error: "Please enter a valid email address." });
  }
  if (password.length < 8) {
    return json(400, { error: "Admin password must be at least 8 characters." });
  }

  const store = usersStore();
  const key = `user:${email}`;
  const existing = await store.get(key, { type: "json" });
  if (existing) return json(409, { error: "An account with that email already exists." });

  const admin = {
    id: randomUUID(),
    name,
    email,
    role: "admin",
    passwordHash: hashPassword(password),
    createdBy: session.email,
    createdAt: new Date().toISOString(),
  };
  await store.setJSON(key, admin);

  return json(201, { user: safeUser(admin) });
};
