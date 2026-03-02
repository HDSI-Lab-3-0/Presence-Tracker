// @ts-nocheck
import { showToast } from "./dashboard";

let integrations = [];
let appLinkingConfig = null;
let boundaryPreviewMap = null;
let boundaryPreviewMarker = null;
let boundaryPreviewCircle = null;
let boundaryPreviewResizeObserver = null;
let boundaryPreviewRefreshTimer = null;
let pendingBoundaryPreviewRefresh = false;

const BOUNDARY_PREVIEW_ZOOM = 17;
const BOUNDARY_PREVIEW_REFRESH_DEBOUNCE_MS = 120;

function normalizeConvexBaseUrl(url) {
  if (typeof url !== "string") return "";
  return url.replace("/api/query", "").replace("/api/mutation", "").replace(/\/$/, "");
}

function getConvexHttpBaseUrl() {
  if (window.CONVEX_AUTH_URL) {
    return normalizeConvexBaseUrl(window.CONVEX_AUTH_URL);
  }
  if (window.CONVEX_URL) {
    return normalizeConvexBaseUrl(window.CONVEX_URL);
  }
  if (window.CONVEX_SITE_URL) {
    return normalizeConvexBaseUrl(window.CONVEX_SITE_URL);
  }
  return "";
}

const DEFAULT_BOUNDARY_CENTER = { latitude: 32.8807, longitude: -117.2338 };

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseCoordinatePair(value) {
  if (typeof value !== "string") {
    return { latitude: null, longitude: null, error: "Enter coordinates as latitude, longitude." };
  }

  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return { latitude: null, longitude: null, error: "Use the format: latitude, longitude." };
  }

  const latitude = toFiniteNumber(parts[0]);
  const longitude = toFiniteNumber(parts[1]);

  if (latitude === null || longitude === null) {
    return { latitude: null, longitude: null, error: "Latitude and longitude must be valid numbers." };
  }

  if (latitude < -90 || latitude > 90) {
    return { latitude: null, longitude: null, error: "Latitude must be between -90 and 90." };
  }

  if (longitude < -180 || longitude > 180) {
    return { latitude: null, longitude: null, error: "Longitude must be between -180 and 180." };
  }

  return { latitude, longitude, error: "" };
}

function radiusToMeters(radiusValue, radiusUnit) {
  const radius = toFiniteNumber(radiusValue);
  if (radius === null || radius <= 0) return null;
  return radiusUnit === "miles" ? radius * 1609.344 : radius;
}

function updateBoundaryStatus(message, type = "info") {
  const statusNode = document.getElementById("boundary-status");
  if (!statusNode) return;
  statusNode.className = `boundary-status ${type}`;
  statusNode.textContent = message;
}

function syncCheckboxControlState(input) {
  const control = input?.closest(".checkbox-control");
  if (!control) return;
  control.classList.toggle("is-checked", input.checked);
}

function initializeIntegrationCheckboxes() {
  const checkboxInputs = document.querySelectorAll('.checkbox-control input[type="checkbox"]');
  checkboxInputs.forEach((input) => {
    syncCheckboxControlState(input);
    input.addEventListener("change", () => syncCheckboxControlState(input));
  });
}

function clearBoundaryPreviewLayers() {
  if (boundaryPreviewMarker) {
    boundaryPreviewMarker.remove();
    boundaryPreviewMarker = null;
  }
  if (boundaryPreviewCircle) {
    boundaryPreviewCircle.remove();
    boundaryPreviewCircle = null;
  }
}

function isElementVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function queueBoundaryPreviewRefresh() {
  pendingBoundaryPreviewRefresh = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!pendingBoundaryPreviewRefresh) return;
      refreshBoundaryPreview();
    });
  });
}

function scheduleBoundaryPreviewRefresh() {
  if (boundaryPreviewRefreshTimer) window.clearTimeout(boundaryPreviewRefreshTimer);
  boundaryPreviewRefreshTimer = window.setTimeout(() => {
    boundaryPreviewRefreshTimer = null;
    refreshBoundaryPreview();
  }, BOUNDARY_PREVIEW_REFRESH_DEBOUNCE_MS);
}

