// api.js — thin wrapper around fetch() for talking to Netlify Functions,
// plus session helpers shared by every page.
//
// Auth itself is an HttpOnly cookie (set by auth-login/auth-register) that
// the browser attaches automatically to same-origin requests -- it's never
// readable by this (or any) client-side script, so it can't be lifted via
// DevTools -> Application -> Storage or by an XSS bug in the page.
//
// USER_KEY only caches non-sensitive display info (name/email/role) so the
// navbar can render instantly without waiting on a network round trip.
// It's a UI convenience, not a credential -- real access control always
// happens server-side against the cookie.
const USER_KEY = "cc_user";

const CC = {
  getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  },
  setSession(user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clearSession() {
    localStorage.removeItem(USER_KEY);
  },
  isLoggedIn() {
    return !!CC.getUser();
  },

  async api(path, { method = "GET", body } = {}) {
    const res = await fetch(`/api/${path}`, {
      method,
      credentials: "same-origin", // send the HttpOnly session cookie
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    if (res.status === 401) {
      // Session cookie missing/expired server-side -- drop the cached
      // display info so the navbar doesn't keep showing a stale login.
      CC.clearSession();
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  // Reads a <input type=file> into a base64 data URL for photo uploads.
  fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read the selected file."));
      reader.readAsDataURL(file);
    });
  },

  escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  },

  timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  },

  redirectByRole(role) {
    if (role === "admin") window.location.href = "admin.html";
    else if (role === "crew") window.location.href = "crew.html";
    else window.location.href = "reports.html";
  },
};

window.CC = CC;
