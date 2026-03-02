import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const publicDir = path.join(root, "public");
const pwaDir = path.join(publicDir, "pwa");

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadEnvFile(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, eqIndex).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }

      let rawValue = trimmed.slice(eqIndex + 1);
      const hashIndex = rawValue.indexOf(" #");
      if (hashIndex >= 0) {
        rawValue = rawValue.slice(0, hashIndex);
      }
      process.env[key] = stripQuotes(rawValue);
    }
  } catch {
    // File may not exist; ignore.
  }
}

await loadEnvFile(path.join(root, ".env"));
await loadEnvFile(path.join(root, ".env.local"));

function resolveConvexUrl() {
  if (process.env.FRONTEND_CONVEX_URL) {
    return process.env.FRONTEND_CONVEX_URL;
  }

  const mode = (process.env.CONVEX_URL_MODE || process.env.DEPLOYMENT_MODE || "convex").toLowerCase();
  if (mode === "selfhosted") {
    return process.env.CONVEX_SELF_HOSTED_URL || "";
  }

  if (process.env.CONVEX_DEPLOYMENT_URL) {
    return process.env.CONVEX_DEPLOYMENT_URL;
  }

  if (process.env.CONVEX_URL) {
    return process.env.CONVEX_URL;
  }

  return process.env.CONVEX_DEPLOYMENT_URL || "";
}

function ensureHttpAccessibleUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    return "";
  }

  if (url.includes(".convex.cloud")) {
    return url.replace(".convex.cloud", ".convex.site");
  }

  return url;
}

function resolveConvexSiteUrl(convexUrl) {
  if (process.env.FRONTEND_CONVEX_SITE_URL) {
    return process.env.FRONTEND_CONVEX_SITE_URL;
  }
  if (typeof convexUrl === "string" && convexUrl.includes(".convex.cloud")) {
    return convexUrl.replace(".convex.cloud", ".convex.site").replace("/api/query", "").replace("/api/mutation", "");
  }
  if (process.env.CONVEX_SITE_URL) {
    return process.env.CONVEX_SITE_URL;
  }
  return "";
}

function resolveConvexAuthUrl(convexUrl, convexSiteUrl) {
  if (process.env.FRONTEND_CONVEX_AUTH_URL) {
    return ensureHttpAccessibleUrl(process.env.FRONTEND_CONVEX_AUTH_URL);
  }
  if (process.env.CONVEX_AUTH_URL) {
    return ensureHttpAccessibleUrl(process.env.CONVEX_AUTH_URL);
  }
  if (typeof convexUrl === "string" && convexUrl.trim()) {
    return ensureHttpAccessibleUrl(
      convexUrl.replace("/api/query", "").replace("/api/mutation", "")
    );
  }
  return ensureHttpAccessibleUrl(convexSiteUrl) || "";
}

const convexUrl = resolveConvexUrl();
const convexSiteUrl = resolveConvexSiteUrl(convexUrl);
const convexAuthUrl = resolveConvexAuthUrl(convexUrl, convexSiteUrl);
const deploymentMode = process.env.DEPLOYMENT_MODE || process.env.CONVEX_URL_MODE || "convex";
const organizationName = process.env.ORGANIZATION_NAME || "Presence Tracker";

const configScript = [
  `window.CONVEX_URL = ${JSON.stringify(convexUrl)};`,
  `window.CONVEX_SITE_URL = ${JSON.stringify(convexSiteUrl)};`,
  `window.CONVEX_AUTH_URL = ${JSON.stringify(convexAuthUrl)};`,
  `window.DEPLOYMENT_MODE = ${JSON.stringify(deploymentMode)};`,
  `window.ORGANIZATION_NAME = ${JSON.stringify(organizationName)};`,
].join("\n");

await mkdir(pwaDir, { recursive: true });
await writeFile(path.join(publicDir, "config.js"), `${configScript}\n`, "utf8");
await writeFile(path.join(pwaDir, "config.js"), `${configScript}\n`, "utf8");

console.log(`[config] Generated runtime config with mode=${deploymentMode}`);
