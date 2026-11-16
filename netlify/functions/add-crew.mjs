import { randomUUID } from "node:crypto";
import { usersStore, hashPassword, requireAuth, json, preflight, safeUser } from "./_utils.mjs";

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

  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";

  if (!name || !email || !password) {
    return json(400, { error: "Name, email and password are all required." });
  }
  if (password.length < 6) {
    return json(400, { error: "Password must be at least 6 characters." });
  }

  const store = usersStore();
  const key = `user:${email}`;
  const existing = await store.get(key, { type: "json" });
  if (existing) {
    return json(409, { error: "An account with that email already exists." });
  }

  const crewMember = {
    id: randomUUID(),
    name,
    email,
    role: "crew",
    passwordHash: hashPassword(password),
    createdBy: session.email,
    createdAt: new Date().toISOString(),
  };
  await store.setJSON(key, crewMember);

  return json(201, { user: safeUser(crewMember) });
};