function setIntegrationCardsVisibility(tabName) {
  const resolvedTabName = tabName || "discord";
  document.querySelectorAll(".integration-card").forEach((card) => {
    const isDiscord = card.querySelector("h4")?.textContent === "Discord";
    const isSlack = card.querySelector("h4")?.textContent === "Slack";
    const isMobile = card.querySelector("h4")?.textContent === "Mobile App Linking";
    card.style.display = "none";
    if (resolvedTabName === "discord" && isDiscord) card.style.display = "flex";
    if (resolvedTabName === "slack" && isSlack) card.style.display = "flex";
    if (resolvedTabName === "mobile" && isMobile) card.style.display = "flex";
  });

  if (resolvedTabName === "mobile") queueBoundaryPreviewRefresh();
}

function setBoundaryControlsState(isEnabled) {
  const inputs = document.querySelectorAll("[data-boundary-input]");
  inputs.forEach((input) => {
    input.disabled = !isEnabled;
    input.classList.toggle("boundary-input-disabled", !isEnabled);
  });

  const toggleInput = document.getElementById("app-boundary-enabled");
  if (toggleInput) syncCheckboxControlState(toggleInput);

  const statusText = document.getElementById("boundary-status-text");
  if (statusText) {
    statusText.textContent = isEnabled ? "● Enabled" : "○ Disabled";
    statusText.classList.toggle("enabled", isEnabled);
    statusText.classList.toggle("disabled", !isEnabled);
  }

  const hintText = document.querySelector(".boundary-toggle-hint");
  if (hintText) {
    hintText.textContent = isEnabled
      ? "Presence updates must originate inside the defined radius."
      : "Boundary is off; presence updates will be accepted from anywhere.";
  }

  const mapPreview = document.getElementById("boundary-map-preview");
  if (mapPreview) {
    mapPreview.classList.toggle("is-disabled", !isEnabled);
  }

  if (!isEnabled) {
    updateBoundaryStatus("Boundary disabled. Enable to preview changes.", "info");
  }
}

function initializeBoundaryToggle() {
  const toggleInput = document.getElementById("app-boundary-enabled");
  if (!toggleInput) return;

  setBoundaryControlsState(toggleInput.checked);

  toggleInput.addEventListener("change", (event) => {
    const isEnabled = event.target.checked;
    setBoundaryControlsState(isEnabled);

    if (!isEnabled) {
      clearBoundaryPreviewLayers();
      updateBoundaryStatus("Boundary disabled. Enable to preview changes.", "info");
    } else {
      refreshBoundaryPreview();
    }
  });
}

function ensureBoundaryPreviewMap() {
  const mapContainer = document.getElementById("boundary-map-preview");
  if (!mapContainer) return null;

  if (typeof L === "undefined") {
    updateBoundaryStatus("Leaflet map failed to load. Refresh and try again.", "error");
    return null;
  }

  if (boundaryPreviewMap) {
    const currentContainer = boundaryPreviewMap.getContainer();
    if (!currentContainer || !document.body.contains(currentContainer)) {
      if (boundaryPreviewResizeObserver) {
        boundaryPreviewResizeObserver.disconnect();
        boundaryPreviewResizeObserver = null;
      }
      boundaryPreviewMap.remove();
      boundaryPreviewMap = null;
      boundaryPreviewMarker = null;
      boundaryPreviewCircle = null;
    }
  }

  if (boundaryPreviewMap) {
    return boundaryPreviewMap;
  }

  boundaryPreviewMap = L.map(mapContainer, {
    zoomControl: true,
    preferCanvas: true,
    zoomAnimation: false,
    fadeAnimation: false,
    markerZoomAnimation: false,
  }).setView([DEFAULT_BOUNDARY_CENTER.latitude, DEFAULT_BOUNDARY_CENTER.longitude], BOUNDARY_PREVIEW_ZOOM);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 3,
  }).addTo(boundaryPreviewMap);

  boundaryPreviewMap.whenReady(() => {
    queueBoundaryPreviewRefresh();
  });

  if (typeof ResizeObserver !== "undefined") {
    boundaryPreviewResizeObserver = new ResizeObserver(() => {
      if (isElementVisible(mapContainer)) queueBoundaryPreviewRefresh();
    });
    boundaryPreviewResizeObserver.observe(mapContainer);
  }

  return boundaryPreviewMap;
}

