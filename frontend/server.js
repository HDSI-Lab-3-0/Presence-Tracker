#!/usr/bin/env bun

const http = require("http");
const path = require("path");
const fs = require("fs/promises");

const FRONTEND_DIR = __dirname;
const PORT = Number(process.env.PORT || 3132);
const HOST = "0.0.0.0";

function resolveConvexUrl() {
  const mode = (process.env.CONVEX_URL_MODE || "convex").toLowerCase();
  if (mode === "selfhosted") {
    return process.env.CONVEX_SELF_HOSTED_URL || "";
  }
  return process.env.CONVEX_DEPLOYMENT_URL || "";
}

const convexUrl = resolveConvexUrl();
const deploymentMode = process.env.DEPLOYMENT_MODE || process.env.CONVEX_URL_MODE || "convex";
const organizationName = process.env.ORGANIZATION_NAME || "Presence Tracker";

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function getApiKey(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return "";
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function parseOptionalNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

async function runConvexMutation(functionPath, args) {
  if (!convexUrl) {
    throw new Error("Convex URL is not configured");
  }

  const response = await fetch(`${convexUrl}/api/mutation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path: functionPath,
      args,
    }),
  });

  let result;
  try {
    result = await response.json();
  } catch (_error) {
    throw new Error(`Convex returned non-JSON response (${response.status})`);
  }

  if (!response.ok || result?.status === "error") {
    const message = result?.errorMessage || result?.errorData || `Convex request failed (${response.status})`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return result?.value;
}

async function runConvexQuery(functionPath, args) {
  if (!convexUrl) {
    throw new Error("Convex URL is not configured");
  }

  const response = await fetch(`${convexUrl}/api/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path: functionPath,
      args,
    }),
  });

  let result;
  try {
    result = await response.json();
  } catch (_error) {
    throw new Error(`Convex returned non-JSON response (${response.status})`);
  }

  if (!response.ok || result?.status === "error") {
    const message = result?.errorMessage || result?.errorData || `Convex request failed (${response.status})`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return result?.value;
}

const configScript = [
  `window.CONVEX_URL = ${JSON.stringify(convexUrl)};`,
  `window.DEPLOYMENT_MODE = ${JSON.stringify(deploymentMode)};`,
  `window.ORGANIZATION_NAME = ${JSON.stringify(organizationName)};`,
].join("\n");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".gif": "image/gif",
  ".txt": "text/plain; charset=utf-8",
};

function getMimeType(filePath) {
  const ext = path.extname(filePath);
  return MIME_TYPES[ext] || "application/octet-stream";
}

function toFilesystemPath(requestPath) {
  const normalized = path.normalize(requestPath);
  const resolved = path.resolve(FRONTEND_DIR, `.${normalized}`);
  if (!resolved.startsWith(FRONTEND_DIR)) {
    return null;
  }
  return resolved;
}

async function readFileMaybe(resolvedPath) {
  try {
    const stats = await fs.stat(resolvedPath);
    if (stats.isDirectory()) {
      const indexPath = path.join(resolvedPath, "index.html");
      return readFileMaybe(indexPath);
    }
    const data = await fs.readFile(resolvedPath);
    return { data, path: resolvedPath };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!req || !req.url) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    const method = req.method || "GET";
    const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    if (pathname === "/api/change_status") {
      if (method === "OPTIONS") {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (method !== "POST") {
        writeJson(res, 405, { error: "Method not allowed" });
        return;
      }

      try {
        const apiKey = getApiKey(req);
        if (!apiKey) {
          writeJson(res, 401, { error: "Missing Bearer API key" });
          return;
        }

        const body = await readJsonBody(req);
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!email) {
          writeJson(res, 400, { error: "Email is required" });
          return;
        }

        const latitude = parseOptionalNumber(body.latitude);
        const longitude = parseOptionalNumber(body.longitude);

        if (typeof latitude === "number" && (latitude < -90 || latitude > 90)) {
          writeJson(res, 400, { error: "Latitude must be between -90 and 90" });
          return;
        }

        if (typeof longitude === "number" && (longitude < -180 || longitude > 180)) {
          writeJson(res, 400, { error: "Longitude must be between -180 and 180" });
          return;
        }

        const result = await runConvexMutation("devices:flipAppStatusByEmail", {
          apiKey,
          email,
          latitude,
          longitude,
        });

        writeJson(res, 200, {
          success: true,
          appStatus: result?.appStatus,
          email: result?.email || email,
          keyVersion: result?.keyVersion,
        });
        return;
      } catch (error) {
        console.error("[frontend] /api/change_status error", error);
        const message = error.message || "Unable to change status";
        const statusCode = message.includes("outside_boundary") ? 403 : 400;
        writeJson(res, statusCode, { error: message });
        return;
      }
    }

    if (pathname === "/api/fetch") {
      if (method === "OPTIONS") {
        writeJson(res, 200, { ok: true });
        return;
      }

      if (method !== "POST") {
        writeJson(res, 405, { error: "Method not allowed" });
        return;
      }

      try {
        const apiKey = getApiKey(req);
        if (!apiKey) {
          writeJson(res, 401, { error: "Missing Bearer API key" });
          return;
        }

        const body = await readJsonBody(req);
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!email) {
          writeJson(res, 400, { error: "Email is required" });
          return;
        }

        const result = await runConvexQuery("devices:fetchAppStatusByEmail", {
          apiKey,
          email,
        });

        writeJson(res, 200, {
          success: true,
          email: result?.email || email,
          appStatus: result?.appStatus || "absent",
          keyVersion: result?.keyVersion,
          boundaryEnabled: result?.boundaryEnabled === true,
          boundaryLatitude: result?.boundaryLatitude ?? null,
          boundaryLongitude: result?.boundaryLongitude ?? null,
          boundaryRadius: result?.boundaryRadius,
          boundaryRadiusUnit: result?.boundaryRadiusUnit || "meters",
        });
        return;
      } catch (error) {
        console.error("[frontend] /api/fetch error", error);
        writeJson(res, 400, { error: error.message || "Unable to fetch app status" });
        return;
      }
    }

    if (method === "GET" && pathname === "/config.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(configScript);
      return;
    }

    const targetPath = pathname === "/" ? "/index.html" : pathname;
    const resolvedPath = toFilesystemPath(targetPath);

    if (!resolvedPath) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    const fileResult = await readFileMaybe(resolvedPath);

    if (!fileResult) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    if (method === "HEAD") {
      res.writeHead(200, { "Content-Type": getMimeType(fileResult.path) });
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": getMimeType(fileResult.path),
      "Cache-Control": pathname.startsWith("/assets") ? "public, max-age=86400" : "no-cache",
    });
    res.end(fileResult.data);
  } catch (error) {
    console.error("[frontend] server error", error);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Frontend server listening on http://${HOST}:${PORT}`);
});
