// @ts-nocheck
import { ConvexClient } from "convex/browser";
import { createAuthClient } from "better-auth/client";
import { convexClient as convexAuthPlugin, crossDomainClient } from "@convex-dev/better-auth/client/plugins";

let convexClient = null;
let authClient = null;
let authBaseUrl = "";
let currentUser = null;
let currentDevice = null;
let currentLocation = null;
let appConfig = null;
let deferredInstallPrompt = null;

function normalizeConvexBaseUrl(url) {
  if (typeof url !== "string") return "";
  return url.replace("/api/query", "").replace("/api/mutation", "").replace(/\/$/, "");
}

function getConvexAuthUrl() {
  const candidates = [window.CONVEX_SITE_URL, window.CONVEX_AUTH_URL, window.CONVEX_URL];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const normalized = normalizeConvexBaseUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function ensureAuthClient() {
  const baseUrl = getConvexAuthUrl();
  if (!baseUrl) return null;

  if (!authClient || authBaseUrl !== baseUrl) {
    authBaseUrl = baseUrl;
    authClient = createAuthClient({
      baseURL: baseUrl,
      plugins: [convexAuthPlugin(), crossDomainClient()],
    });
  }

  return authClient;
}

async function init() {
  if (window.CONVEX_URL) {
    convexClient = new ConvexClient(window.CONVEX_URL, {
      skipConvexDeploymentUrlCheck: true,
    });
    window.convexClient = convexClient;
  } else {
    showToast("Configuration error", "error");
    return;
  }

  if (!ensureAuthClient()) {
    showToast("Auth configuration error", "error");
    return;
  }

  registerServiceWorker();
  const hadOAuthCallback = await handleOAuthCallback();
  await checkAuthSession(hadOAuthCallback);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    await navigator.serviceWorker.register("/pwa/service-worker.js");
  } catch (error) {
    console.error("Service Worker registration failed:", error);
  }
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  const installPrompt = document.getElementById("install-prompt");
  if (installPrompt) installPrompt.style.display = "block";
});

window.installPWA = async function () {
  if (!deferredInstallPrompt) return;

  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;

  const installPrompt = document.getElementById("install-prompt");
  if (installPrompt) installPrompt.style.display = "none";
};

async function checkAuthSession(isAfterOAuthCallback = false) {
  showLoading("Checking session...");

  try {
    const auth = ensureAuthClient();
    if (!auth) {
      throw new Error("Auth client is not configured");
    }

    console.log("[Auth] Checking session, isAfterOAuthCallback:", isAfterOAuthCallback);
    let session = await auth.getSession();
    console.log("[Auth] Initial session check:", session);
    let user = session?.data?.user;

    if (!user?.email && isAfterOAuthCallback) {
      console.log("[Auth] No user after OAuth callback, retrying in 500ms...");
      await new Promise(resolve => setTimeout(resolve, 500));
      session = await auth.getSession();
      console.log("[Auth] Retry 1 session:", session);
      user = session?.data?.user;

      if (!user?.email) {
        console.log("[Auth] Still no user, retrying in 1000ms...");
        await new Promise(resolve => setTimeout(resolve, 1000));
        session = await auth.getSession();
        console.log("[Auth] Retry 2 session:", session);
        user = session?.data?.user;
      }

      if (!user?.email) {
        console.log("[Auth] Still no user, final retry in 1500ms...");
        await new Promise(resolve => setTimeout(resolve, 1500));
        session = await auth.getSession();
        console.log("[Auth] Retry 3 session:", session);
        user = session?.data?.user;
      }
    }

    if (user?.email) {
      console.log("[Auth] User authenticated:", user.email);
      window.history.replaceState({}, document.title, "/pwa/");
      await handleAuthenticatedUser(user);
    } else {
      console.log("[Auth] No authenticated user found, showing auth screen");
      window.history.replaceState({}, document.title, "/pwa/");
      showAuthScreen();
    }
  } catch (error) {
    console.error("[Auth] Session check error:", error);
    window.history.replaceState({}, document.title, "/pwa/");
    showAuthScreen();
  } finally {
    hideLoading();
  }
}

