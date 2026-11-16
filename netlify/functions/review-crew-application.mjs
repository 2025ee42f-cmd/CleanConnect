import { requireAuth, json, preflight, usersStore, safeUser } from "./_utils.mjs";
import { applicationsStore } from "./submit-crew-application.mjs";
import { randomUUID } from "node:crypto";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const { session, error } = await requireAuth(event, ["admin"]);
  if (error) return error;

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid request body." }); }

  const applicationId = (body.applicationId || "").trim();
  const action = (body.action || "").trim().toLowerCase();

  if (!applicationId || !["approve", "reject"].includes(action)) {
    return json(400, { error: "applicationId and action (approve/reject) are required." });
  }

  const store = applicationsStore();
  const key = `application:${applicationId}`;
  const application = await store.get(key, { type: "json" });
  if (!application) return json(404, { error: "Application not found." });
  if (application.status !== "pending") {
    return json(409, { error: `This application has already been ${application.status}.` });
  }

  const now = new Date().toISOString();

  if (action === "reject") {
    application.status = "rejected";
    application.reviewedBy = session.email;
    application.reviewedAt = now;
    application.updatedAt = now;
    await store.setJSON(key, application);
    return json(200, { message: "Application rejected.", application: publicApplication(application) });
  }

  const uStore = usersStore();
  const existing = await uStore.get(`user:${application.email}`, { type: "json" });
  if (existing) {
    return json(409, { error: "This applicant's email is already registered." });
  }

  const crew = {
    id: randomUUID(),
    name: application.name,
    email: application.email,
    role: "crew",
    age: application.age,
    birthplace: application.birthplace,
    education: application.education,
    description: application.description,
    passwordHash: application.passwordHash,
    createdBy: session.email,
    createdAt: now,
  };

  await uStore.setJSON(`user:${crew.email}`, crew);

  application.status = "approved";
  application.reviewedBy = session.email;
  application.reviewedAt = now;
  application.updatedAt = now;
  application.approvedCrewId = crew.id;
  await store.setJSON(key, application);

  return json(200, {
    message: "Application approved. Crew account created.",
    application: publicApplication(application),
    user: safeUser(crew),
  });
};

function publicApplication(app) {
  const { passwordHash, ...safe } = app;
  return safe;
}