function refreshBoundaryPreview() {
  const mapContainer = document.getElementById("boundary-map-preview");
  if (!mapContainer) return;
  if (!isElementVisible(mapContainer)) {
    pendingBoundaryPreviewRefresh = true;
    return;
  }

  const map = ensureBoundaryPreviewMap();
  if (!map) return;
  pendingBoundaryPreviewRefresh = false;
  map.invalidateSize({ pan: false });

  const enabledInput = document.getElementById("app-boundary-enabled");
  if (enabledInput && !enabledInput.checked) {
    clearBoundaryPreviewLayers();
    updateBoundaryStatus("Boundary disabled. Enable to preview changes.", "info");
    return;
  }

  const coordinateInput = document.getElementById("app-boundary-coordinates");
  const radiusInput = document.getElementById("app-boundary-radius");
  const radiusUnitInput = document.getElementById("app-boundary-radius-unit");

  if (!coordinateInput || !radiusInput || !radiusUnitInput) return;

  const parsedCoordinates = parseCoordinatePair(coordinateInput.value);
  if (parsedCoordinates.error) {
    if (boundaryPreviewMarker) boundaryPreviewMarker.remove();
    if (boundaryPreviewCircle) boundaryPreviewCircle.remove();
    boundaryPreviewMarker = null;
    boundaryPreviewCircle = null;
    updateBoundaryStatus(parsedCoordinates.error, "error");
    return;
  }

  const radiusMeters = radiusToMeters(radiusInput.value, radiusUnitInput.value);
  if (radiusMeters === null) {
    if (boundaryPreviewCircle) boundaryPreviewCircle.remove();
    boundaryPreviewCircle = null;
    updateBoundaryStatus("Radius must be greater than 0.", "error");
    return;
  }

  const { latitude, longitude } = parsedCoordinates;
  const center = [latitude, longitude];

  if (!boundaryPreviewMarker) {
    boundaryPreviewMarker = L.circleMarker(center, {
      radius: 8,
      color: "#0C4A6E",
      fillColor: "#0284C7",
      fillOpacity: 0.95,
      weight: 3,
    }).addTo(map);
  } else {
    boundaryPreviewMarker.setLatLng(center);
  }

  if (!boundaryPreviewCircle) {
    boundaryPreviewCircle = L.circle(center, {
      radius: radiusMeters,
      color: "#0284C7",
      fillColor: "#0EA5E9",
      fillOpacity: 0.25,
      weight: 3,
    }).addTo(map);
  } else {
    boundaryPreviewCircle.setLatLng(center);
    boundaryPreviewCircle.setRadius(radiusMeters);
  }

  map.fitBounds(boundaryPreviewCircle.getBounds().pad(0.35), {
    animate: false,
    maxZoom: BOUNDARY_PREVIEW_ZOOM,
  });
  updateBoundaryStatus("Map preview updated.", "success");
}

function initializeBoundaryPreview() {
  const coordinateInput = document.getElementById("app-boundary-coordinates");
  const radiusInput = document.getElementById("app-boundary-radius");
  const radiusUnitInput = document.getElementById("app-boundary-radius-unit");

  if (!coordinateInput || !radiusInput || !radiusUnitInput) return;

  coordinateInput.addEventListener("input", scheduleBoundaryPreviewRefresh);
  radiusInput.addEventListener("input", scheduleBoundaryPreviewRefresh);

  coordinateInput.addEventListener("change", refreshBoundaryPreview);
  radiusInput.addEventListener("change", refreshBoundaryPreview);
  radiusUnitInput.addEventListener("change", refreshBoundaryPreview);

  requestAnimationFrame(() => {
    const enabledInput = document.getElementById("app-boundary-enabled");
    if (enabledInput && !enabledInput.checked) {
      updateBoundaryStatus("Boundary disabled. Enable to preview changes.", "info");
      return;
    }
    queueBoundaryPreviewRefresh();
  });
}