window.signInWithGoogle = async function () {
  showLoading("Signing in...");

  try {
    const auth = ensureAuthClient();
    if (!auth) {
      throw new Error("Auth client is not configured");
    }

    const callbackURL = `${window.location.origin}/pwa/`;
    console.log("[OAuth] Starting sign-in with callbackURL:", callbackURL);

    const result = await auth.signIn.social({
      provider: "google",
      callbackURL: callbackURL,
      fetchOptions: {
        onSuccess: async () => {
          console.log("[OAuth] Sign-in successful, session should be established");
        },
      },
    });

    if (result?.error) {
      const detail = result.error.message || result.error.statusText || JSON.stringify(result.error);
      throw new Error(detail || "Sign in failed");
    }

    if (result?.data?.url) {
      console.log("[OAuth] Redirecting to:", result.data.url);
      window.location.href = result.data.url;
      return;
    }

    throw new Error("No OAuth redirect URL returned");
  } catch (error) {
    console.error("Sign in error:", error);
    const message = error instanceof Error ? error.message : "Sign in failed";
    showToast(message, "error");
    hideLoading();
  }
};

async function handleOAuthCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const error = urlParams.get("error");
  const ott = urlParams.get("ott");

  console.log("[OAuth] Callback handler - search:", window.location.search, "hash:", window.location.hash);

  if (error) {
    console.error("[OAuth] Error in callback:", error);
    showToast(`Sign in failed: ${error}`, "error");
    showAuthScreen();
    window.history.replaceState({}, document.title, "/pwa/");
    return false;
  }

  if (ott) {
    console.log("[OAuth] One-time token detected:", ott);
    return true;
  }

  const hasOAuthParams = window.location.search || window.location.hash;
  if (hasOAuthParams) {
    console.log("[OAuth] OAuth parameters detected");
    return true;
  }

  console.log("[OAuth] No OAuth parameters found");
  return false;
}

async function handleAuthenticatedUser(user) {
  try {
    const device = await convexClient.query("devices:getDeviceByEmail", {
      email: user.email,
    });

    if (device) {
      currentUser = user;
      currentDevice = device;
      await showMainScreen();
    } else {
      showMismatchScreen(user.email);
    }
  } catch (error) {
    console.error("Device lookup error:", error);
    showToast("Error verifying account", "error");
    showAuthScreen();
  }
}

window.signOut = async function () {
  showLoading("Signing out...");

  try {
    const auth = ensureAuthClient();
    if (auth) {
      await auth.signOut();
    }

    currentUser = null;
    currentDevice = null;

    showAuthScreen();
    showToast("Signed out successfully", "success");
  } catch (error) {
    console.error("Sign out error:", error);
    showAuthScreen();
  } finally {
    hideLoading();
  }
};

function showAuthScreen() {
  const auth = document.getElementById("auth-screen");
  const mismatch = document.getElementById("mismatch-screen");
  const main = document.getElementById("main-screen");

  if (auth) auth.style.display = "flex";
  if (mismatch) mismatch.style.display = "none";
  if (main) main.style.display = "none";
  hideLoading();
}

function showMismatchScreen(email) {
  const auth = document.getElementById("auth-screen");
  const mismatch = document.getElementById("mismatch-screen");
  const main = document.getElementById("main-screen");
  const mismatchEmail = document.getElementById("mismatch-email");

  if (auth) auth.style.display = "none";
  if (mismatch) mismatch.style.display = "flex";
  if (main) main.style.display = "none";
  if (mismatchEmail) mismatchEmail.textContent = email;
  hideLoading();
}

async function showMainScreen() {
  const auth = document.getElementById("auth-screen");
  const mismatch = document.getElementById("mismatch-screen");
  const main = document.getElementById("main-screen");

  if (auth) auth.style.display = "none";
  if (mismatch) mismatch.style.display = "none";
  if (main) main.style.display = "flex";

  updateUserInfo();
  await fetchAppConfig();
  await requestLocation();
  updateStatus();
  await loadAttendanceLogs();
  hideLoading();
}

