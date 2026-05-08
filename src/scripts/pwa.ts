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
let canManageBoundary = false;
let deferredInstallPrompt = null;
let logEntries = [];
let logsPage = 1;
let logsTotalPages = 1;
let logsCollapsed = true;

const ACTIVITY_TIMEZONE = "America/Los_Angeles";
const ACTIVITY_FETCH_LIMIT = 100;
const ACTIVITY_DAYS_PER_PAGE = 6;
const BURST_MERGE_MS = 2 * 60 * 1000;
const BLUETOOTH_ALTERNATION_WINDOW_MS = 5 * 60 * 1000;
const PWA_ROOT_PATH = new URL("./", window.location.href).pathname;

function toPwaPath(relativePath: string) {
  return `${PWA_ROOT_PATH}${relativePath.replace(/^\/+/, "")}`;
}

async function verifyOneTimeToken(ott) {
  const auth = ensureAuthClient();
  if (!auth) {
    console.error("[OAuth] Auth client unavailable while verifying OTT");
    return false;
  }

  try {
    console.log("[OAuth] Verifying one-time token", ott);
    const result = await auth.crossDomain?.oneTimeToken?.verify({ token: ott });
    const sessionToken = result?.data?.session?.token;

    if (!sessionToken) {
      console.warn("[OAuth] OTT verification succeeded but no session token returned");
      return false;
    }

    await auth.getSession({
      fetchOptions: {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      },
    });

    auth.updateSession?.();
    console.log("[OAuth] Session refreshed after OTT verification");
    return true;
  } catch (error) {
    console.error("[OAuth] Failed to verify one-time token", error);
    showToast("Sign in failed. Please try again.", "error");
    return false;
  }
}

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
    await navigator.serviceWorker.register(toPwaPath("service-worker.js"));
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
      window.history.replaceState({}, document.title, PWA_ROOT_PATH);
      await handleAuthenticatedUser(user);
    } else {
      console.log("[Auth] No authenticated user found, showing auth screen");
      window.history.replaceState({}, document.title, PWA_ROOT_PATH);
      showAuthScreen();
    }
  } catch (error) {
    console.error("[Auth] Session check error:", error);
    window.history.replaceState({}, document.title, PWA_ROOT_PATH);
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

    const callbackURL = new URL(PWA_ROOT_PATH, window.location.origin).toString();
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
  const currentUrl = new URL(window.location.href);
  const urlParams = currentUrl.searchParams;
  const error = urlParams.get("error");
  const ott = urlParams.get("ott");

  console.log("[OAuth] Callback handler - search:", window.location.search, "hash:", window.location.hash);

  if (error) {
    console.error("[OAuth] Error in callback:", error);
    showToast(`Sign in failed: ${error}`, "error");
    showAuthScreen();
    window.history.replaceState({}, document.title, PWA_ROOT_PATH);
    return false;
  }

  if (ott) {
    console.log("[OAuth] One-time token detected:", ott);
    const verified = await verifyOneTimeToken(ott);
    urlParams.delete("ott");
    window.history.replaceState({}, document.title, `${currentUrl.pathname}${urlParams.toString() ? `?${urlParams.toString()}` : ""}`);
    return verified;
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
    canManageBoundary = false;

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
  await refreshBoundaryControlAccess();
  renderBoundaryAdminSection();
  await refreshAppStatus();
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

async function refreshBoundaryControlAccess() {
  canManageBoundary = false;

  try {
    const access = await convexClient.query("devices:getBoundaryControlAccess", {
      email: currentUser?.email,
    });
    canManageBoundary = access?.canManageBoundary === true;
  } catch (error) {
    console.error("Failed to load boundary access:", error);
  }
}

function deviceIsManualDriver(device) {
  if (!device) return false;
  return device.attendanceDriver === "manual"
    || (device.attendanceDriver !== "bluetooth" && typeof device.latestAppIntentAt === "number");
}

function updateBoundaryAdminLabelState() {
  const toggle = document.getElementById("boundary-admin-enabled") as HTMLInputElement | null;
  const state = document.getElementById("boundary-admin-state");
  const label = document.getElementById("boundary-admin-toggle-label");

  if (!toggle) return;
  const isEnabled = toggle.checked;

  if (state) {
    state.textContent = isEnabled ? "Enabled" : "Disabled";
    state.className = `boundary-admin-state ${isEnabled ? "enabled" : "disabled"}`;
  }

  if (label) {
    label.textContent = isEnabled ? "Boundary enabled" : "Boundary disabled";
  }
}

function renderBoundaryAdminSection() {
  const section = document.getElementById("boundary-admin-section");
  const toggle = document.getElementById("boundary-admin-enabled") as HTMLInputElement | null;

  if (!section || !toggle) return;

  if (!canManageBoundary) {
    section.classList.add("pwa-hidden");
    return;
  }

  section.classList.remove("pwa-hidden");
  toggle.checked = appConfig?.boundaryEnabled === true;
  updateBoundaryAdminLabelState();
}

async function refreshAppStatus() {
  if (!currentUser) return;

  if (!appConfig?.apiKey) {
    await fetchAppConfig();
  }

  if (!appConfig?.apiKey) {
    console.warn("[Status] Missing API key, skipping status refresh");
    return;
  }

  try {
    const status = await convexClient.query("devices:fetchAppStatusByEmail", {
      apiKey: appConfig.apiKey,
      email: currentUser.email,
    });

    if (status?.success) {
      if (currentDevice) {
        currentDevice = {
          ...currentDevice,
          appStatus: status.appStatus,
          attendanceStatus: status.attendanceStatus,
          attendanceChangedAt: status.attendanceChangedAt,
          attendanceOrigin: status.attendanceOrigin,
          attendanceVerificationStatus: status.attendanceVerificationStatus,
          attendanceVerifiedBy: status.attendanceVerifiedBy,
          latestAppIntent: status.latestAppIntent,
          latestAppIntentAt: status.latestAppIntentAt,
          pendingVerificationAction: status.pendingVerificationAction,
          pendingVerificationExpiresAt: status.pendingVerificationExpiresAt,
          attendanceDriver: status.attendanceDriver,
          status: status.bluetoothStatus || currentDevice.status,
          lastBluetoothPresentAt: status.lastBluetoothPresentAt,
          lastBluetoothAbsentAt: status.lastBluetoothAbsentAt,
        };
      }

      appConfig = {
        ...appConfig,
        boundaryEnabled: status.boundaryEnabled,
        boundaryLatitude: status.boundaryLatitude,
        boundaryLongitude: status.boundaryLongitude,
        boundaryRadius: status.boundaryRadius,
        boundaryRadiusUnit: status.boundaryRadiusUnit,
      };
      renderBoundaryAdminSection();
      updateStatus();
    }
  } catch (error) {
    console.error("Failed to refresh app status:", error);
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
  const statusSubtext = document.getElementById("status-subtext");
  const clockBtn = document.getElementById("clock-btn");
  const clockBtnText = document.getElementById("clock-btn-text");
  const actionHint = document.getElementById("action-hint");

  const manual = deviceIsManualDriver(currentDevice);
  const isCheckedIn = currentDevice.attendanceStatus === "present"
    || (!currentDevice.attendanceStatus && (
      currentDevice.appStatus === "present"
      || (!manual && currentDevice.status === "present")
    ));

  if (isCheckedIn) {
    if (statusValue) {
      statusValue.textContent = "Checked In";
      statusValue.className = "status-value checked-in";
    }
    if (clockBtn) clockBtn.className = "clock-btn check-out";
    if (clockBtnText) clockBtnText.textContent = "Check Out";
    if (actionHint) {
      actionHint.textContent = manual && currentDevice.status === "present"
        ? "Tap to check out (Bluetooth still in range)"
        : "Tap to check out";
    }
  } else {
    if (statusValue) {
      statusValue.textContent = "Checked Out";
      statusValue.className = "status-value checked-out";
    }
    if (clockBtn) clockBtn.className = "clock-btn check-in";
    if (clockBtnText) clockBtnText.textContent = "Check In";
    if (actionHint) actionHint.textContent = "Tap to check in";
  }

  if (statusSubtext) {
    statusSubtext.textContent = describeCurrentStatus(currentDevice);
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
        attendanceStatus: result.attendanceStatus,
        attendanceChangedAt: result.attendanceChangedAt,
        attendanceOrigin: result.attendanceOrigin,
        attendanceVerificationStatus: result.attendanceVerificationStatus,
        attendanceVerifiedBy: result.attendanceVerifiedBy,
        latestAppIntent: result.latestAppIntent,
        latestAppIntentAt: result.latestAppIntentAt,
        pendingVerificationAction: result.pendingVerificationAction,
        pendingVerificationExpiresAt: result.pendingVerificationExpiresAt,
        attendanceDriver: result.attendanceDriver,
        status: result.bluetoothStatus || currentDevice.status,
      };

      updateStatus();

      const action = result.requestedAction === "check_out" ? "Check out" : "Check in";
      const toastMessage = `${action} successful`;
      showToast(toastMessage, "success");
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

window.saveBoundaryToggle = async function () {
  if (!canManageBoundary) {
    showToast("Admin email access required", "error");
    return;
  }

  const toggle = document.getElementById("boundary-admin-enabled") as HTMLInputElement | null;
  if (!toggle) {
    showToast("Boundary toggle is unavailable", "error");
    return;
  }

  showLoading("Saving boundary setting...");
  try {
    const nextEnabled = toggle.checked;
    const updated = await convexClient.mutation("devices:setBoundaryEnabledForAuthenticatedAdmin", {
      boundaryEnabled: nextEnabled,
      email: currentUser?.email,
    });

    appConfig = {
      ...appConfig,
      ...updated,
    };
    renderBoundaryAdminSection();
    await requestLocation();
    updateStatus();
    showToast(nextEnabled ? "Boundary enabled" : "Boundary disabled", "success");
  } catch (error) {
    console.error("Failed to save boundary setting:", error);
    showToast(error.message || "Failed to save boundary setting", "error");
    renderBoundaryAdminSection();
  } finally {
    hideLoading();
  }
};

async function loadAttendanceLogs() {
  const logsList = document.getElementById("logs-list");
  if (!logsList) return;

  if (!currentDevice) {
    logsList.innerHTML = '<div class="logs-empty">No device found</div>';
    logEntries = [];
    renderLogs();
    return;
  }

  logsList.innerHTML = '<div class="logs-loading">Loading activity...</div>';

  try {
    const history = await convexClient.query("devices:getAttendanceHistoryByDeviceId", {
      deviceId: currentDevice._id,
      limit: ACTIVITY_FETCH_LIMIT,
    });

    logEntries = normalizeLogs(history || []);
    logsPage = 1;
    renderLogs();
  } catch (error) {
    console.error("Failed to load logs:", error);
    logEntries = [];
    renderLogs("Failed to load activity");
  }
}

function normalizeLogs(history = []) {
  if (!Array.isArray(history)) return [];
  return history.filter(Boolean);
}

function pacificDateKey(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ACTIVITY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function pacificYesterdayKey(nowMs) {
  const todayK = pacificDateKey(nowMs);
  let t = nowMs;
  while (pacificDateKey(t) === todayK) {
    t -= 3600000;
    if (nowMs - t > 72 * 3600000) return pacificDateKey(nowMs - 86400000);
  }
  return pacificDateKey(t);
}

function formatPacificWeekdayDate(ts) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ACTIVITY_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(ts));
}

function formatPacificTimeShort(ts) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ACTIVITY_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ts))
    .replace(" AM", "am")
    .replace(" PM", "pm");
}