function getAppRouteUrl() {
  return `${getConvexHttpBaseUrl()}/api/change_status`;
}

function getAppFetchRouteUrl() {
  return `${getConvexHttpBaseUrl()}/api/fetch`;
}

window.saveBoundaryConfig = async function () {
  const adminPassword = sessionStorage.getItem("ieee_presence_password");
  if (!adminPassword) {
    showToast("Please log in again as admin", "error");
    return;
  }

  const enabledInput = document.getElementById("app-boundary-enabled");
  const coordinatesInput = document.getElementById("app-boundary-coordinates");
  const radiusInput = document.getElementById("app-boundary-radius");
  const radiusUnitInput = document.getElementById("app-boundary-radius-unit");

  if (!enabledInput || !coordinatesInput || !radiusInput || !radiusUnitInput) {
    showToast("Boundary settings controls are unavailable", "error");
    return;
  }

  const boundaryEnabled = enabledInput.checked;
  let boundaryLatitude = typeof appLinkingConfig?.boundaryLatitude === "number"
    ? appLinkingConfig.boundaryLatitude
    : DEFAULT_BOUNDARY_CENTER.latitude;
  let boundaryLongitude = typeof appLinkingConfig?.boundaryLongitude === "number"
    ? appLinkingConfig.boundaryLongitude
    : DEFAULT_BOUNDARY_CENTER.longitude;
  let boundaryRadius = typeof appLinkingConfig?.boundaryRadius === "number"
    ? appLinkingConfig.boundaryRadius
    : 100;
  let boundaryRadiusUnit = appLinkingConfig?.boundaryRadiusUnit === "miles" ? "miles" : "meters";

  if (boundaryEnabled) {
    const parsedCoordinates = parseCoordinatePair(coordinatesInput.value);
    if (parsedCoordinates.error) {
      updateBoundaryStatus(parsedCoordinates.error, "error");
      showToast(parsedCoordinates.error, "error");
      return;
    }

    const radius = toFiniteNumber(radiusInput.value);
    if (radius === null || radius <= 0) {
      updateBoundaryStatus("Radius must be greater than 0.", "error");
      showToast("Radius must be greater than 0", "error");
      return;
    }

    boundaryLatitude = parsedCoordinates.latitude;
    boundaryLongitude = parsedCoordinates.longitude;
    boundaryRadius = radius;
    boundaryRadiusUnit = radiusUnitInput.value === "miles" ? "miles" : "meters";
  } else {
    updateBoundaryStatus("Boundary disabled. Enable to preview changes.", "info");
  }

  try {
    appLinkingConfig = await window.convexClient.mutation("devices:saveAppBoundaryConfig", {
      adminPassword,
      boundaryEnabled,
      boundaryLatitude,
      boundaryLongitude,
      boundaryRadius,
      boundaryRadiusUnit,
    });

    coordinatesInput.value = `${appLinkingConfig.boundaryLatitude}, ${appLinkingConfig.boundaryLongitude}`;
    radiusInput.value = String(appLinkingConfig.boundaryRadius);
    radiusUnitInput.value = appLinkingConfig.boundaryRadiusUnit;
    setBoundaryControlsState(boundaryEnabled);

    if (boundaryEnabled) {
      refreshBoundaryPreview();
      showToast("Boundary settings saved", "success");
    } else {
      clearBoundaryPreviewLayers();
      showToast("Boundary disabled", "success");
    }
  } catch (e) {
    updateBoundaryStatus(e.message || "Failed to save boundary settings.", "error");
    showToast(`Error saving boundary: ${e.message}`, "error");
  }
};

function encodeBase64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function buildEncodedLinkingEnvelope() {
  if (!appLinkingConfig?.apiKey) return null;

  const payload = {
    apiUrl: getAppRouteUrl(),
    apiKey: appLinkingConfig.apiKey,
  };

  return {
    encoding: "base64-json",
    version: 1,
    encodedPayload: encodeBase64Utf8(JSON.stringify(payload)),
    decodeHint: "Base64 decode encodedPayload, then JSON.parse(decodedString)",
  };
}