function updateUserInfo() {
  if (!currentUser) return;

  const name = currentUser.name || currentUser.email.split("@")[0];
  const initials = name.split(" ").map((part) => part[0]).join("").toUpperCase().slice(0, 2);

  const userName = document.getElementById("user-name");
  const userEmail = document.getElementById("user-email");
  const userInitials = document.getElementById("user-initials");

  if (userName) userName.textContent = name;
  if (userEmail) userEmail.textContent = currentUser.email;
  if (userInitials) userInitials.textContent = initials;
}

async function fetchAppConfig() {
  try {
    appConfig = await convexClient.query("devices:getAppLinkingConfig", {});
  } catch (error) {
    console.error("Failed to fetch app config:", error);
  }
}

async function requestLocation() {
  const locationStatus = document.getElementById("location-status");
  const locationText = document.getElementById("location-text");

  if (!navigator.geolocation) {
    if (locationStatus) locationStatus.className = "location-status error";
    if (locationText) locationText.textContent = "Location not supported";
    return;
  }

  if (locationStatus) locationStatus.className = "location-status";
  if (locationText) locationText.textContent = "Requesting location...";

  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      });
    });

    currentLocation = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
    };

    if (appConfig?.boundaryEnabled) {
      const inBoundary = isWithinBoundary(currentLocation);
      if (inBoundary) {
        if (locationStatus) locationStatus.className = "location-status success";
        if (locationText) locationText.textContent = "Location verified - within boundary";
      } else {
        if (locationStatus) locationStatus.className = "location-status warning";
        if (locationText) locationText.textContent = "Outside allowed boundary";
      }
    } else {
      if (locationStatus) locationStatus.className = "location-status success";
      if (locationText) locationText.textContent = "Location acquired";
    }
  } catch (error) {
    console.error("Location error:", error);
    currentLocation = null;

    if (error.code === 1) {
      if (locationStatus) locationStatus.className = "location-status error";
      if (locationText) locationText.textContent = "Location permission denied";
    } else {
      if (locationStatus) locationStatus.className = "location-status warning";
      if (locationText) locationText.textContent = "Could not get location";
    }
  }
}

function isWithinBoundary(location) {
  if (!appConfig?.boundaryEnabled) return true;
  if (!location) return false;

  const boundaryLat = appConfig.boundaryLatitude;
  const boundaryLng = appConfig.boundaryLongitude;
  let boundaryRadius = appConfig.boundaryRadius || 100;

  if (appConfig.boundaryRadiusUnit === "miles") {
    boundaryRadius *= 1609.344;
  }

  const R = 6371000;
  const lat1 = location.latitude * Math.PI / 180;
  const lat2 = boundaryLat * Math.PI / 180;
  const deltaLat = (boundaryLat - location.latitude) * Math.PI / 180;
  const deltaLng = (boundaryLng - location.longitude) * Math.PI / 180;

  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2)
      + Math.cos(lat1) * Math.cos(lat2)
      * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance <= boundaryRadius;
}

function updateStatus() {
  if (!currentDevice) return;

  const statusValue = document.getElementById("status-value");
  const clockBtn = document.getElementById("clock-btn");
  const clockBtnText = document.getElementById("clock-btn-text");
  const actionHint = document.getElementById("action-hint");

  const isCheckedIn = currentDevice.appStatus === "present";

  if (isCheckedIn) {
    if (statusValue) {
      statusValue.textContent = "Checked In";
      statusValue.className = "status-value checked-in";
    }
    if (clockBtn) clockBtn.className = "clock-btn check-out";
    if (clockBtnText) clockBtnText.textContent = "Check Out";
    if (actionHint) actionHint.textContent = "Tap to check out";
  } else {
    if (statusValue) {
      statusValue.textContent = "Checked Out";
      statusValue.className = "status-value checked-out";
    }
    if (clockBtn) clockBtn.className = "clock-btn check-in";
    if (clockBtnText) clockBtnText.textContent = "Check In";
    if (actionHint) actionHint.textContent = "Tap to check in";
  }

  const canClock = !appConfig?.boundaryEnabled || (currentLocation && isWithinBoundary(currentLocation));
  if (clockBtn) clockBtn.disabled = !canClock;

  if (!canClock && appConfig?.boundaryEnabled && actionHint) {
    actionHint.textContent = "You must be within the allowed boundary to clock in/out";
  }
}

