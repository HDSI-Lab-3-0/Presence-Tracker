// @ts-nocheck
import { ConvexClient } from "convex/browser";

let convexClient = null;

if (window.CONVEX_URL) {
  try {
    convexClient = new ConvexClient(window.CONVEX_URL, {
      skipConvexDeploymentUrlCheck: true,
    });
    window.convexClient = convexClient;
  } catch (error) {
    console.error("Failed to initialize Convex client:", error);
    alert("Failed to connect to backend. Please check your configuration.");
  }
}

function getPresenceSourceMessage(device) {
  const bluetoothPresent = device.status === "present";
  const appPresent = device.appStatus === "present";

  if (appPresent && bluetoothPresent) return "✓ App + Bluetooth";
  if (appPresent) return "✓ App";
  if (bluetoothPresent) return "✓ Bluetooth";
  return "";
}

function escapeSingleQuote(value) {
  return String(value).replace(/'/g, "\\'");
}

let selectedMacForRegistration = null;
let subscriptionInitialized = false;
let organizationName = "Presence Tracker";
let appConfig = null;
let statusRefreshInterval = null;

document.addEventListener("DOMContentLoaded", () => {
  fetchAndSetOrganizationName();
  if (sessionStorage.getItem("ieee_presence_authenticated") === "true") {
    initializeApp();
  }
});

export async function initializeApp() {
  await fetchAndSetOrganizationName();
  if (!subscriptionInitialized) {
    setupConvexSubscription();
    subscriptionInitialized = true;
  }
  // Start periodic status refresh like PWA
  startPeriodicStatusRefresh();
}

window.initializeApp = initializeApp;

async function fetchAndSetOrganizationName() {
  if (window.ORGANIZATION_NAME && window.ORGANIZATION_NAME !== "Presence Tracker") {
    organizationName = window.ORGANIZATION_NAME;
    updateOrganizationNameInUI();
    return;
  }

  if (!convexClient) {
    return;
  }

  try {
    const orgName = await convexClient.query("devices:getOrganizationName");
    organizationName = orgName || "Presence Tracker";
    updateOrganizationNameInUI();
  } catch (error) {
    console.error("Failed to fetch organization name:", error);
  }
}

function updateOrganizationNameInUI() {
  document.title = `${organizationName} Presence Tracker`;

  const mainTitle = document.getElementById("main-title");
  if (mainTitle) {
    mainTitle.textContent = `${organizationName} Presence Tracker`;
  }

  const authTitle = document.getElementById("main-title-auth");
  if (authTitle) {
    authTitle.textContent = `${organizationName} Presence Tracker`;
  }

  const membersTitle = document.getElementById("members-title");
  if (membersTitle) {
    membersTitle.textContent = `${organizationName} Members`;
  }

  const loadingMembers = document.getElementById("loading-members");
  if (loadingMembers) {
    loadingMembers.textContent = `Loading ${organizationName} Members ...`;
  }

  const logsTitle = document.getElementById("logs-title");
  if (logsTitle) {
    logsTitle.textContent = `${organizationName} Device Logs`;
  }
}

function setupConvexSubscription() {
  if (!convexClient) {
    return;
  }

  convexClient.onUpdate("devices:getDevices", {}, (devices) => {
    renderDevices(devices);
  });
}

async function fetchAppConfig() {
  try {
    appConfig = await convexClient.query("devices:getAppLinkingConfig", {});
  } catch (error) {
    console.error("Failed to fetch app config:", error);
  }
}

async function refreshAllAppStatuses() {
  if (!convexClient || !appConfig?.apiKey) {
    await fetchAppConfig();
  }

  if (!appConfig?.apiKey) {
    console.warn("[Dashboard] Missing API key, skipping status refresh");
    return;
  }

  try {
    // Get all devices with registered emails
    const devices = await convexClient.query("devices:getDevices", {});
    const devicesWithEmail = devices.filter(d => d.ucsdEmail && d.pendingRegistration === false);

    // Refresh app status for each device
    for (const device of devicesWithEmail) {
      try {
        const status = await convexClient.query("devices:fetchAppStatusByEmail", {
          apiKey: appConfig.apiKey,
          email: device.ucsdEmail,
        });

        if (status?.success) {
          // Update the device's app status locally
          device.appStatus = status.appStatus;
        }
      } catch (error) {
        console.error(`Failed to refresh app status for ${device.ucsdEmail}:`, error);
      }
    }
  } catch (error) {
    console.error("Failed to refresh app statuses:", error);
  }
}

function startPeriodicStatusRefresh() {
  // Initial fetch
  fetchAppConfig();
  
  // Refresh app statuses every 30 seconds (like PWA)
  if (statusRefreshInterval) {
    clearInterval(statusRefreshInterval);
  }
  
  statusRefreshInterval = setInterval(async () => {
    await refreshAllAppStatuses();
  }, 30000);
}

function renderDevices(devices) {
  const residentsGrid = document.getElementById("residents-grid");
  const pendingList = document.getElementById("pending-list");
  const residentsCount = document.getElementById("residents-count");

  const residents = devices.filter((d) => d.pendingRegistration === false);
  residents.sort((a, b) => {
    const aActive = a.status === "present";
    const bActive = b.status === "present";

    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;

    const aName = a.firstName && a.lastName ? `${a.firstName} ${a.lastName}` : (a.name || a.macAddress);
    const bName = b.firstName && b.lastName ? `${b.firstName} ${b.lastName}` : (b.name || b.macAddress);
    return aName.localeCompare(bName);
  });

  const pending = devices.filter((d) => d.pendingRegistration !== false);

  if (residentsCount) {
    residentsCount.textContent = String(residents.length);
  }

  reconcileResidents(residentsGrid, residents);
  reconcilePending(pendingList, pending);
}

function createResidentCard(device) {
  const isPresent = device.status === "present" || device.appStatus === "present";
  const statusClass = isPresent ? "present" : "away";
  const sourceMessage = getPresenceSourceMessage(device);
  const fullName = device.firstName && device.lastName
    ? `${device.firstName} ${device.lastName}`
    : (device.name || "Unknown");

  let timeMessage = "";
  if (isPresent) {
    if (device.connectedSince) {
      const connectedDate = new Date(device.connectedSince);
      const timeStr = connectedDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      timeMessage = `Connected at ${timeStr}`;
    } else {
      timeMessage = "Connected";
    }
  } else {
    timeMessage = `Last seen: ${formatTimeAgo(device.lastSeen)}`;
  }

  const card = document.createElement("div");
  card.className = `resident-card ${statusClass}`;
  card.dataset.mac = device.macAddress;
  card.innerHTML = `
    <div class="card-header">
      <div>
        <div class="user-name">${fullName}</div>
        <div class="user-mac">${device.macAddress}</div>
      </div>
      <span class="status-badge ${statusClass}">${isPresent ? "Present" : "Away"}</span>
    </div>
    <div class="last-seen">${timeMessage}</div>
    ${sourceMessage ? `<div class="last-seen presence-source">${sourceMessage}</div>` : ""}
    ${window.isAdmin && window.isAdmin()
      ? `<div class="admin-actions">
          <button class="btn btn-secondary admin-action-btn"
            onclick="openEditModal('${device._id}', '${escapeSingleQuote(device.firstName || "")}', '${escapeSingleQuote(device.lastName || "")}', '${escapeSingleQuote(device.ucsdEmail || "")}')">
            Edit
          </button>
          <button class="btn admin-action-btn btn-danger"
            onclick="forgetDevice('${device._id}', '${device.macAddress}')">
            Forget
          </button>
         </div>`
      : ""}
  `;
  return card;
}

function updateResidentCard(card, device) {
  const isPresent = device.status === "present" || device.appStatus === "present";
  const statusClass = isPresent ? "present" : "away";
  const sourceMessage = getPresenceSourceMessage(device);

  const fullName = device.firstName && device.lastName
    ? `${device.firstName} ${device.lastName}`
    : (device.name || "Unknown");

  let timeMessage = "";
  if (isPresent) {
    if (device.connectedSince) {
      const connectedDate = new Date(device.connectedSince);
      const timeStr = connectedDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      timeMessage = `Connected at ${timeStr}`;
    } else {
      timeMessage = "Connected";
    }
  } else {
    timeMessage = `Last seen: ${formatTimeAgo(device.lastSeen)}`;
  }

  card.className = `resident-card ${statusClass}`;

  const userName = card.querySelector(".user-name");
  const statusBadge = card.querySelector(".status-badge");
  const lastSeen = card.querySelector(".last-seen");
  const sourceBadge = card.querySelector(".presence-source");

  if (userName) userName.textContent = fullName;
  if (statusBadge) {
    statusBadge.className = `status-badge ${statusClass}`;
    statusBadge.textContent = isPresent ? "Present" : "Away";
  }
  if (lastSeen) lastSeen.textContent = timeMessage;

  if (sourceBadge) {
    if (sourceMessage) {
      sourceBadge.textContent = sourceMessage;
    } else {
      sourceBadge.remove();
    }
  } else if (sourceMessage && lastSeen) {
    const newSource = document.createElement("div");
    newSource.className = "last-seen presence-source";
    newSource.textContent = sourceMessage;
    lastSeen.insertAdjacentElement("afterend", newSource);
  }

  const adminActions = card.querySelector(".admin-actions");
  if (adminActions) {
    const editBtn = adminActions.querySelector(".btn-secondary");
    const forgetBtn = adminActions.querySelector(".btn-danger");
    if (editBtn) {
      editBtn.onclick = () => window.openEditModal?.(device._id, device.firstName || "", device.lastName || "", device.ucsdEmail || "");
    }
    if (forgetBtn) {
      forgetBtn.onclick = () => window.forgetDevice?.(device._id, device.macAddress);
    }
  }
}

function reconcileResidents(container, residents) {
  if (!container) return;

  if (residents.length === 0) {
    container.innerHTML = `<div class="empty-state">No ${organizationName} members registered yet.</div>`;
    return;
  }

  const loadingState = container.querySelector(".loading-state");
  const emptyState = container.querySelector(".empty-state");
  if (loadingState || emptyState) {
    container.innerHTML = "";
  }

  const existingCards = new Map();
  container.querySelectorAll(".resident-card[data-mac]").forEach((card) => {
    existingCards.set(card.dataset.mac, card);
  });

  const newMacs = new Set(residents.map((d) => d.macAddress));

  existingCards.forEach((card, mac) => {
    if (!newMacs.has(mac)) {
      card.style.opacity = "0";
      card.style.transform = "scale(0.95)";
      setTimeout(() => card.remove(), 200);
    }
  });

  residents.forEach((device) => {
    const existingCard = existingCards.get(device.macAddress);
    if (existingCard) {
      updateResidentCard(existingCard, device);
    } else {
      const newCard = createResidentCard(device);
      newCard.style.opacity = "0";
      newCard.style.transform = "scale(0.95)";
      container.appendChild(newCard);
      requestAnimationFrame(() => {
        newCard.style.transition = "opacity 0.2s ease, transform 0.2s ease";
        newCard.style.opacity = "1";
        newCard.style.transform = "scale(1)";
      });
    }
  });
}

function createPendingItem(device) {
  const item = document.createElement("div");
  item.className = "pending-item";
  item.dataset.mac = device.macAddress;
  item.innerHTML = `
    <div class="pending-info">
      <div class="device-details">
        <strong>${device.name || "Unknown Device"}</strong>
        <span>${device.macAddress}</span>
      </div>
    </div>
    <button class="btn btn-primary" onclick="openModal('${device.macAddress}')">Register</button>
  `;
  return item;
}

function reconcilePending(container, pending) {
  if (!container) return;

  if (pending.length === 0) {
    container.innerHTML = '<div class="empty-state">No new devices nearby</div>';
    return;
  }

  const loadingState = container.querySelector(".loading-state");
  const emptyState = container.querySelector(".empty-state");
  if (loadingState || emptyState) {
    container.innerHTML = "";
  }

  const existingItems = new Map();
  container.querySelectorAll(".pending-item[data-mac]").forEach((item) => {
    existingItems.set(item.dataset.mac, item);
  });

  const newMacs = new Set(pending.map((d) => d.macAddress));

  existingItems.forEach((item, mac) => {
    if (!newMacs.has(mac)) {
      item.style.opacity = "0";
      item.style.transform = "translateX(-10px)";
      setTimeout(() => item.remove(), 200);
    }
  });

  pending.forEach((device) => {
    const existingItem = existingItems.get(device.macAddress);
    if (existingItem) {
      const nameEl = existingItem.querySelector(".device-details strong");
      if (nameEl) nameEl.textContent = device.name || "Unknown Device";
    } else {
      const newItem = createPendingItem(device);
      newItem.style.opacity = "0";
      newItem.style.transform = "translateX(-10px)";
      container.appendChild(newItem);
      requestAnimationFrame(() => {
        newItem.style.transition = "opacity 0.2s ease, transform 0.2s ease";
        newItem.style.opacity = "1";
        newItem.style.transform = "translateX(0)";
      });
    }
  });
}

window.openModal = function (macAddress) {
  selectedMacForRegistration = macAddress;
  const modalMac = document.getElementById("modal-mac");
  const firstName = document.getElementById("device-firstname");
  const lastName = document.getElementById("device-lastname");
  const email = document.getElementById("device-ucsd-email");
  const registrationModal = document.getElementById("registration-modal");

  if (modalMac) modalMac.textContent = macAddress;
  if (firstName) firstName.value = "";
  if (lastName) lastName.value = "";
  if (email) email.value = "";
  if (registrationModal) registrationModal.classList.add("active");
  if (firstName) firstName.focus();
};

window.closeModal = function () {
  const modal = document.getElementById("registration-modal");
  if (modal) modal.classList.remove("active");
  selectedMacForRegistration = null;
};

window.submitRegistration = async function () {
  const firstName = document.getElementById("device-firstname")?.value.trim();
  const lastName = document.getElementById("device-lastname")?.value.trim();
  const ucsdEmail = document.getElementById("device-ucsd-email")?.value.trim().toLowerCase();

  if (!firstName || !lastName || !ucsdEmail) {
    showToast("Please enter first name, last name, and UCSD email", "error");
    return;
  }

  if (!ucsdEmail.endsWith("@ucsd.edu")) {
    showToast("UCSD email must end with @ucsd.edu", "error");
    return;
  }

  if (!selectedMacForRegistration || !convexClient) {
    showToast("Convex client not initialized", "error");
    return;
  }

  const btn = document.querySelector(".modal-footer .btn-primary");
  const originalText = btn?.textContent || "Confirm & Register";
  if (btn) {
    btn.textContent = "Registering...";
    btn.disabled = true;
  }

  try {
    await convexClient.mutation("devices:completeDeviceRegistration", {
      macAddress: selectedMacForRegistration,
      firstName,
      lastName,
      ucsdEmail,
    });

    showToast("Device registered successfully!", "success");
    window.closeModal?.();
  } catch (error) {
    console.error("Registration failed:", error);
    showToast(`Registration failed: ${error.message}`, "error");
  } finally {
    if (btn) {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  }
};

window.openEditModal = function (id, firstName, lastName, ucsdEmail) {
  const editDeviceId = document.getElementById("edit-device-id");
  const editFirstName = document.getElementById("edit-firstname");
  const editLastName = document.getElementById("edit-lastname");
  const editEmail = document.getElementById("edit-ucsd-email");
  const editModal = document.getElementById("edit-modal");

  if (editDeviceId) editDeviceId.value = id;
  if (editFirstName) editFirstName.value = firstName === "undefined" ? "" : firstName;
  if (editLastName) editLastName.value = lastName === "undefined" ? "" : lastName;
  if (editEmail) editEmail.value = ucsdEmail === "undefined" ? "" : ucsdEmail;
  if (editModal) editModal.classList.add("active");

  const logsContainer = document.getElementById("edit-logs");
  if (!logsContainer) return;

  logsContainer.innerHTML = "Loading logs...";
  if (!convexClient) {
    logsContainer.innerHTML = "Convex client not initialized";
    return;
  }

  convexClient.query("devices:getDeviceLogs", { deviceId: id }).then((logs) => {
    if (logs.length === 0) {
      logsContainer.innerHTML = '<div class="edit-log-empty">No logs found.</div>';
      return;
    }

    logsContainer.innerHTML = logs.map((log) => {
      const date = new Date(log.timestamp).toLocaleString();
      return `
        <div class="edit-log-row">
          <div class="edit-log-time">${date}</div>
          <div>${log.details}</div>
        </div>
      `;
    }).join("");
  }).catch((err) => {
    console.error(err);
    logsContainer.innerHTML = "Error loading logs.";
  });
};

window.closeEditModal = function () {
  const editModal = document.getElementById("edit-modal");
  if (editModal) editModal.classList.remove("active");
};

window.submitEdit = async function () {
  if (!window.isAdmin || !window.isAdmin()) {
    showToast("Admin access required", "error");
    return;
  }

  const adminPassword = sessionStorage.getItem("ieee_presence_password");
  if (!adminPassword) {
    showToast("Please log in again as admin", "error");
    return;
  }

  const id = document.getElementById("edit-device-id")?.value;
  const firstName = document.getElementById("edit-firstname")?.value.trim();
  const lastName = document.getElementById("edit-lastname")?.value.trim();
  const ucsdEmail = document.getElementById("edit-ucsd-email")?.value.trim().toLowerCase();

  if (!id || !firstName || !lastName || !ucsdEmail) {
    showToast("First name, last name, and UCSD email are required", "error");
    return;
  }

  if (!ucsdEmail.endsWith("@ucsd.edu")) {
    showToast("UCSD email must end with @ucsd.edu", "error");
    return;
  }

  if (!convexClient) {
    showToast("Convex client not initialized", "error");
    return;
  }

  try {
    await convexClient.mutation("devices:updateDeviceDetails", {
      id,
      firstName,
      lastName,
      ucsdEmail,
      adminPassword,
    });
    showToast("Device updated", "success");
    window.closeEditModal?.();
  } catch (err) {
    console.error(err);
    showToast(`Update failed: ${err.message}`, "error");
  }
};

window.forgetDevice = async function (deviceId, macAddress) {
  if (!confirm(`Are you sure you want to forget this device? This will remove it from the system and unpair it from Bluetooth.\n\nMAC: ${macAddress}`)) {
    return;
  }

  if (!convexClient) {
    showToast("Convex client not initialized", "error");
    return;
  }

  const adminPassword = sessionStorage.getItem("ieee_presence_password");
  if (!adminPassword) {
    showToast("Please log in again as admin", "error");
    return;
  }

  try {
    await convexClient.mutation("devices:deleteDevice", { id: deviceId, adminPassword });
    showToast("Device forgotten successfully", "success");
  } catch (err) {
    console.error(err);
    showToast(`Failed to forget device: ${err.message}`, "error");
  }
};

export function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.className = `toast ${type} active`;

  setTimeout(() => {
    toast.classList.remove("active");
  }, 3000);
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return "Never";

  const diff = (Date.now() - timestamp) / 1000;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

window.addEventListener("click", (event) => {
  const registrationModal = document.getElementById("registration-modal");
  if (event.target === registrationModal) {
    window.closeModal?.();
  }
});
