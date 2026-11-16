import {
  ecoPointsStore,
  requireAuth,
  json,
  preflight,
  getLevelInfo,
  ECO_BADGES,
  ECO_LEVELS,
  ECO_REWARDS_CATALOG,
} from "./_utils.mjs";

// Eco Points are a public-user reward track (see _utils.mjs for the full
// design notes). Public users can only see their own record; admins may
// pass ?email= to look up any public user's progress.
export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return preflight();
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });

  const { session, error } = await requireAuth(event, ["public", "admin"]);
  if (error) return error;

  const params = event.queryStringParameters || {};
  let targetEmail = session.email;
  if (params.email && session.role === "admin") {
    targetEmail = params.email.trim().toLowerCase();
  }

  const store = ecoPointsStore();
  const record = (await store.get(`ecopoints:${targetEmail}`, { type: "json" })) || {
    email: targetEmail,
    totalPoints: 0,
    streak: { current: 0, longest: 0, lastWeekStart: null },
    badges: [],
    history: [],
  };

  const { level, next, pointsToNext, progressPercent } = getLevelInfo(record.totalPoints);

  const badges = record.badges.map((id) => ({ id, ...ECO_BADGES[id] })).filter((b) => b.name);

  return json(200, {
    email: record.email,
    totalPoints: record.totalPoints,
    level,
    nextLevel: next,
    pointsToNext,
    progressPercent,
    streak: record.streak,
    badges,
    history: record.history,
    allLevels: ECO_LEVELS,
    rewardsCatalog: ECO_REWARDS_CATALOG,
  });
};
