import { randomUUID } from "node:crypto";
import { reportsStore, usersStore, requireAuth, json, preflight } from "./_utils.mjs";

const ISSUE_TYPES = [
  "Overflowing garbage",
  "Illegal dumping",
  "Road waste",
  "Drain blockage",
  "Other",
];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const { session, error } = await requireAuth(event, ["public", "admin"]);
  if (error) return error;

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const issueType = (body.issueType || "").trim();
  const location = (body.location || "").trim();
  const description = (body.description || "").trim();
  const photo = body.photo || null; // base64 data URL

  if (!issueType || !ISSUE_TYPES.includes(issueType)) {
    return json(400, { error: "Please select a valid issue type." });
  }
  if (!location) {
    return json(400, { error: "Location is required." });
  }
  if (!description) {
    return json(400, { error: "Description is required." });
  }
  if (!photo) {
    return json(400, { error: "A before photo is required." });
  }

  const uStore = usersStore();
  const reporter = await uStore.get(`user:${session.email}`, { type: "json" });

  const id = randomUUID();
  const now = new Date().toISOString();

  const report = {
    id,
    issueType,
    location,
    description,
    beforePhoto: photo,
    afterPhoto: null,
    status: "Submitted",
    reviewStatus: "Pending Review",
    reportedBy: { id: session.userId, name: reporter?.name || session.email, email: session.email },
    assignedCrew: null,
    timeline: [{ status: "Submitted", at: now, by: session.email }],
    createdAt: now,
    updatedAt: now,
  };

  const store = reportsStore();
  await store.setJSON(`report:${id}`, report);

  return json(201, { report, message: "Report submitted successfully" });
};
