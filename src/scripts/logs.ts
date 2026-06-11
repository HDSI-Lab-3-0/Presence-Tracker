// @ts-nocheck
import { showToast } from "./dashboard";

let allLogs = [];
let currentView = "by-person";
let selectedPerson = null;
let selectedDate = null;
let personModeSelectedPerson = null;
let dateModeSelectedDate = null;
let allModeViewMode = "by-time";
let allModeSelectedViewMode = "by-time";
let connectionFilter = "all";

window.showLogsView = async function () {
  const mainApp = document.getElementById("main-app");
  const dashboard = mainApp?.querySelector(".dashboard");
  const logsView = document.getElementById("logs-view");

  if (!window.isAdmin?.()) {
    showToast("Admin access required", "error");
    return;
  }

  const adminPassword = sessionStorage.getItem("ieee_presence_password");
  if (!adminPassword) {
    showToast("Please log in again to access logs", "error");
    setTimeout(() => window.logout?.(), 2000);
    return;
  }

  if (dashboard) dashboard.style.display = "none";
  if (logsView) {
    logsView.style.display = "block";
    logsView.classList.remove("logs-hidden");
  }

  document.getElementById("logs-filter-container")?.classList.remove("logs-filters-ready");
  setupEventListeners();
  window.switchTab?.("by-person");
  await fetchLogs();
};

window.hideLogsView = function () {
  const mainApp = document.getElementById("main-app");
  const dashboard = mainApp?.querySelector(".dashboard");
  const logsView = document.getElementById("logs-view");

  if (logsView) {
    logsView.style.display = "none";
    logsView.classList.add("logs-hidden");
  }
  document.getElementById("logs-filter-container")?.classList.remove("logs-filters-ready");
  if (dashboard) dashboard.style.display = "block";
};

async function fetchLogs() {
  const logsContent = document.getElementById("logs-content");
  if (logsContent) {
    logsContent.innerHTML = '<div class="loading-state">Loading logs...</div>';
  }

  try {
    const adminPassword = sessionStorage.getItem("ieee_presence_password") || "";
    let fetchedLogs = [];

    try {
      fetchedLogs = await window.convexClient.query("devices:getAttendanceLogs", { adminPassword });
    } catch (error) {
      console.warn("devices:getAttendanceLogs failed, falling back to logs:getAllStatusLogs", error);
    }

    if (!Array.isArray(fetchedLogs) || fetchedLogs.length === 0) {
      const statusLogs = await window.convexClient.query("logs:getAllStatusLogs", { adminPassword });
      fetchedLogs = Array.isArray(statusLogs)
        ? statusLogs
          .filter((log) => log && log.timestamp)
          .map((log) => ({
            userName: log.personName || "Unknown",
            deviceId: String(log.deviceId || ""),
            status: log.status === "present" ? "present" : "absent",
            timestamp: Number(log.timestamp),
          }))
        : [];
    }

    allLogs = fetchedLogs;
    populatePersonSelect();
    renderCurrentView();
  } catch (error) {
    console.error("Error fetching logs:", error);
    if (logsContent) {
      logsContent.innerHTML = `<div class="empty-state">Error loading logs: ${error.message}</div>`;
    }
  }
}

function setupEventListeners() {
  const personSelect = document.getElementById("person-select");
  const datePicker = document.getElementById("date-picker");
  const allViewModeSelect = document.getElementById("all-view-mode");

  if (personSelect && !personSelect.dataset.setup) {
    personSelect.addEventListener("change", handlePersonChange);
    personSelect.dataset.setup = "true";
  }

  if (datePicker && !datePicker.dataset.setup) {
    datePicker.addEventListener("change", handleDateChange);
    datePicker.dataset.setup = "true";
  }

  if (allViewModeSelect && !allViewModeSelect.dataset.setup) {
    allViewModeSelect.addEventListener("change", handleAllViewModeChange);
    allViewModeSelect.dataset.setup = "true";
  }

  document.querySelectorAll(".connection-filter-sync, #connection-filter").forEach((el) => {
    if (!el.dataset.setup) {
      el.addEventListener("change", handleConnectionFilterChange);
      el.dataset.setup = "true";
    }
  });
}

function syncConnectionFilterSelects(value = connectionFilter) {
  document.querySelectorAll(".connection-filter-sync, #connection-filter").forEach((el) => {
    el.value = value;
  });
}