function dayHeadingLabel(dateKey, nowMs, anchorTs) {
  if (dateKey === pacificDateKey(nowMs)) return "Today";
  if (dateKey === pacificYesterdayKey(nowMs)) return "Yesterday";
  return formatPacificWeekdayDate(anchorTs);
}

/** Collapse consecutive same-direction events within `windowMs` (manual + BT follow-up). */
function mergeBurstLogs(asc, windowMs) {
  if (!asc.length) return [];
  const out = [];
  for (const log of asc) {
    const action = log.action === "check_out" ? "check_out" : "check_in";
    const ts = typeof log.timestamp === "number" ? log.timestamp : 0;
    const last = out[out.length - 1];
    if (
      last
      && last.action === action
      && Math.abs(ts - last.timestamp) <= windowMs
    ) {
      if (action === "check_in" && ts < last.timestamp) last.timestamp = ts;
      if (action === "check_out" && ts > last.timestamp) last.timestamp = ts;
      continue;
    }
    out.push({ ...log, action, timestamp: ts });
  }
  return out;
}

/**
 * Remove rapid bluetooth check_out → check_in alternations within `windowMs`.
 * A check_out immediately followed by check_in (both bluetooth-origin) within the
 * window cancels out — the device likely flapped due to signal fluctuation.
 * Returns a new array with those pairs removed.
 */
