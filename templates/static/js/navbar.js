// navbar.js — renders the navbar's right-hand side. Shows "Login" for
// guests, or an avatar + name + role with a dropdown for signed-in users.
// This is what replaces the static "Login" link once a session exists.

function initNavbar() {
  const slot = document.getElementById("navAuthSlot");
  if (!slot) return;

  const user = CC.getUser();

  if (!user || !CC.isLoggedIn()) {
    slot.innerHTML = `<a href="login.html" class="btn btn-primary">Login</a>`;
    return;
  }

  const initial = (user.name || user.email || "?").trim().charAt(0).toUpperCase();
  const roleLabel = { public: "Public User", crew: "Crew Member", admin: "Admin" }[user.role] || user.role;

  slot.innerHTML = `
    <div class="profile-menu">
      <button class="profile-trigger" id="profileTrigger" type="button">
        <span class="status-dot"></span>
        <span class="avatar">${CC.escapeHtml(initial)}</span>
        <span class="profile-meta">
          <span class="p-name">${CC.escapeHtml(user.name || user.email)}</span>
          <span class="p-role">${CC.escapeHtml(roleLabel)}</span>
        </span>
      </button>
      <div class="dropdown glass" id="profileDropdown">
        ${dashboardLink(user.role)}
        <a href="reports.html">My Reports</a>
        ${user.role === "public" ? `<a href="eco-points.html">🌱 Eco Points</a>` : ""}
        <button class="dropdown-item" id="logoutBtn" type="button">Logout</button>
      </div>
    </div>
  `;

  const trigger = document.getElementById("profileTrigger");
  const dropdown = document.getElementById("profileDropdown");
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("open");
  });
  document.addEventListener("click", () => dropdown.classList.remove("open"));

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await CC.api("auth-logout", { method: "POST" });
    } catch {
      /* ignore network errors on logout */
    }
    CC.clearSession();
    window.location.href = "index.html";
  });
}

function dashboardLink(role) {
  if (role === "admin") return `<a href="admin.html">Admin Dashboard</a>`;
  if (role === "crew") return `<a href="crew.html">Crew Dashboard</a>`;
  return "";
}

// Guards a page so only certain roles can view it. Redirects otherwise.
function requireRole(allowedRoles) {
  const user = CC.getUser();
  if (!CC.isLoggedIn() || !user) {
    window.location.href = "login.html";
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    CC.redirectByRole(user.role);
    return null;
  }
  return user;
}

document.addEventListener("DOMContentLoaded", initNavbar);
window.requireRole = requireRole;