function handleConnectionFilterChange(e) {
  connectionFilter = e.target.value;
  syncConnectionFilterSelects(connectionFilter);
  populatePersonSelect();
  renderCurrentView();
}

function resolveBluetoothConnectedAtEvent(log) {
  if (log.bluetoothConnectedAtEvent === true) return true;
  if (log.bluetoothConnectedAtEvent === false) return false;
  if (log.bluetoothStatusAtEvent === "present") return true;
  if (log.bluetoothStatusAtEvent === "absent") return false;
  if (log.source === "app+bluetooth") return true;
  if (
    log.verifiedBy === "bluetooth_immediate"
    || log.verifiedBy === "bluetooth_followup"
    || log.verifiedBy === "bluetooth_disconnect"
  ) {
    return true;
  }
  const connectionType = inferConnectionType(log);
  if (connectionType === "bluetooth") {
    return log.action === "check_in" || log.status === "present";
  }
  if (
    connectionType === "manual"
    && (log.verificationStatus === "unverified" || log.verificationStatus === "expired")
    && log.verifiedBy === "none"
  ) {
    return false;
  }
  return null;
}

function inferConnectionType(log) {
  if (log.connectionType) return log.connectionType;
  if (log.origin === "bluetooth" || log.source === "bluetooth") return "bluetooth";
  if (log.origin === "app" || log.source === "app" || log.source === "app+bluetooth") return "manual";
  if (log.origin === "system" || log.source === "system") return "system";
  return null;
}

function actionLabel(log) {
  if (log.action === "check_out") return "check-out";
  if (log.action === "check_in") return "check-in";
  return log.status === "present" ? "presence" : "absence";
}

function getFilteredLogs() {
  if (connectionFilter === "all") return allLogs;
  return allLogs.filter((log) => inferConnectionType(log) === connectionFilter);
}

function populatePersonSelect() {
  const personSelect = document.getElementById("person-select");
  if (!personSelect) return;

  const persons = [...new Set(getFilteredLogs().map((log) => log.userName).filter(Boolean))].sort();

  personSelect.innerHTML = '<option value="">-- Choose a person --</option>';
  persons.forEach((person) => {
    const option = document.createElement("option");
    option.value = person;
    option.textContent = person;
    personSelect.appendChild(option);
  });
}

function handlePersonChange(e) {
  selectedPerson = e.target.value;
  personModeSelectedPerson = e.target.value;
  renderCurrentView();
}

function handleDateChange(e) {
  selectedDate = e.target.value;
  dateModeSelectedDate = e.target.value;
  renderCurrentView();
}

function handleAllViewModeChange(e) {
  allModeViewMode = e.target.value;
  allModeSelectedViewMode = e.target.value;
  renderCurrentView();
}