function renderAppLinkingQr(containerId = "app-linking-qr-container") {
  const container = document.getElementById(containerId);
  if (!container) return;

  const encodedEnvelope = buildEncodedLinkingEnvelope();
  if (!encodedEnvelope) {
    container.innerHTML = '<p class="integration-muted">Rotate or fetch an API key to generate a QR code.</p>';
    return;
  }

  if (typeof QRCode === "undefined") {
    container.innerHTML = '<p class="integration-error">QRCode library failed to load. Refresh and try again.</p>';
    return;
  }

  const qrData = JSON.stringify(encodedEnvelope);

  container.innerHTML = "";
  const qrNode = document.createElement("div");
  qrNode.className = "qr-node";
  container.appendChild(qrNode);

  new QRCode(qrNode, {
    text: qrData,
    width: 224,
    height: 224,
    correctLevel: QRCode.CorrectLevel.M,
  });

  const hint = document.createElement("p");
  hint.className = "integration-muted";
  hint.textContent = "Scan this with the app to import encoded linking settings.";
  container.appendChild(hint);
}

window.openIntegrationsModal = function () {
  const modal = document.getElementById("integrations-modal");
  if (!modal) return;

  modal.classList.add("active");
  fetchIntegrations().then(() => {
    const activeTab = document.querySelector(".settings-tab.active");
    if (!activeTab) return;
    setIntegrationCardsVisibility(activeTab.dataset.tab);
  });
};

window.closeIntegrationsModal = function () {
  if (boundaryPreviewRefreshTimer) {
    window.clearTimeout(boundaryPreviewRefreshTimer);
    boundaryPreviewRefreshTimer = null;
  }
  pendingBoundaryPreviewRefresh = false;
  if (boundaryPreviewResizeObserver) {
    boundaryPreviewResizeObserver.disconnect();
    boundaryPreviewResizeObserver = null;
  }
  if (boundaryPreviewMap) {
    boundaryPreviewMap.remove();
    boundaryPreviewMap = null;
    boundaryPreviewMarker = null;
    boundaryPreviewCircle = null;
  }

  const modal = document.getElementById("integrations-modal");
  if (modal) modal.classList.remove("active");
};

async function fetchAppLinkingConfig() {
  appLinkingConfig = await window.convexClient.query("devices:getAppLinkingConfig", {});
  return appLinkingConfig;
}

window.openAppQrModal = async function () {
  const modal = document.getElementById("app-qr-modal");
  if (!modal) return;

  modal.classList.add("active");

  const container = document.getElementById("app-linking-qr-standalone");
  if (container) {
    container.innerHTML = '<p class="integration-muted">Loading QR code...</p>';
  }

  try {
    await fetchAppLinkingConfig();
    renderAppLinkingQr("app-linking-qr-standalone");
  } catch (error) {
    if (container) {
      container.innerHTML = '<p class="integration-error">Unable to load QR config right now.</p>';
    }
    console.error("Failed to load app linking config", error);
  }
};

window.closeAppQrModal = function () {
  const modal = document.getElementById("app-qr-modal");
  if (modal) modal.classList.remove("active");
};

async function fetchIntegrations() {
  const list = document.getElementById("integrations-list");
  if (list) list.innerHTML = "Loading...";

  try {
    integrations = await window.convexClient.query("integrations:getIntegrations");
    await fetchAppLinkingConfig();
    renderIntegrations();
  } catch (error) {
    if (list) list.textContent = "Error loading integrations.";
    console.error(error);
  }
}

