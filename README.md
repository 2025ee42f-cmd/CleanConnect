# CleanConnect v3

A community cleanliness reporting platform. Citizens report issues with a
photo, crew members work through them, and every "Verified" resolution is
backed by community feedback and after-cleaning photo evidence.

## Tech stack

- **Frontend:** plain HTML / CSS / vanilla JavaScript (`templates/`)
- **Backend:** Netlify Functions, ESM (`netlify/functions/*.mjs`)
- **Storage:** Netlify Blobs (users, sessions, reports, feedback)
- **Deployment:** Netlify

## Getting started

```bash
npm install
npx netlify dev
```

This starts the site (with functions and Blobs emulated locally) at
`http://localhost:8888`.

Open `http://localhost:8888/register.html` to create a public account, or
log in as the seeded admin (see below).

## Roles

| Role | How the account is created |
|---|---|
| **Public User** | Self-registers at `/register.html` |
| **Crew Member** | Created after an admin approves a recruitment application, or directly by an admin (`/admin.html`) |
| **Admin** | Auto-seeded on first function call from environment variables |

## Admin account & environment variables

The admin account is seeded automatically the first time any auth function
runs, using these environment variables:

```
ADMIN_EMAIL=your-admin-email@example.com
ADMIN_PASSWORD=replace-with-a-secure-password
ADMIN_NAME=CleanConnect Admin
```

`ADMIN_EMAIL` and `ADMIN_PASSWORD` **must** be set (in Netlify's Environment
Variables settings, or in a local `.env`) — the app will refuse to seed an
admin account until both are configured, so no default credentials ever
ship in the code. `ADMIN_NAME` is optional and defaults to
"CleanConnect Admin".

**Before deploying anywhere public, set your own `ADMIN_EMAIL` /
`ADMIN_PASSWORD` / `ADMIN_NAME` in the Netlify site's Environment Variables
settings, and change the password immediately after first login.** Never
commit real production credentials into source control — a `.env.example`
is provided as a template; copy it to `.env` for local overrides (the
`.env` file is git-ignored). Also set `ALLOWED_ORIGIN` to your real
deployed URL so the API only accepts requests from your own site instead
of any website.

No API keys or secrets are ever sent to the browser — every privileged
check happens inside the Netlify Functions, reading `process.env` on the
server side only.

## Report workflow

```
Submitted → In Progress → Resolved → Verified
```

