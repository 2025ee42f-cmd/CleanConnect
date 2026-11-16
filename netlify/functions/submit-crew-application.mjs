import { randomUUID } from "node:crypto";
import { usersStore, hashPassword, requireAuth, json, preflight } from "./_utils.mjs";
import { getStore } from "@netlify/blobs";

function applicationsStore() {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  const config = siteID && token ? { name: "cleanconnect-recruitment", siteID, token } : "cleanconnect-recruitment";
  return getStore(config);
}

export { applicationsStore };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid request body." }); }

  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const birthplace = (body.birthplace || "").trim();
  const education = (body.education || "").trim();
  const description = (body.description || "").trim();
  const age = Number(body.age);

  if (!name || !email || !password || !education || !description) {
    return json(400, { error: "All recruitment fields are required." });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return json(400, { error: "Please enter a valid email address." });
  }
  if (!Number.isInteger(age) || age < 18 || age > 100) {
    return json(400, { error: "Crew applicants must be 18 or older." });
  }
  if (password.length < 6) {
    return json(400, { error: "Password must be at least 6 characters." });
  }
  if (!["Semi-schooled", "10th", "12th"].includes(education)) {
    return json(400, { error: "Please select a valid education level." });
  }
  if (description.length < 10 || description.length > 1500) {
    return json(400, { error: "Description must be between 10 and 1500 characters." });
  }

  const uStore = usersStore();
  const existingUser = await uStore.get(`user:${email}`, { type: "json" });
  if (existingUser) {
    return json(409, { error: "An account with that email already exists." });
  }

  const store = applicationsStore();
  const { blobs } = await store.list({ prefix: "application:" });
  for (const b of blobs) {
    const app = await store.get(b.key, { type: "json" });
    if (app && app.email === email && app.status === "pending") {
      return json(409, { error: "A recruitment application for this email is already pending." });
    }
  }

  const now = new Date().toISOString();
  const application = {
    id: randomUUID(),
    name,
    email,
    age,
    birthplace,
    education,
    description,
    passwordHash: hashPassword(password),
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  await store.setJSON(`application:${application.id}`, application);

  return json(201, {
    application: {
      id: application.id,
      name: application.name,
      email: application.email,
      age: application.age,
      birthplace: application.birthplace,
      education: application.education,
      description: application.description,
      status: application.status,
      createdAt: application.createdAt,
    },
    message: "Application submitted. An administrator will review it.",
  });
};