function renderIntegrations() {
  const list = document.getElementById("integrations-list");
  if (!list) return;

  list.innerHTML = "";

  const discord = integrations.find((i) => i.type === "discord");
  const slack = integrations.find((i) => i.type === "slack");

  const discordDiv = document.createElement("div");
  discordDiv.className = "integration-card";
  discordDiv.innerHTML = `
    <h4>Discord</h4>
    <div class="form-group">
      <label>Display Name (Space Name)</label>
      <input type="text" id="discord-display-name" placeholder="Project Space" value="${discord?.config?.displayName || ""}">
    </div>
    <div class="form-group">
      <label>Webhook URL</label>
      <input type="text" id="discord-webhook" placeholder="https://discord.com/api/webhooks/..." value="${discord?.config?.webhookUrl || ""}">
    </div>
    <div class="checkbox-grid">
      <div class="form-group checkbox-group">
        <label class="checkbox-control" for="discord-use-embeds">
          <span class="checkbox-visual">
            <input type="checkbox" id="discord-use-embeds" ${discord?.config?.useEmbeds ? "checked" : ""}>
            <span class="checkbox-indicator"></span>
          </span>
          <div class="checkbox-text">
            <span class="checkbox-title">Use rich embeds</span>
            <span class="checkbox-description">Send only the embed version of the status update.</span>
          </div>
        </label>
      </div>
      <div class="form-group checkbox-group">
        <label class="checkbox-control" for="discord-show-absent">
          <span class="checkbox-visual">
            <input type="checkbox" id="discord-show-absent" ${discord?.config?.showAbsentUsers ? "checked" : ""}>
            <span class="checkbox-indicator"></span>
          </span>
          <div class="checkbox-text">
            <span class="checkbox-title">Show \"Currently OUT\" users</span>
            <span class="checkbox-description">Include people who are currently marked as out.</span>
          </div>
        </label>
      </div>
    </div>
    <div class="form-actions">
      <label class="switch">
        <input type="checkbox" id="discord-enabled" ${discord?.isEnabled ? "checked" : ""}>
        <span class="slider"></span> Enabled
      </label>
      <button class="btn btn-primary" onclick="saveDiscord()">Save</button>
    </div>
  `;
  list.appendChild(discordDiv);

  const slackDiv = document.createElement("div");
  slackDiv.className = "integration-card";
  slackDiv.innerHTML = `
    <h4>Slack</h4>
    <div class="form-group">
      <label>Display Name (Space Name)</label>
      <input type="text" id="slack-display-name" placeholder="Project Space" value="${slack?.config?.displayName || ""}">
    </div>
    <div class="form-group">
      <label>Bot User OAuth Token (xoxb-...)</label>
      <input type="text" id="slack-token" placeholder="xoxb-..." value="${slack?.config?.botToken || ""}">
    </div>
    <div class="form-group">
      <label>Channel ID</label>
      <input type="text" id="slack-channel" placeholder="C12345678" value="${slack?.config?.channelId || ""}">
    </div>
    <div class="form-group checkbox-group">
      <label class="checkbox-control" for="slack-show-absent">
        <span class="checkbox-visual">
          <input type="checkbox" id="slack-show-absent" ${slack?.config?.showAbsentUsers ? "checked" : ""}>
          <span class="checkbox-indicator"></span>
        </span>
        <div class="checkbox-text">
          <span class="checkbox-title">Show \"Currently OUT\" users</span>
          <span class="checkbox-description">Include people who are currently marked as out.</span>
        </div>
      </label>
    </div>
    <div class="form-actions">
      <label class="switch">
        <input type="checkbox" id="slack-enabled" ${slack?.isEnabled ? "checked" : ""}>
        <span class="slider"></span> Enabled
      </label>
      <button class="btn btn-primary" onclick="saveSlack()">Save</button>
    </div>
  `;
  list.appendChild(slackDiv);

  const boundaryLatitude = typeof appLinkingConfig?.boundaryLatitude === "number"
    ? appLinkingConfig.boundaryLatitude
    : DEFAULT_BOUNDARY_CENTER.latitude;
  const boundaryLongitude = typeof appLinkingConfig?.boundaryLongitude === "number"
    ? appLinkingConfig.boundaryLongitude
    : DEFAULT_BOUNDARY_CENTER.longitude;
  const boundaryRadius = typeof appLinkingConfig?.boundaryRadius === "number"
    ? appLinkingConfig.boundaryRadius
    : 100;
  const boundaryRadiusUnit = appLinkingConfig?.boundaryRadiusUnit === "miles" ? "miles" : "meters";
  const boundaryEnabled = Boolean(appLinkingConfig?.boundaryEnabled);

  const mobileApiDiv = document.createElement("div");
  mobileApiDiv.className = "integration-card";
  mobileApiDiv.innerHTML = `
    <h4>Mobile App Linking</h4>
    <div class="form-group">
      <label>API Route</label>
      <input type="text" id="app-route" value="${getAppRouteUrl()}" readonly>
    </div>
    <div class="form-group">
      <label>Fetch Route</label>
      <input type="text" id="app-fetch-route" value="${getAppFetchRouteUrl()}" readonly>
    </div>
    <div class="form-group">
      <label>API Key</label>
      <input type="text" id="app-api-key" value="${appLinkingConfig?.apiKey || ""}" readonly>
    </div>
    <div class="form-group">
      <label>Key Version</label>
      <input type="text" id="app-key-version" value="${appLinkingConfig?.keyVersion || 1}" readonly>
    </div>
    <div class="form-actions integration-actions-end">
      <button class="btn btn-secondary" onclick="downloadAppLinkingJson()">Download JSON</button>
      <button class="btn btn-primary" onclick="rotateAppApiKey()">Rotate Key</button>
    </div>
    <div class="form-group integration-top-gap">
      <label>QR Code</label>
      <div id="app-linking-qr-container" class="integration-qr-wrapper"></div>
    </div>
    <div class="form-group boundary-section">
      <label class="boundary-section-label">Location Boundary</label>
      <div class="form-group checkbox-group boundary-checkbox-group">
        <label class="checkbox-control boundary-checkbox" for="app-boundary-enabled">
          <span class="checkbox-visual">
            <input type="checkbox" id="app-boundary-enabled" ${boundaryEnabled ? "checked" : ""}>
            <span class="checkbox-indicator"></span>
          </span>
          <div class="checkbox-text">
            <span class="checkbox-title">Boundary enforcement</span>
            <span id="boundary-status-text" class="boundary-toggle-status ${boundaryEnabled ? "enabled" : "disabled"}">
              ${boundaryEnabled ? "● Enabled" : "○ Disabled"}
            </span>
            <span class="checkbox-description boundary-toggle-hint">
              ${boundaryEnabled ? "Presence updates must originate inside the defined radius." : "Boundary is off; presence updates will be accepted from anywhere."}
            </span>
          </div>
        </label>
      </div>
      <div class="form-group boundary-row">
        <label for="app-boundary-coordinates">Center (Latitude, Longitude)</label>
        <input type="text" id="app-boundary-coordinates" value="${boundaryLatitude}, ${boundaryLongitude}" placeholder="32.88071867959147, -117.23379676539253" data-boundary-input>
      </div>
      <div class="boundary-radius-grid">
        <div class="form-group boundary-row">
          <label for="app-boundary-radius">Radius</label>
          <input type="number" id="app-boundary-radius" min="0.0001" step="any" value="${boundaryRadius}" data-boundary-input>
        </div>
        <div class="form-group boundary-row">
          <label for="app-boundary-radius-unit">Unit</label>
          <select id="app-boundary-radius-unit" data-boundary-input>
            <option value="meters" ${boundaryRadiusUnit === "meters" ? "selected" : ""}>Meters</option>
            <option value="miles" ${boundaryRadiusUnit === "miles" ? "selected" : ""}>Miles</option>
          </select>
        </div>
      </div>
      <div id="boundary-map-preview" class="boundary-map-preview ${boundaryEnabled ? "" : "is-disabled"}"></div>
      <p id="boundary-status" class="boundary-status info">Enter coordinates and radius to preview the boundary.</p>
      <div class="form-actions integration-actions-end integration-top-gap">
        <button class="btn btn-primary" onclick="saveBoundaryConfig()">Save Boundary</button>
      </div>
    </div>
  `;
  list.appendChild(mobileApiDiv);

  renderAppLinkingQr("app-linking-qr-container");
  initializeBoundaryPreview();
  initializeBoundaryToggle();
  initializeIntegrationCheckboxes();
}

