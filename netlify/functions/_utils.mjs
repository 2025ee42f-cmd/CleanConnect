// _utils.mjs
// Shared helpers used by every Netlify Function in CleanConnect.
// Handles Blobs storage access, password hashing, session tokens,
// authentication/authorization checks and consistent JSON responses.

import { getStore } from "@netlify/blobs";
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";

// ---------- Blobs stores ----------
// Netlify normally auto-injects the Blobs context (site ID + token) into
// every function invocation. If that injection fails for any reason --
// legacy function bundler, manual/drag-and-drop deploys, transient
// platform issues, etc -- getStore() throws MissingBlobsEnvironmentError,
// which surfaces to users as "Server storage is not configured correctly."
//
// As a resilient fallback, if BLOBS_SITE_ID and BLOBS_TOKEN are set as
// environment variables, we pass them explicitly so the store works
// regardless of auto-injection. Get these from:
//   - Site ID: Site settings -> General -> Site details -> Site ID
//   - Token:   User settings -> Applications -> Personal access tokens -> New
function storeConfig(name) {
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) {
    return { name, siteID, token };
  }
  return name;
}

export function usersStore() {
  return getStore(storeConfig("cleanconnect-users"));
}
export function reportsStore() {
  return getStore(storeConfig("cleanconnect-reports"));
}
export function feedbackStore() {
  return getStore(storeConfig("cleanconnect-feedback"));
}
export function sessionsStore() {
  return getStore(storeConfig("cleanconnect-sessions"));
}
export function ecoPointsStore() {
  return getStore(storeConfig("cleanconnect-ecopoints"));
}

// ---------- JSON responses ----------
// ALLOWED_ORIGIN lets you lock the API to your real deployed domain
// (e.g. https://your-site.netlify.app) instead of accepting requests
// initiated from any website. Falls back to "*" only when unset, so
// local dev keeps working out of the box.
const BASE_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

export function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

export function preflight() {
  return { statusCode: 204, headers: BASE_HEADERS, body: "" };
}

// ---------- Password hashing (scrypt, no third-party deps needed) ----------
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const hashBuffer = Buffer.from(hash, "hex");
  const testBuffer = scryptSync(password, salt, 64);
  if (hashBuffer.length !== testBuffer.length) return false;
  return timingSafeEqual(hashBuffer, testBuffer);
}

// ---------- Sessions ----------
// Sessions are handed to the browser as an HttpOnly cookie rather than a
// token in the JSON response body. An HttpOnly cookie can't be read by
// any client-side JavaScript -- including the app's own code -- so it
// never sits in localStorage/sessionStorage where it would be visible
// (and stealable) via DevTools -> Application, or by any XSS in the page.
// The browser attaches it automatically on same-origin requests; nothing
// on the client needs to manage it.
const SESSION_COOKIE_NAME = "cc_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

// `netlify dev` runs the site over plain http, where a `Secure` cookie
// would silently be refused by the browser -- so it's only added outside
// local dev. Every real deployment (Netlify) serves over https.
function isLocalDev() {
  return process.env.NETLIFY_DEV === "true";
}

