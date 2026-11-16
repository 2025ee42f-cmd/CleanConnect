import { randomUUID } from "node:crypto";
import {
  usersStore,
  hashPassword,
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

  await ensureAdminSeeded();

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const role = body.role === "crew" ? "crew" : "public"; // public self-registers; crew normally added by admin

  if (!name || !email || !password) {
    return json(400, { error: "Name, email and password are all required." });
  }
  if (password.length < 6) {
    return json(400, { error: "Password must be at least 6 characters." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return json(400, { error: "Please enter a valid email address." });
  }

  const store = usersStore();
  const key = `user:${email}`;
  const existing = await store.get(key, { type: "json" });
  if (existing) {
    return json(409, { error: "An account with that email already exists." });
  }

  const user = {
    id: randomUUID(),
    name,
    email,
    role,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  await store.setJSON(key, user);

  const token = await createSession(user);
  return json(201, { user: safeUser(user) }, { "Set-Cookie": sessionCookieHeader(token) });
};