window.toggleClockStatus = async function () {
  if (!currentDevice || !currentUser) return;

  const clockBtn = document.getElementById("clock-btn");
  if (clockBtn) clockBtn.disabled = true;

  showLoading("Processing...");

  try {
    await requestLocation();

    const config = await convexClient.query("devices:getAppLinkingConfig", {});
    if (!config?.apiKey) {
      throw new Error("API key not configured");
    }

    const result = await convexClient.mutation("devices:flipAppStatusByEmail", {
      apiKey: config.apiKey,
      email: currentUser.email,
      latitude: currentLocation?.latitude,
      longitude: currentLocation?.longitude,
    });

    if (result.success) {
      currentDevice = {
        ...currentDevice,
        appStatus: result.appStatus,
      };

      updateStatus();

      const action = result.appStatus === "present" ? "Checked in" : "Checked out";
      showToast(`${action} successfully`, "success");
      await loadAttendanceLogs();
    } else {
      throw new Error(result.error || "Failed to update status");
    }
  } catch (error) {
    console.error("Clock toggle error:", error);
    showToast(error.message || "Failed to update status", "error");
  } finally {
    hideLoading();
    updateStatus();
  }
};

async function loadAttendanceLogs() {
  const logsList = document.getElementById("logs-list");
  if (!logsList) return;

  if (!currentDevice) {
    logsList.innerHTML = '<div class="logs-empty">No device found</div>';
    return;
  }

  try {
    const history = await convexClient.query("devices:getAttendanceHistoryByDeviceId", {
      deviceId: currentDevice._id,
      limit: 20,
    });

    if (!history || history.length === 0) {
      logsList.innerHTML = '<div class="logs-empty">No activity yet</div>';
      return;
    }

    logsList.innerHTML = history.map((log) => {
      const isCheckIn = log.status === "present";
      const iconClass = isCheckIn ? "check-in" : "check-out";
      const actionText = isCheckIn ? "Checked In" : "Checked Out";

      let sourceLabel = "";
      let sourceClass = "";
      if (log.source === "app+bluetooth") {
        sourceLabel = "Via App, verified with Bluetooth";
        sourceClass = "verified";
      } else if (log.source === "app") {
        sourceLabel = "Via App";
      } else if (log.source === "bluetooth") {
        sourceLabel = "Via Bluetooth";
        sourceClass = "verified";
      } else {
        sourceLabel = log.label || "Unknown source";
      }

      const time = formatTime(log.timestamp);

      return `
        <div class="log-item">
          <div class="log-icon ${iconClass}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              ${isCheckIn
                ? '<polyline points="20 6 9 17 4 12"/>'
                : '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'}
            </svg>
          </div>
          <div class="log-content">
            <div class="log-action">${actionText}</div>
            <div class="log-source ${sourceClass}">${sourceLabel}</div>
            <div class="log-time">${time}</div>
          </div>
        </div>
      `;
    }).join("");
  } catch (error) {
    console.error("Failed to load logs:", error);
    logsList.innerHTML = '<div class="logs-empty">Failed to load activity</div>';
  }
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (isToday) {
    return `Today at ${timeStr}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday at ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  return `${dateStr} at ${timeStr}`;
}

function showLoading(text = "Loading...") {
  const loadingText = document.getElementById("loading-text");
  const loadingOverlay = document.getElementById("loading-overlay");

  if (loadingText) loadingText.textContent = text;
  if (loadingOverlay) loadingOverlay.style.display = "flex";
}

function hideLoading() {
  const loadingOverlay = document.getElementById("loading-overlay");
  if (loadingOverlay) loadingOverlay.style.display = "none";
}

function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.className = `toast ${type} show`;

  setTimeout(() => {
    toast.className = "toast";
  }, 3000);
}

document.addEventListener("DOMContentLoaded", async () => {
  await init();
});