window.switchTab = function (tabName) {
  currentView = tabName;

  document.querySelectorAll(".log-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  const personFilter = document.getElementById("person-filter");
  const dateFilter = document.getElementById("date-filter");
  const allFilter = document.getElementById("all-filter");
  const personSelect = document.getElementById("person-select");
  const datePicker = document.getElementById("date-picker");
  const allViewModeSelect = document.getElementById("all-view-mode");

  if (currentView === "by-person") {
    personFilter?.classList.remove("filter-hidden");
    dateFilter?.classList.add("filter-hidden");
    allFilter?.classList.add("filter-hidden");
    dateModeSelectedDate = selectedDate;
    selectedPerson = personModeSelectedPerson;
    if (personSelect) personSelect.value = personModeSelectedPerson || "";
  } else if (currentView === "by-date") {
    personFilter?.classList.add("filter-hidden");
    dateFilter?.classList.remove("filter-hidden");
    allFilter?.classList.add("filter-hidden");
    personModeSelectedPerson = selectedPerson;
    selectedDate = dateModeSelectedDate;
    if (datePicker) datePicker.value = dateModeSelectedDate || "";
  } else {
    personFilter?.classList.add("filter-hidden");
    dateFilter?.classList.add("filter-hidden");
    allFilter?.classList.remove("filter-hidden");
    allModeViewMode =
      allModeSelectedViewMode === "by-person-per-day"
        ? "by-day-per-person"
        : (allModeSelectedViewMode || "by-time");
    allModeSelectedViewMode = allModeViewMode;
    if (allViewModeSelect) allViewModeSelect.value = allModeViewMode;
  }

  syncConnectionFilterSelects();
  document.getElementById("logs-filter-container")?.classList.add("logs-filters-ready");
  renderCurrentView();
};

function renderCurrentView() {
  const logsContent = document.getElementById("logs-content");
  if (!logsContent) return;

  const filteredLogs = getFilteredLogs();

  if (allLogs.length === 0) {
    logsContent.innerHTML = '<div class="empty-state">No status change logs found.</div>';
    return;
  }

  if (filteredLogs.length === 0) {
    logsContent.innerHTML = '<div class="empty-state">No logs match this connection filter.</div>';
    return;
  }

  if (currentView === "by-person") {
    renderLogsByPerson(logsContent);
  } else if (currentView === "by-date") {
    renderLogsByDate(logsContent);
  } else if (allModeViewMode === "by-time") {
    renderLogsByTime(logsContent);
  } else {
    renderLogsByDayPerPerson(logsContent);
  }
}

function renderLogsByPerson(container) {
  if (!selectedPerson) {
    container.innerHTML = '<div class="empty-state">Please select a person to view their logs.</div>';
    return;
  }

  const personLogs = getFilteredLogs().filter((log) => log.userName === selectedPerson);
  if (personLogs.length === 0) {
    container.innerHTML = '<div class="empty-state">No logs found for this person.</div>';
    return;
  }

  personLogs.sort((a, b) => b.timestamp - a.timestamp);
  container.innerHTML = `
    <div class="person-single-view">
      <div class="person-single-header">
        <strong>${escapeHtml(selectedPerson)}</strong>
        <span class="log-count">${personLogs.length} entries</span>
      </div>
      <div class="logs-list">${personLogs.map((log) => renderLogEntry(log, true)).join("")}</div>
    </div>
  `;
}

function renderLogsByDate(container) {
  if (!selectedDate) {
    container.innerHTML = '<div class="empty-state">Please select a date to view logs.</div>';
    return;
  }

  const startDate = new Date(selectedDate);
  startDate.setUTCHours(0, 0, 0, 0);

  const endDate = new Date(selectedDate);
  endDate.setUTCHours(23, 59, 59, 999);

  const dateLogs = getFilteredLogs().filter((log) => {
    const logDate = new Date(log.timestamp);
    return logDate >= startDate && logDate <= endDate;
  });

  if (dateLogs.length === 0) {
    container.innerHTML = '<div class="empty-state">No logs found for this date.</div>';
    return;
  }

  dateLogs.sort((a, b) => b.timestamp - a.timestamp);

  container.innerHTML = `
    <div class="date-view">
      <div class="date-header">
        <strong>${escapeHtml(new Date(selectedDate).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" }))}</strong>
        <span class="log-count">${dateLogs.length} entries</span>
      </div>
      <div class="logs-list">${dateLogs.map((log) => renderLogEntry(log)).join("")}</div>
    </div>
  `;
}

function renderLogsByTime(container) {
  const sortedLogs = [...getFilteredLogs()].sort((a, b) => b.timestamp - a.timestamp);
  container.innerHTML = `
    <div class="all-time-view">
      <div class="all-time-header">
        <strong>All Logs</strong>
        <span class="log-count">${sortedLogs.length} entries</span>
      </div>
      <div class="logs-list">${sortedLogs.map((log) => renderLogEntry(log, false)).join("")}</div>
    </div>
  `;
}

function pacificDateKeyFromTimestamp(timestamp) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function renderLogsByDayPerPerson(container) {
  const logs = getFilteredLogs();
  const dayGroups = {};

  logs.forEach((log) => {
    const dateKey = pacificDateKeyFromTimestamp(log.timestamp);
    if (!dayGroups[dateKey]) {
      dayGroups[dateKey] = {};
    }
    const person = log.userName || "Unknown";
    if (!dayGroups[dateKey][person]) {
      dayGroups[dateKey][person] = [];
    }
    dayGroups[dateKey][person].push(log);
  });

  const sortedDays = Object.keys(dayGroups).sort(
    (a, b) => new Date(b).getTime() - new Date(a).getTime(),
  );

  let html = "";
  let totalEntries = logs.length;

  sortedDays.forEach((dateKey) => {
    const personMap = dayGroups[dateKey];
    const persons = Object.keys(personMap).sort();
    const dayCount = persons.reduce((sum, person) => sum + personMap[person].length, 0);

    html += `
      <div class="day-group-all">
        <div class="date-group-header day-group-header">
          <span class="date-label">${escapeHtml(dateKey)}</span>
          <span class="log-count">${dayCount} entries</span>
        </div>
        <div class="day-person-groups">
    `;

    persons.forEach((person) => {
      const personLogs = personMap[person];
      personLogs.sort((a, b) => b.timestamp - a.timestamp);

      html += `
        <div class="person-group-all person-group-nested">
          <div class="person-header">
            <div class="person-info"><strong>${escapeHtml(person)}</strong></div>
            <span class="log-count">${personLogs.length}</span>
          </div>
          <div class="logs-list">${personLogs.map((log) => renderLogEntry(log, true)).join("")}</div>
        </div>
      `;
    });

    html += "</div></div>";
  });

  if (html === "") {
    container.innerHTML = '<div class="empty-state">No logs found.</div>';
    return;
  }

  container.innerHTML = `
    <div class="all-day-per-person-view">
      <div class="all-view-header">
        <strong>All Logs by Day, Then Person</strong>
        <span class="log-count">${totalEntries} total entries</span>
      </div>
      ${html}
    </div>
  `;
}

function formatCompactTimestamp(timestamp) {
  return new Date(timestamp).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Short note only when badges alone do not convey it. */
function formatLogEntryNote(log, connectionType) {
  const btConnected = resolveBluetoothConnectedAtEvent(log);
  if (connectionType === "bluetooth") {
    if (log.syntheticReason === "current_bluetooth_session") {
      return "Bluetooth connected now";
    }
    return log.action === "check_out" || log.status === "absent"
      ? "Bluetooth disconnected"
      : "Bluetooth connected";
  }
  if (connectionType === "manual") {
    if (btConnected === true) return `App ${actionLabel(log)} with Bluetooth in range`;
    if (btConnected === false) return `App ${actionLabel(log)} with Bluetooth away`;
    if (log.verificationStatus === "pending") return "Awaiting Bluetooth";
    if (log.verificationStatus === "unverified") return "Bluetooth not verified";
    if (log.verificationStatus === "expired") return "Checkout not verified";
    if (log.label) return log.label;
    return "";
  }
  if (connectionType === "system") return "System";
  if (log.label) return log.label;
  return "";
}

function renderLogEntry(log, hidePerson = false) {
  const statusClass = log.status === "present" ? "present" : "absent";
  const statusText = log.action === "check_out"
    ? "Check Out"
    : log.action === "check_in"
      ? "Check In"
      : (log.status === "present" ? "Present" : "Absent");
  const connectionType = inferConnectionType(log);
  const connectionBadge = formatConnectionBadge(log, connectionType);
  const btBadge =
    connectionType === "manual" ? formatBluetoothAtEventBadge(log, connectionType) : "";
  const note = formatLogEntryNote(log, connectionType);

  return `
    <div class="log-entry">
      <div class="log-entry-main">
        ${!hidePerson ? `<span class="log-person-inline">${escapeHtml(log.userName)}</span>` : ""}
        <time class="log-time">${escapeHtml(formatCompactTimestamp(log.timestamp))}</time>
        ${note ? `<span class="log-note">${escapeHtml(note)}</span>` : ""}
        <div class="log-badges">
          ${connectionBadge}
          <span class="status-badge ${statusClass}">${statusText}</span>
          ${btBadge}
        </div>
      </div>
    </div>
  `;
}

window.exportToCSV = function () {
  if (!window.isAdmin?.()) {
    showToast("Admin access required", "error");
    return;
  }

  let logsToExport = [];
  let filenamePrefix = "logs";

  if (currentView === "by-person") {
    if (!selectedPerson) {
      showToast("Please select a person to export", "error");
      return;
    }
    logsToExport = getFilteredLogs().filter((log) => log.userName === selectedPerson);
    filenamePrefix = `logs-${encodeURIComponent(selectedPerson)}`;
  } else if (currentView === "by-date") {
    if (!selectedDate) {
      showToast("Please select a date to export", "error");
      return;
    }

    const startDate = new Date(selectedDate);
    startDate.setUTCHours(0, 0, 0, 0);
    const endDate = new Date(selectedDate);
    endDate.setUTCHours(23, 59, 59, 999);

    logsToExport = getFilteredLogs().filter((log) => {
      const logDate = new Date(log.timestamp);
      return logDate >= startDate && logDate <= endDate;
    });
    filenamePrefix = `logs-${selectedDate}`;
  } else {
    logsToExport = [...getFilteredLogs()];
    filenamePrefix = "logs-all";
  }

  if (logsToExport.length === 0) {
    showToast("No logs to export", "error");
    return;
  }

  const sortedLogs = logsToExport.sort((a, b) => b.timestamp - a.timestamp);
  let csvContent = "Person Name,Device ID,Action,Status,Connection,BluetoothAtEvent,Source,Verification,Timestamp\n";

  sortedLogs.forEach((log) => {
    const date = new Date(log.timestamp);
    const pacificDateStr = date.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
    csvContent += `"${escapeCsv(log.userName)}","${escapeCsv(log.deviceId)}","${escapeCsv(log.action || "")}","${escapeCsv(log.status)}","${escapeCsv(formatConnectionLabel(log, inferConnectionType(log)))}","${escapeCsv(formatBluetoothAtEventCsv(log, inferConnectionType(log)))}","${escapeCsv(formatSourceText(log))}","${escapeCsv(formatVerificationText(log))}","${escapeCsv(pacificDateStr)}"\n`;
  });

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.setAttribute("href", url);
  link.setAttribute("download", `${filenamePrefix}-${Date.now()}.csv`);
  link.style.visibility = "hidden";

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast("Logs exported successfully", "success");
};

function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escapeCsv(text) {
  if (text === null || text === undefined) return "";
  return String(text).replace(/"/g, '""');
}

function formatSourceText(log) {
  if (log.origin === "system" || log.source === "system") return "Source: system";
  if (log.origin === "app" || log.source === "app" || log.source === "app+bluetooth") return "Source: app";
  if (log.origin === "bluetooth" || log.source === "bluetooth") return "Source: bluetooth";
  return "";
}

function formatConnectionLabel(log, connectionType) {
  if (connectionType === "bluetooth") return "Bluetooth";
  if (connectionType === "manual") {
    return resolveBluetoothConnectedAtEvent(log) === true
      ? "App + Bluetooth"
      : "Manual (app)";
  }
  if (connectionType === "system") return "System";
  return "";
}

function formatConnectionBadge(log, connectionType) {
  if (connectionType === "bluetooth") {
    return '<span class="log-connection-badge bluetooth">Bluetooth</span>';
  }
  if (connectionType === "manual") {
    if (resolveBluetoothConnectedAtEvent(log) === true) {
      return '<span class="log-connection-badge app-bluetooth">App + Bluetooth</span>';
    }
    return '<span class="log-connection-badge manual">Manual</span>';
  }
  if (connectionType === "system") {
    return '<span class="log-connection-badge system">System</span>';
  }
  return "";
}

function formatBluetoothAtEventBadge(log, connectionType) {
  if (connectionType !== "manual") return "";
  const btConnected = resolveBluetoothConnectedAtEvent(log);
  if (btConnected === true) {
    return '<span class="log-bt-badge connected">BT in range</span>';
  }
  if (btConnected === false) {
    return '<span class="log-bt-badge disconnected">BT away</span>';
  }
  return '<span class="log-bt-badge unknown">BT ?</span>';
}

function formatBluetoothAtEventCsv(log, connectionType) {
  if (connectionType !== "manual") return "";
  const btConnected = resolveBluetoothConnectedAtEvent(log);
  if (btConnected === true) return "Connected";
  if (btConnected === false) return "Not connected";
  return "Unknown";
}

function formatVerificationText(log) {
  if (log.verifiedBy === "manual") {
    return resolveBluetoothConnectedAtEvent(log) === true
      ? "Verification: app with bluetooth in range"
      : "Verification: manual (app)";
  }
  if (log.verificationStatus === "verified") {
    if (log.source === "app+bluetooth") return "Verification: verified with bluetooth";
    if (log.origin === "app" || log.source === "app") return "Verification: verified (app)";
    return "Verification: verified";
  }
  if (log.verificationStatus === "pending") return "Verification: waiting for bluetooth";
  if (log.verificationStatus === "unverified") return "Verification: not verified";
  if (log.verificationStatus === "expired") return "Verification: expired";
  if (log.verificationStatus === "inferred") return "Verification: inferred from bluetooth history";
  if (log.source === "app+bluetooth") return "Verification: verified with bluetooth";
  if (log.source === "app") return "Verification: app only";
  if (log.source === "bluetooth") return "Verification: bluetooth";
  return "";
}