window.saveDiscord = async function () {
  const webhookUrl = document.getElementById("discord-webhook")?.value.trim();
  const isEnabled = document.getElementById("discord-enabled")?.checked;
  const displayName = document.getElementById("discord-display-name")?.value.trim();
  const useEmbeds = document.getElementById("discord-use-embeds")?.checked;
  const showAbsentUsers = document.getElementById("discord-show-absent")?.checked;
  const adminPassword = sessionStorage.getItem("ieee_presence_password");

  if (!adminPassword) {
    showToast("Please log in again as admin", "error");
    return;
  }

  try {
    await window.convexClient.mutation("integrations:saveIntegration", {
      adminPassword,
      type: "discord",
      config: {
        webhookUrl,
        displayName: displayName || undefined,
        useEmbeds,
        showAbsentUsers,
      },
      isEnabled,
    });
    showToast("Discord settings saved", "success");
  } catch (error) {
    showToast(`Error saving Discord: ${error.message}`, "error");
  }
};

window.saveSlack = async function () {
  const botToken = document.getElementById("slack-token")?.value.trim();
  const channelId = document.getElementById("slack-channel")?.value.trim();
  const isEnabled = document.getElementById("slack-enabled")?.checked;
  const displayName = document.getElementById("slack-display-name")?.value.trim();
  const showAbsentUsers = document.getElementById("slack-show-absent")?.checked;
  const adminPassword = sessionStorage.getItem("ieee_presence_password");

  if (!adminPassword) {
    showToast("Please log in again as admin", "error");
    return;
  }

  try {
    await window.convexClient.mutation("integrations:saveIntegration", {
      adminPassword,
      type: "slack",
      config: {
        botToken,
        channelId,
        displayName: displayName || undefined,
        showAbsentUsers,
      },
      isEnabled,
    });
    showToast("Slack settings saved", "success");
  } catch (error) {
    showToast(`Error saving Slack: ${error.message}`, "error");
  }
};

