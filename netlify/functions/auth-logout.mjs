import { sessionsStore, getSessionToken, clearSessionCookieHeader, json, preflight } from "./_utils.mjs";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();

  const token = getSessionToken(event);
  if (token) {
    const store = sessionsStore();
    await store.delete(token);
  }
  return json(200, { ok: true }, { "Set-Cookie": clearSessionCookieHeader() });
};