export function sessionCookieHeader(token) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (!isLocalDev()) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader() {
  const parts = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (!isLocalDev()) parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(event) {
  const header = event.headers?.cookie || event.headers?.Cookie || "";
  const out = {};
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

// Reads the session token from the cookie first. Falls back to an
// `Authorization: Bearer` header only for non-browser callers (curl,
// Postman, server-to-server); the shipped frontend never sends one.
export function getSessionToken(event) {
  const cookies = parseCookies(event);
  if (cookies[SESSION_COOKIE_NAME]) return cookies[SESSION_COOKIE_NAME];
  const auth = event.headers?.authorization || event.headers?.Authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

export async function createSession(user) {
  const token = randomUUID() + randomUUID();
  const store = sessionsStore();
  await store.setJSON(token, {
    userId: user.id,
    email: user.email,
    role: user.role,
    createdAt: new Date().toISOString(),
  });
  return token;
}

export async function getSession(event) {
  const token = getSessionToken(event);
  if (!token) return null;
  const store = sessionsStore();
  const session = await store.get(token, { type: "json" });
  return session || null;
}

export async function requireAuth(event, allowedRoles = null) {
  const session = await getSession(event);
  if (!session) {
    return { error: json(401, { error: "Not authenticated. Please log in." }) };
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    return { error: json(403, { error: "You do not have permission to do that." }) };
  }
  return { session };
}

// ---------- Admin bootstrap ----------
// Seeds a single admin account on first use. Credentials are read from
// environment variables so nothing sensitive is hardcoded in the deployed
// bundle. Fallback values match the project handover spec for local/dev
// use only -- ALWAYS set real env vars before deploying publicly.
export async function ensureAdminSeeded() {
  const store = usersStore();
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be configured.");
  }

  const existing = await store.get(`user:${email}`, { type: "json" });
  if (existing) return existing;

  const name = process.env.ADMIN_NAME || "CleanConnect Admin";

  const admin = {
    id: randomUUID(),
    name,
    email,
    role: "admin",
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  await store.setJSON(`user:${email}`, admin);
  return admin;
}

// ---------- Report status machine ----------
export const STATUS_ORDER = ["Submitted", "In Progress", "Resolved", "Verified"];

export function canTransition(from, to) {
  const fromIdx = STATUS_ORDER.indexOf(from);
  const toIdx = STATUS_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  // Only allow moving exactly one step forward. No skipping, no reverse.
  return toIdx === fromIdx + 1;
}

export function safeUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

// =====================================================================
// Eco Points -- a reward system for public reporters.
//
// Design goals (deliberately not just "report a lot, get coupons"):
//   - Points are only ever earned when a report reaches Verified status,
//     i.e. an admin has confirmed real, community-backed cleanup. Nothing
//     is earned just for submitting or filing volume.
//   - A daily cap on how many verified reports count toward points stops
//     anyone from gaming the system with a burst of low-effort reports.
//   - A weekly streak bonus rewards sustained civic participation over
//     time, not one-off activity.
//   - Rewards are a mix of recognition (badges, levels) and coupons --
//     the coupons are intentionally listed as "Coming soon" for now, so
//     the feature launches as a genuine engagement/recognition system
//     first, not a storefront.
// =====================================================================

const ECO_BASE_POINTS = 15;
const ECO_FAST_RESOLUTION_BONUS = 5;
const ECO_FAST_RESOLUTION_DAYS = 7;
const ECO_STREAK_BONUS = 5;
const ECO_MAX_COUNTED_PER_DAY = 2;

export const ECO_LEVELS = [
  { id: "seedling", name: "Seedling", icon: "🌱", min: 0 },
  { id: "sprout", name: "Sprout", icon: "🌿", min: 50 },
  { id: "sapling", name: "Sapling", icon: "🌳", min: 150 },
  { id: "guardian", name: "Guardian", icon: "🛡️", min: 350 },
  { id: "champion", name: "Eco Champion", icon: "🏆", min: 700 },
];

export const ECO_BADGES = {
  first_verified: { name: "First Cleanup", icon: "🌱", desc: "Got your first report Verified." },
  century_club: { name: "Century Club", icon: "💯", desc: "Earned 100+ eco points." },
  streak_keeper: { name: "Streak Keeper", icon: "🔥", desc: "4 consecutive weeks with a Verified report." },
  eco_champion: { name: "Eco Champion", icon: "🏆", desc: "Earned 700+ eco points." },
};

// All entries are marked comingSoon -- nothing is redeemable yet. This
// keeps the launch focused on recognizing real cleanup activity rather
// than turning the platform into a coupon storefront.
export const ECO_REWARDS_CATALOG = [
  { id: "bronze_certificate", pointsRequired: 50, icon: "📜", name: "Digital Cleanup Certificate", comingSoon: true },
  { id: "badge_frame", pointsRequired: 150, icon: "🖼️", name: "Eco Warrior Profile Frame", comingSoon: true },
  { id: "partner_coupon", pointsRequired: 250, icon: "🏷️", name: "Partner Store Discount Coupon", comingSoon: true },
  { id: "tree_planted", pointsRequired: 400, icon: "🌳", name: "A Tree Planted In Your Name", comingSoon: true },
  { id: "community_hero", pointsRequired: 600, icon: "🌟", name: "Featured Community Hero Shoutout", comingSoon: true },
];

export function getLevelInfo(totalPoints) {
  let current = ECO_LEVELS[0];
  let next = null;
  for (let i = 0; i < ECO_LEVELS.length; i++) {
    if (totalPoints >= ECO_LEVELS[i].min) current = ECO_LEVELS[i];
    else { next = ECO_LEVELS[i]; break; }
  }
  const progress = next
    ? Math.round(((totalPoints - current.min) / (next.min - current.min)) * 100)
    : 100;
  return {
    level: current,
    next,
    pointsToNext: next ? next.min - totalPoints : 0,
    progressPercent: Math.max(0, Math.min(100, progress)),
  };
}

function todayUTC(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function weekStartUTC(date) {
  const day = date.getUTCDay() || 7; // Mon=1 ... Sun=7
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (day - 1));
  return start;
}

function defaultEcoRecord(email) {
  return {
    email,
    totalPoints: 0,
    streak: { current: 0, longest: 0, lastWeekStart: null },
    dailyCounter: { date: null, counted: 0 },
    badges: [],
    history: [],
  };
}

// Called once a report is confirmed Verified. Only public reporters earn
// eco points (crew/admin activity isn't part of this reward track).
// Returns the award summary, or null if the reporter isn't a public user.
export async function awardEcoPointsForVerifiedReport(report) {
  const email = report?.reportedBy?.email;
  if (!email) return null;

  const uStore = usersStore();
  const reporter = await uStore.get(`user:${email}`, { type: "json" });
  if (!reporter || reporter.role !== "public") return null;

  const store = ecoPointsStore();
  const key = `ecopoints:${email}`;
  const record = (await store.get(key, { type: "json" })) || defaultEcoRecord(email);

  const now = new Date();
  const today = todayUTC(now);
  if (record.dailyCounter.date !== today) {
    record.dailyCounter = { date: today, counted: 0 };
  }

  const dailyCapReached = record.dailyCounter.counted >= ECO_MAX_COUNTED_PER_DAY;

  let pointsAwarded = 0;
  const reasons = [];

  if (!dailyCapReached) {
    pointsAwarded += ECO_BASE_POINTS;
    reasons.push(`+${ECO_BASE_POINTS} report verified`);

    const submittedAt = report.createdAt ? new Date(report.createdAt) : null;
    if (submittedAt) {
      const daysToVerify = (now - submittedAt) / (1000 * 60 * 60 * 24);
      if (daysToVerify <= ECO_FAST_RESOLUTION_DAYS) {
        pointsAwarded += ECO_FAST_RESOLUTION_BONUS;
        reasons.push(`+${ECO_FAST_RESOLUTION_BONUS} fast resolution (verified within ${ECO_FAST_RESOLUTION_DAYS} days)`);
      }
    }

    record.dailyCounter.counted += 1;

    // Weekly streak
    const currentWeekStart = weekStartUTC(now);
    const lastWeekStart = record.streak.lastWeekStart ? new Date(record.streak.lastWeekStart) : null;
    const diffDays = lastWeekStart ? Math.round((currentWeekStart - lastWeekStart) / (1000 * 60 * 60 * 24)) : null;

    if (diffDays === 0) {
      // Same week as last verified report -- streak unchanged, no extra bonus.
    } else if (diffDays === 7) {
      record.streak.current += 1;
      if (record.streak.current >= 2) {
        pointsAwarded += ECO_STREAK_BONUS;
        reasons.push(`+${ECO_STREAK_BONUS} ${record.streak.current}-week streak bonus`);
      }
    } else {
      record.streak.current = 1;
    }
    record.streak.longest = Math.max(record.streak.longest, record.streak.current);
    record.streak.lastWeekStart = currentWeekStart.toISOString();
  } else {
    reasons.push("Daily eco-point limit reached -- report verified, but no points from this one today.");
  }

  record.totalPoints += pointsAwarded;

  // Badges (awarded once, based on state after this event)
  const newBadges = [];
  const hasVerifiedBefore = record.history.some((h) => h.points > 0);
  if (!hasVerifiedBefore && pointsAwarded > 0 && !record.badges.includes("first_verified")) {
    record.badges.push("first_verified");
    newBadges.push("first_verified");
  }
  if (record.totalPoints >= 100 && !record.badges.includes("century_club")) {
    record.badges.push("century_club");
    newBadges.push("century_club");
  }
  if (record.streak.current >= 4 && !record.badges.includes("streak_keeper")) {
    record.badges.push("streak_keeper");
    newBadges.push("streak_keeper");
  }
  if (record.totalPoints >= 700 && !record.badges.includes("eco_champion")) {
    record.badges.push("eco_champion");
    newBadges.push("eco_champion");
  }

  record.history.unshift({
    reportId: report.id,
    points: pointsAwarded,
    reasons,
    at: now.toISOString(),
  });
  record.history = record.history.slice(0, 30);

  await store.setJSON(key, record);

  return { pointsAwarded, reasons, newBadges, totalPoints: record.totalPoints };
}
