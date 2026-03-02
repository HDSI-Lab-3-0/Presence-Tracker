import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { authComponent, createAuth } from "./betterAuth";

const http = httpRouter();

// Register Better Auth routes with CORS enabled
authComponent.registerRoutes(http, createAuth, { cors: true });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

function jsonResponse(statusCode: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function getApiKey(request: Request): string {
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return "";
}

function parseOptionalNumber(value: unknown): number | undefined {
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

// OPTIONS /api/change_status - CORS preflight
http.route({
  path: "/api/change_status",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return jsonResponse(200, { ok: true });
  }),
});

// POST /api/change_status - Toggle user presence status
http.route({
  path: "/api/change_status",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKey = getApiKey(request);
      if (!apiKey) {
        return jsonResponse(401, { error: "Missing Bearer API key" });
      }

      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return jsonResponse(400, { error: "Invalid JSON body" });
      }

      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!email) {
        return jsonResponse(400, { error: "Email is required" });
      }

      const latitude = parseOptionalNumber(body.latitude);
      const longitude = parseOptionalNumber(body.longitude);

      if (typeof latitude === "number" && (latitude < -90 || latitude > 90)) {
        return jsonResponse(400, { error: "Latitude must be between -90 and 90" });
      }

      if (typeof longitude === "number" && (longitude < -180 || longitude > 180)) {
        return jsonResponse(400, { error: "Longitude must be between -180 and 180" });
      }

      const result = await ctx.runMutation(api.devices.flipAppStatusByEmail, {
        apiKey,
        email,
        latitude,
        longitude,
      });

      return jsonResponse(200, {
        success: true,
        appStatus: result?.appStatus,
        email: result?.email || email,
        keyVersion: result?.keyVersion,
      });
    } catch (error: unknown) {
      console.error("[http] /api/change_status error", error);
      const message = error instanceof Error ? error.message : "Unable to change status";
      const statusCode = message.includes("outside_boundary") ? 403 : 400;
      return jsonResponse(statusCode, { error: message });
    }
  }),
});

// OPTIONS /api/fetch - CORS preflight
http.route({
  path: "/api/fetch",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return jsonResponse(200, { ok: true });
  }),
});

// POST /api/fetch - Fetch user status
http.route({
  path: "/api/fetch",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKey = getApiKey(request);
      if (!apiKey) {
        return jsonResponse(401, { error: "Missing Bearer API key" });
      }

      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return jsonResponse(400, { error: "Invalid JSON body" });
      }

      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!email) {
        return jsonResponse(400, { error: "Email is required" });
      }

      const result = await ctx.runQuery(api.devices.fetchAppStatusByEmail, {
        apiKey,
        email,
      });

      return jsonResponse(200, {
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
    } catch (error: unknown) {
      console.error("[http] /api/fetch error", error);
      const message = error instanceof Error ? error.message : "Unable to fetch app status";
      return jsonResponse(400, { error: message });
    }
  }),
});

// OPTIONS /api/attendance - CORS preflight
http.route({
  path: "/api/attendance",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return jsonResponse(200, { ok: true });
  }),
});

// POST /api/attendance - Get attendance history
http.route({
  path: "/api/attendance",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const apiKey = getApiKey(request);
      if (!apiKey) {
        return jsonResponse(401, { error: "Missing Bearer API key" });
      }

      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return jsonResponse(400, { error: "Invalid JSON body" });
      }

      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if (!email) {
        return jsonResponse(400, { error: "Email is required" });
      }

      const result = await ctx.runQuery(api.devices.getAttendanceHistory, {
        apiKey,
        email,
      });

      return jsonResponse(200, result);
    } catch (error: unknown) {
      console.error("[http] /api/attendance error", error);
      const message = error instanceof Error ? error.message : "Unable to fetch attendance";
      return jsonResponse(400, { error: message });
    }
  }),
});

export default http;
