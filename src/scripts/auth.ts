// @ts-nocheck
import { initializeApp } from "./dashboard";
import { ConvexClient } from "convex/browser";

const AUTH_SESSION_KEY = "ieee_presence_authenticated";
const AUTH_ROLE_KEY = "ieee_presence_role";
const AUTH_PASSWORD_KEY = "ieee_presence_password";

(function checkAuth() {
  if (sessionStorage.getItem(AUTH_SESSION_KEY) === "true") {
    const role = sessionStorage.getItem(AUTH_ROLE_KEY) || "user";
    showMainApp(role);
  }
})();

async function handleAuth(event) {
  event.preventDefault();

  const passwordInput = document.getElementById("auth-password");
  const errorDiv = document.getElementById("auth-error");
  const submitBtn = document.querySelector(".auth-submit");
  const password = passwordInput?.value || "";

  if (!password.trim()) {
    if (errorDiv) errorDiv.textContent = "Please enter a password";
    passwordInput?.focus();
    return false;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Verifying...";
  }
  if (errorDiv) errorDiv.textContent = "";
  passwordInput?.classList.remove("error");

  try {
    let client = window.convexClient;
    if (!client && window.CONVEX_URL) {
      try {
        client = new ConvexClient(window.CONVEX_URL, {
          skipConvexDeploymentUrlCheck: true,
        });
        window.convexClient = client;
      } catch (initError) {
        console.error("Convex initialization failed in auth:", initError);
      }
    }

    if (!client || typeof client.query !== "function") {
      throw new Error("Backend connection is not configured. Set CONVEX_URL/CONVEX_DEPLOYMENT_URL and restart.");
    }

    const result = await client.query("auth:validatePassword", { password });

    if (result.success) {
      sessionStorage.setItem(AUTH_SESSION_KEY, "true");
      sessionStorage.setItem(AUTH_ROLE_KEY, result.role);

      if (result.role === "admin") {
        sessionStorage.setItem(AUTH_PASSWORD_KEY, password);
      }

      const overlay = document.getElementById("auth-overlay");
      overlay?.classList.add("fade-out");

      setTimeout(() => {
        overlay?.classList.add("hidden");
        showMainApp(result.role);
      }, 300);
    } else {
      if (errorDiv) errorDiv.textContent = result.error || "Incorrect password";
      passwordInput?.classList.add("error");
      if (passwordInput) {
        passwordInput.value = "";
        passwordInput.focus();
      }

      const container = document.querySelector(".auth-container");
      container?.classList.add("shake");
      setTimeout(() => container?.classList.remove("shake"), 500);

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Unlock";
      }
    }
  } catch (err) {
    console.error("Auth error:", err);
    if (errorDiv) errorDiv.textContent = "Authentication failed. Please try again.";

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Unlock";
    }
  }

  return false;
}

window.logout = function () {
  sessionStorage.removeItem(AUTH_SESSION_KEY);
  sessionStorage.removeItem(AUTH_ROLE_KEY);
  sessionStorage.removeItem(AUTH_PASSWORD_KEY);
  window.location.reload();
};

function showMainApp(role) {
  const overlay = document.getElementById("auth-overlay");
  const mainApp = document.getElementById("main-app");

  overlay?.classList.add("fade-out");
  overlay?.classList.add("hidden");

  if (mainApp) {
    mainApp.classList.remove("app-hidden");
    mainApp.classList.add("fade-in");
  }

  applyRolePermissions(role);
  initializeApp();
}

function applyRolePermissions(role) {
  window.userRole = role;
  document.body.classList.remove("role-user", "role-admin");
  document.body.classList.add(`role-${role}`);
}

window.isAdmin = function () {
  return sessionStorage.getItem(AUTH_ROLE_KEY) === "admin";
};

window.handleAuth = handleAuth;