window.rotateAppApiKey = async function () {
  const adminPassword = sessionStorage.getItem("ieee_presence_password");
  if (!adminPassword) {
    showToast("Please log in again as admin", "error");
    return;
  }

  try {
    appLinkingConfig = await window.convexClient.mutation("devices:rotateAppApiKey", { adminPassword });
    renderIntegrations();
    showToast("App API key rotated", "success");
  } catch (error) {
    showToast(`Error rotating app key: ${error.message}`, "error");
  }
};

window.downloadAppLinkingJson = function () {
  if (!appLinkingConfig?.apiKey) {
    showToast("No API key available yet. Rotate key first.", "error");
    return;
  }

  const encodedEnvelope = buildEncodedLinkingEnvelope();
  if (!encodedEnvelope) {
    showToast("No API key available yet. Rotate key first.", "error");
    return;
  }

  const blob = new Blob([JSON.stringify(encodedEnvelope, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.setAttribute("href", url);
  link.setAttribute("download", `presence-app-linking-encoded-v${appLinkingConfig.keyVersion || 1}.json`);
  link.style.visibility = "hidden";

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast("Encoded linking JSON downloaded", "success");
};

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;

  const integrationsModal = document.getElementById("integrations-modal");
  if (integrationsModal?.classList.contains("active")) {
    window.closeIntegrationsModal?.();
  }

  const appQrModal = document.getElementById("app-qr-modal");
  if (appQrModal?.classList.contains("active")) {
    window.closeAppQrModal?.();
  }
});

window.addEventListener("click", (event) => {
  const integrationsModal = document.getElementById("integrations-modal");
  if (event.target === integrationsModal) {
    window.closeIntegrationsModal?.();
  }

  const appQrModal = document.getElementById("app-qr-modal");
  if (event.target === appQrModal) {
    window.closeAppQrModal?.();
  }

  if ((event.target as HTMLElement)?.classList?.contains("settings-tab")) {
    document.querySelectorAll(".settings-tab").forEach((tab) => tab.classList.remove("active"));
    event.target.classList.add("active");

    const tabName = event.target.dataset.tab;
    setIntegrationCardsVisibility(tabName);
  }
});