function filterBluetoothAlternations(asc, windowMs) {
  if (!asc.length) return [];
  const out = [];
  let i = 0;
  while (i < asc.length) {
    const cur = asc[i];
    const next = asc[i + 1];
    if (
      next
      && cur.action === "check_out"
      && next.action === "check_in"
      && cur.origin === "bluetooth"
      && next.origin === "bluetooth"
      && (next.timestamp - cur.timestamp) <= windowMs
    ) {
      i += 2;
      continue;
    }
    out.push(cur);
    i++;
  }
  return out;
}

/**
 * Pair check_in → following check_out. Skip orphan check_out rows (data gaps).
 */
function pairSessions(mergedAsc) {
  const sessions = [];
  let i = 0;
  while (i < mergedAsc.length) {
    while (i < mergedAsc.length && mergedAsc[i].action === "check_out") {
      i++;
    }
    if (i >= mergedAsc.length) break;
    const checkIn = mergedAsc[i];
    i++;
    if (i >= mergedAsc.length || mergedAsc[i].action === "check_in") {
      sessions.push({ checkIn, checkOut: null });
      continue;
    }
    const checkOut = mergedAsc[i];
    i++;
    sessions.push({ checkIn, checkOut });
  }
  return sessions;
}

function buildActivityDayGroupsFromLogs(logs) {
  if (!logs.length) return [];
  const asc = [...logs].sort((a, b) => a.timestamp - b.timestamp);
  const merged = mergeBurstLogs(asc, BURST_MERGE_MS);
  const cleaned = filterBluetoothAlternations(merged, BLUETOOTH_ALTERNATION_WINDOW_MS);
  const sessions = pairSessions(cleaned);
  const byDay = new Map();
  for (const s of sessions) {
    const dk = pacificDateKey(s.checkIn.timestamp);
    if (!byDay.has(dk)) byDay.set(dk, []);
    byDay.get(dk).push(s);
  }
  const keys = [...byDay.keys()].sort((a, b) => b.localeCompare(a));
  const nowMs = Date.now();
  return keys.map((dateKey) => {
    const daySessions = byDay.get(dateKey);
    daySessions.sort((a, b) => b.checkIn.timestamp - a.checkIn.timestamp);
    const anchorTs = daySessions[0].checkIn.timestamp;
    return {
      dateKey,
      heading: dayHeadingLabel(dateKey, nowMs, anchorTs),
      sessions: daySessions,
    };
  });
}