Transitions only move forward one step at a time (enforced server-side in
`_utils.mjs`'s `canTransition`). A report cannot skip a step or move
backward.

1. **Submitted** — a public user files a report with a before photo.
2. **In Progress** — a crew member (assigned by admin, or self-picked from
   the unassigned queue) starts work.
3. **Resolved** — the crew member uploads an after-cleaning photo.
4. Community feedback — the original reporter confirms Yes/No, with a
   rating and comment. A "Yes" requires (or reconfirms) an after-cleaning
   photo.
5. **Verified** — an admin runs the rule-based "AI-assisted" pre-check
   (`verify-report` with `action: "review"`), which only checks that
   status = Resolved, feedback = Yes, and an after photo exists. It never
   verifies on its own — an admin must explicitly confirm
   (`action: "confirm"`) before the status becomes Verified.

## Sessions & authentication

Login/registration set the session as an **HttpOnly cookie** (`cc_session`),
not as a token handed to client-side JavaScript. The browser attaches it
automatically to same-origin requests; no page ever reads or stores it, so
it can't be lifted via DevTools → Application → Storage or by an XSS bug
in the page. `localStorage` only ever holds non-sensitive display info
(name/email/role) so the navbar can render instantly — real access control
always happens server-side against the cookie via `requireAuth()`.

Cookie flags: `HttpOnly; SameSite=Lax; Max-Age=7 days`, plus `Secure` on
every real deploy (omitted only under `netlify dev`'s local http server).
`Authorization: Bearer <token>` is still accepted as a fallback for
non-browser callers (curl, Postman, server-to-server) — the shipped
frontend never sends one.

## Netlify Functions

All under `netlify/functions/`:

- `auth-register.mjs`, `auth-login.mjs`, `auth-logout.mjs`, `auth-me.mjs`
- `add-crew.mjs`, `get-users.mjs`, `remove-crew.mjs` (admin only)
- `submit-crew-application.mjs` (public recruitment submission)
- `get-crew-applications.mjs`, `review-crew-application.mjs` (admin recruitment review)
- `create-report.mjs`, `get-reports.mjs`, `update-report.mjs`
- `submit-feedback.mjs`, `get-feedback.mjs`
- `upload-after-photo.mjs`
- `verify-report.mjs`
- `_utils.mjs` — shared Blobs/session/hashing helpers (not an HTTP endpoint)

All routes are also reachable under `/api/*` via the redirect in
`netlify.toml`.

## Project structure

```
CleanConnect/
├── templates/              (published as the site root)
│   ├── index.html
│   ├── login.html
│   ├── register.html
│   ├── report.html
│   ├── reports.html
│   ├── crew.html
│   ├── admin.html
│   └── static/
│       ├── css/style.css
│       └── js/ (api.js, navbar.js, reports-ui.js)
├── netlify/
│   └── functions/
├── netlify.toml
├── package.json
├── .env.example
└── README.md
```

## Eco Points (public reward system)

Public users earn **Eco Points** for real, verified cleanup activity — not
for filing reports. This is deliberately designed to reward genuine civic
participation rather than turn the site into a coupon-farming machine:

- Points are only awarded when a report reaches **Verified** status (an
  admin has confirmed it, backed by community feedback and an after-photo).
  Submitting reports alone earns nothing.
- A **daily cap** (2 counted verifications/day) stops mass-filing from
  gaming the system.
- A **fast-resolution bonus** rewards reports verified within 7 days of
  being submitted.
- A **weekly streak bonus** rewards sustained participation across
  consecutive weeks, not one-off bursts.
- **Levels** (Seedling → Sprout → Sapling → Guardian → Eco Champion) and
  **badges** (First Cleanup, Century Club, Streak Keeper, Eco Champion)
  give ongoing recognition.
- The **rewards catalog** mixes recognition (certificates, profile frames,
  a tree planted in your name, a community shoutout) with partner
  coupons — all currently marked **"Coming soon"** while partner
  integrations are finalized, so the launch leads with genuine engagement
  rather than a storefront.

Implementation:
- `netlify/functions/_utils.mjs` — `awardEcoPointsForVerifiedReport()`,
  level/badge/rewards definitions, and the streak/daily-cap logic.
- `netlify/functions/verify-report.mjs` — calls the award function when
  an admin confirms a report as Verified.
- `netlify/functions/get-eco-points.mjs` — returns a user's points,
  level, streak, badges, recent history and the rewards catalog. Public
  users see their own record; admins may pass `?email=` to check anyone's.
- `templates/eco-points.html` — the public-facing dashboard, linked from
  the profile menu for public users.

## Manual testing checklist

- [ ] Public registration/login
- [ ] After login, DevTools → Application → Cookies shows `cc_session` as HttpOnly (and Local Storage has no token)
- [ ] Admin login (seeded credentials)
- [ ] Crew login (created via Admin Dashboard)
- [ ] Report submission with photo + validation
- [ ] Reports list loads and filters by status
- [ ] Crew starts work (Submitted → In Progress)
- [ ] Crew resolves work with after photo (In Progress → Resolved)
- [ ] Citizen submits feedback + after-photo confirmation
- [ ] Admin runs verification and confirms (Resolved → Verified)
- [ ] Public reporter's Eco Points increase only after that Verified confirmation, visible on `/eco-points.html`
- [ ] Navbar shows avatar/name/role instead of "Login" once signed in
- [ ] `npx netlify dev` starts cleanly with no errors


## Crew recruitment workflow

Visitors can open `/recruit.html` from the **Join the Crew** tab and submit:
- Full name
- Email and password
- Age (must be 18+)
- Birthplace / hometown / other information (optional)
- Education: Semi-schooled, 10th, or 12th
- A description about themselves

Passwords are hashed before the application is stored. Pending applications do not expose the password hash to the browser.

The Admin Dashboard polls for new applications and displays a notification when one or more applications are pending. Admins can **Approve & Create Crew Account** or **Reject** an application. Approval creates a normal `crew` login using the applicant's submitted email/password and stores their recruitment details with the crew profile.

Admins can also remove existing crew accounts from the Users & Crew Management section. Removal is protected server-side and cannot be performed by a non-admin.


### Admin user management
Admins can remove individual public-member or crew login accounts from the Admin Dashboard. Public and crew login/registration remain enabled; removal is an explicit admin action and does not disable those roles globally.

## Admin report maintenance
- **Clear Verified Reports** permanently removes reports whose final verification status is `Verified`.
- **Clear Submitted Test Reports** permanently removes only reports still in `Submitted` status, intended for clearing initial test submissions. It does not affect In Progress, Resolved, or Verified reports.
- Public member removal is no longer offered in the Admin Dashboard. Crew removal remains available through the Crew Members section.


## Report cleanup behavior
- The one-time Submitted test cleanup endpoint/UI has been removed.
- Admin rejection during final verification permanently clears the Resolved report and its feedback.
- Admin confirmation moves the report to Verified as before.
