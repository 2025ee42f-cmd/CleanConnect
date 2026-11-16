import { usersStore, requireAuth, json, preflight, safeUser } from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();

  const { error } = await requireAuth(event, ["admin"]);
  if (error) return error;

  const store = usersStore();
  const { blobs } = await store.list({ prefix: "user:" });

  const users = [];
  for (const b of blobs) {
    const u = await store.get(b.key, { type: "json" });
    if (u) {
      const clean = safeUser(u);
      const primaryEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
      users.push({ ...clean, isPrimary: Boolean(primaryEmail && clean?.email?.toLowerCase() === primaryEmail) });
    }
  }
  users.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return json(200, { users });
};