function formatActivitySessionMarkup(session) {
  const inStr = formatPacificTimeShort(session.checkIn.timestamp);
  if (!session.checkOut) {
    return `<div class="activity-session"><span class="activity-time activity-in">${inStr}</span><span class="activity-sep" aria-hidden="true">–</span><span class="activity-open">Open</span></div>`;
  }
  const outStr = formatPacificTimeShort(session.checkOut.timestamp);
  return `<div class="activity-session"><span class="activity-time activity-in">${inStr}</span><span class="activity-sep" aria-hidden="true">–</span><span class="activity-time activity-out">${outStr}</span></div>`;
}

function formatActivityDayMarkup(day) {
  const rows = day.sessions.map(formatActivitySessionMarkup).join("");
  return `<div class="activity-day" data-date="${day.dateKey}"><div class="activity-day-title">${day.heading}</div><div class="activity-day-sessions">${rows}</div></div>`;
}

function renderLogs(emptyMessage = "No activity yet") {
  const logsList = document.getElementById("logs-list");
  const pagination = document.getElementById("logs-pagination");
  const pageIndicator = document.getElementById("logs-page-indicator");
  const prevBtn = document.getElementById("logs-prev");
  const nextBtn = document.getElementById("logs-next");

  if (!logsList) return;

  if (!logEntries || logEntries.length === 0) {
    logsTotalPages = 1;
    logsPage = 1;
    logsList.innerHTML = `<div class="logs-empty">${emptyMessage}</div>`;
    if (pagination) pagination.style.display = "none";
    if (pageIndicator) pageIndicator.textContent = "Page 1 of 1";
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  const dayGroups = buildActivityDayGroupsFromLogs(logEntries);

  if (dayGroups.length === 0) {
    logsTotalPages = 1;
    logsPage = 1;
    logsList.innerHTML = `<div class="logs-empty">${emptyMessage}</div>`;
    if (pagination) pagination.style.display = "none";
    if (pageIndicator) pageIndicator.textContent = "Page 1 of 1";
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  logsTotalPages = Math.max(1, Math.ceil(dayGroups.length / ACTIVITY_DAYS_PER_PAGE));
  logsPage = Math.min(Math.max(logsPage, 1), logsTotalPages);

  const start = (logsPage - 1) * ACTIVITY_DAYS_PER_PAGE;
  const visibleDays = dayGroups.slice(start, start + ACTIVITY_DAYS_PER_PAGE);

  logsList.innerHTML = visibleDays.map(formatActivityDayMarkup).join("");

  if (pagination) pagination.style.display = logsTotalPages > 1 ? "flex" : "none";
  if (pageIndicator) pageIndicator.textContent = `Page ${logsPage} of ${logsTotalPages}`;
  if (prevBtn) prevBtn.disabled = logsPage === 1;
  if (nextBtn) nextBtn.disabled = logsPage === logsTotalPages;
}

function describeCurrentStatus(device) {
  if (!device) return "--";

  const verificationStatus = device.attendanceVerificationStatus;
  const origin = device.attendanceOrigin;
  const manual = deviceIsManualDriver(device);
  const btHere = device.status === "present";

  if (device.attendanceStatus === "present") {
    if (manual) {
      return btHere
        ? "Checked in manually. Bluetooth: in range."
        : "Checked in manually. Bluetooth: away.";
    }
    if (origin === "app" && verificationStatus === "verified") {
      return "Checked in via app and verified with bluetooth.";
    }
    if (origin === "app" && verificationStatus === "pending") {
      return "Checked in via app (legacy pending).";
    }
    if (origin === "app" && verificationStatus === "unverified") {
      return "Checked in via app (legacy, not completed).";
    }
    if (origin === "bluetooth") {
      return "Checked in automatically via bluetooth.";
    }
    if (origin === "system") {
      return "Attendance is based on inferred bluetooth history.";
    }
    return "Checked in.";
  }

  if (manual && !btHere) {
    return "Checked out manually. Bluetooth: away.";
  }
  if (manual && btHere) {
    return "Checked out manually. Bluetooth: still in range.";
  }

  if (origin === "system" && verificationStatus === "inferred") {
    return "Previous session was closed using bluetooth history.";
  }

  return "Checked out.";
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

window.changeLogsPage = function (direction) {
  if (!logEntries || logEntries.length === 0) return;
  const nextPage = logsPage + direction;
  if (nextPage < 1 || nextPage > logsTotalPages) return;
  logsPage = nextPage;
  renderLogs();
};

window.toggleLogsCollapse = function () {
  logsCollapsed = !logsCollapsed;
  updateLogsCollapseUI();
};

function updateLogsCollapseUI() {
  const content = document.getElementById("logs-content");
  const toggle = document.getElementById("logs-toggle");
  const toggleText = document.getElementById("logs-toggle-text");
  const icon = document.getElementById("logs-toggle-icon");

  if (content) {
    content.classList.toggle("collapsed", logsCollapsed);
  }

  if (toggle) {
    toggle.setAttribute("aria-expanded", (!logsCollapsed).toString());
  }

  if (toggleText) {
    toggleText.textContent = logsCollapsed ? "Show recent activity" : "Hide recent activity";
  }

  if (icon) {
    icon.classList.toggle("open", !logsCollapsed);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await init();
  updateLogsCollapseUI();
  const boundaryToggleInput = document.getElementById("boundary-admin-enabled");
  boundaryToggleInput?.addEventListener("change", updateBoundaryAdminLabelState);
});
