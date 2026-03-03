import { v } from "convex/values";
import { action, mutation, query, internalMutation } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { authComponent } from "./betterAuth";

const GRACE_PERIOD_SECONDS = 300;
const DEVICE_EXPIRATION_MS = GRACE_PERIOD_SECONDS * 1000;
const UCSD_EMAIL_DOMAIN = "@ucsd.edu";
const APP_API_KEY_LENGTH = 48;
const METERS_PER_MILE = 1609.344;
const DEFAULT_BOUNDARY_RADIUS_METERS = 100;
const DEFAULT_BOUNDARY_RADIUS_UNIT = "meters" as const;

type CleanupResult = { deletedCount: number; deletedMacs: string[] };

type DeleteResult = { success: boolean; macAddress?: string | null };

const isValidUcsdEmail = (email: string) => {
  const normalized = email.trim().toLowerCase();
  return normalized.endsWith(UCSD_EMAIL_DOMAIN) && normalized.length > UCSD_EMAIL_DOMAIN.length;
};

const normalizeEmail = (email?: string | null) => {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
};

const isAdminEmailMatch = (email?: string | null) => {
  // @ts-ignore - process.env is available in Convex functions
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  const currentEmail = normalizeEmail(email);
  return Boolean(adminEmail) && Boolean(currentEmail) && adminEmail === currentEmail;
};

const requireAdmin = (adminPassword: string) => {
  // @ts-ignore - process.env is available in Convex functions
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || adminPassword !== expected) {
    throw new Error("Admin access required");
  }
};

const hasBoundaryAdminAccess = async (ctx: any) => {
  const authUser = await authComponent.getAuthUser(ctx);
  return isAdminEmailMatch(authUser?.email);
};

const randomKey = (length: number) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
};

const normalizeBoundaryRadiusUnit = (unit?: string) =>
  unit === "miles" ? "miles" : DEFAULT_BOUNDARY_RADIUS_UNIT;

const boundaryRadiusToMeters = (radius: number, unit?: string) => {
  const normalizedUnit = normalizeBoundaryRadiusUnit(unit);
  return normalizedUnit === "miles" ? radius * METERS_PER_MILE : radius;
};

const toRadians = (value: number) => (value * Math.PI) / 180;

const getDistanceMeters = (
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
) => {
  const earthRadiusMeters = 6371000;
  const latitudeDelta = toRadians(latitudeB - latitudeA);
  const longitudeDelta = toRadians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitudeA)) * Math.cos(toRadians(latitudeB)) * Math.sin(longitudeDelta / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
};

const buildAppConfigResponse = (appConfig: any) => ({
  apiKey: appConfig?.apiKey || "",
  keyVersion: appConfig?.keyVersion || 0,
  routePath: "/api/change_status",
  fetchRoutePath: "/api/fetch",
  boundaryEnabled: appConfig?.boundaryEnabled === true,
  boundaryLatitude: typeof appConfig?.boundaryLatitude === "number" ? appConfig.boundaryLatitude : null,
  boundaryLongitude: typeof appConfig?.boundaryLongitude === "number" ? appConfig.boundaryLongitude : null,
  boundaryRadius:
    typeof appConfig?.boundaryRadius === "number" && appConfig.boundaryRadius > 0
      ? appConfig.boundaryRadius
      : DEFAULT_BOUNDARY_RADIUS_METERS,
  boundaryRadiusUnit: normalizeBoundaryRadiusUnit(appConfig?.boundaryRadiusUnit),
});

const getOrCreateAppConfig = async (ctx: any) => {
  const existing = await ctx.db.query("appConfig").first();
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const apiKey = randomKey(APP_API_KEY_LENGTH);
  const id = await ctx.db.insert("appConfig", {
    apiKey,
    keyVersion: 1,
    rotatedAt: now,
    boundaryEnabled: false,
    boundaryRadius: DEFAULT_BOUNDARY_RADIUS_METERS,
    boundaryRadiusUnit: DEFAULT_BOUNDARY_RADIUS_UNIT,
  });

  return {
    _id: id,
    apiKey,
    keyVersion: 1,
    rotatedAt: now,
    boundaryEnabled: false,
    boundaryRadius: DEFAULT_BOUNDARY_RADIUS_METERS,
    boundaryRadiusUnit: DEFAULT_BOUNDARY_RADIUS_UNIT,
  };
};

const deleteDeviceAndLogs = async (
  ctx: any,
  deviceId: Id<"devices">
): Promise<DeleteResult> => {
  const device = await ctx.db.get(deviceId);
  if (!device) {
    return { success: false };
  }

  const relatedLogs = await ctx.db
    .query("deviceLogs")
    .withIndex("by_deviceId", (q: any) => q.eq("deviceId", deviceId))
    .collect();

  for (const log of relatedLogs) {
    await ctx.db.delete(log._id);
  }

  await ctx.db.delete(deviceId);

  return { success: true, macAddress: device.macAddress };
};

const cleanupExpiredDevicesCore = async (ctx: any): Promise<CleanupResult> => {
  const now = Date.now();

  const devices = await ctx.db.query("devices").collect();
  const expiredDevices = devices.filter((device: Doc<"devices">) => {
    if (!device.pendingRegistration) {
      return false;
    }

    const gracePeriodEnd = device.gracePeriodEnd ?? device.firstSeen + DEVICE_EXPIRATION_MS;
    return gracePeriodEnd <= now;
  });

  const deletedMacs: string[] = [];

  for (const device of expiredDevices) {
    try {
      const result = await deleteDeviceAndLogs(ctx, device._id);
      if (result.success && result.macAddress) {
        deletedMacs.push(result.macAddress);
      }
    } catch (error) {
      console.error("Failed to delete expired device", {
        deviceId: device._id,
        error,
      });
    }
  }

  return { deletedCount: deletedMacs.length, deletedMacs };
};

export const getOrganizationName = query({
  args: {},
  handler: async (ctx) => {
    // @ts-ignore - process.env is available in Convex functions
    return process.env.ORGANIZATION_NAME || "Presence Tracker";
  },
});

export const getDeviceLogs = query({
  args: { deviceId: v.id("devices") },
  handler: async (ctx: any, args: any) => {
    return await ctx.db
      .query("deviceLogs")
      .withIndex("by_deviceId", (q: any) => q.eq("deviceId", args.deviceId))
      .order("desc")
      .take(20);
  },
});

export const getDevices = query({
  args: {},
  handler: async (ctx) => {
    const devices = await ctx.db.query("devices").collect();
    const mappedDevices = devices.map(
      (device: Doc<"devices">) => ({
        _id: device._id,
        macAddress: device.macAddress,
        firstName: device.firstName,
        lastName: device.lastName,
        ucsdEmail: device.ucsdEmail,
        name: device.firstName && device.lastName ? `${device.firstName} ${device.lastName}` : device.name,
        status: device.status,
        appStatus: device.appStatus,
        appLastSeen: device.appLastSeen,
        lastSeen: device.lastSeen,
        connectedSince: device.connectedSince,
        pendingRegistration: device.pendingRegistration,
      }),
    );
    return mappedDevices;
  },
});

export const upsertDevice = mutation({
  args: {
    macAddress: v.string(),
    name: v.string(),
    status: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const existingDevice = await ctx.db
      .query("devices")
      .withIndex("by_macAddress", (q: any) => q.eq("macAddress", args.macAddress))
      .first();

    const now = Date.now();

    if (existingDevice) {
      await ctx.db.patch(existingDevice._id, {
        name: args.name,
        status: args.status,
        lastSeen: now,
      });
      await ctx.db.insert("deviceLogs", {
        deviceId: existingDevice._id,
        changeType: "update",
        timestamp: now,
        details: `Name updated to: ${args.name}`
      });
      return { ...existingDevice, name: args.name, status: args.status, lastSeen: now };
    } else {
      // Fix: New devices should be pending by default
      const gracePeriodEnd = now + GRACE_PERIOD_SECONDS * 1000;
      const deviceId = await ctx.db.insert("devices", {
        macAddress: args.macAddress,
        name: args.name,
        status: args.status,
        lastSeen: now,
        firstSeen: now,
        gracePeriodEnd,
        pendingRegistration: true,
      });
      await ctx.db.insert("deviceLogs", {
        deviceId,
        changeType: "create",
        timestamp: now,
        details: `Device created: ${args.name}`
      });
      return {
        _id: deviceId,
        macAddress: args.macAddress,
        name: args.name,
        status: args.status,
        lastSeen: now,
        firstSeen: now,
        gracePeriodEnd,
        pendingRegistration: true,
      };
    }
  },
});

export const updateDeviceStatus = mutation({
  args: {
    macAddress: v.string(),
    status: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const existingDevice = await ctx.db
      .query("devices")
      .withIndex("by_macAddress", (q: any) => q.eq("macAddress", args.macAddress))
      .first();

    if (!existingDevice) {
      throw new Error(`Device with MAC address ${args.macAddress} not found`);
    }

    const now = Date.now();

    // Note: We no longer delete pending devices when they go absent
    // They will remain in the database for manual review

    // Logic for connectedSince
    let connectedSince = existingDevice.connectedSince;
    if (args.status === "present" && existingDevice.status !== "present") {
      // Just connected
      connectedSince = now;
    }
    // If staying present, keep connectedSince. 
    // If absent, we can keep it or clear it. Usually we keep it for "Connected at X", but if absent "Last Seen Y".
    // When showing "Connected at", we use connectedSince.

    // Log status change if meaningful (e.g. absent <-> present)
    // Check for duplicate status change logs within the last 10 seconds to prevent race conditions
    if (existingDevice.status !== args.status) {
      const tenSecondsAgo = now - 10000;
      const recentLogs = await ctx.db
        .query("deviceLogs")
        .withIndex("by_deviceId", (q: any) => q.eq("deviceId", existingDevice._id))
        .filter((q: any) => 
          q.and(
            q.eq(q.field("changeType"), "status_change"),
            q.gte(q.field("timestamp"), tenSecondsAgo)
          )
        )
        .collect();

      const isDuplicate = recentLogs.some((log: any) => 
        log.details.includes(`from ${existingDevice.status} to ${args.status}`) ||
        log.details.includes(`from ${args.status} to ${existingDevice.status}`)
      );

      if (!isDuplicate) {
        await ctx.db.insert("deviceLogs", {
          deviceId: existingDevice._id,
          changeType: "status_change",
          timestamp: now,
          details: `Status changed from ${existingDevice.status} to ${args.status}`
        });
      }

      // Keep attendanceLogs populated for the admin logs frontend view.
      if (!existingDevice.pendingRegistration) {
        const userName = existingDevice.firstName && existingDevice.lastName
          ? `${existingDevice.firstName} ${existingDevice.lastName}`
          : (existingDevice.name || existingDevice.macAddress);

        await ctx.db.insert("attendanceLogs", {
          userId: existingDevice.macAddress,
          userName,
          status: args.status,
          timestamp: now,
          deviceId: existingDevice._id,
        });
      }
    }

    await ctx.db.patch(existingDevice._id, {
      status: args.status,
      lastSeen: now,
      connectedSince: connectedSince,
      appStatus: args.status === "absent" ? "absent" : existingDevice.appStatus,
    });

    return {
      ...existingDevice,
      status: args.status,
      lastSeen: now,
      connectedSince: connectedSince,
    };
  },
});

export const registerDevice = mutation({
  args: {
    macAddress: v.string(),
    name: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const existingDevice = await ctx.db
      .query("devices")
      .withIndex("by_macAddress", (q: any) => q.eq("macAddress", args.macAddress))
      .first();

    if (existingDevice) {
      return existingDevice;
    }

    const now = Date.now();
    const deviceId = await ctx.db.insert("devices", {
      macAddress: args.macAddress,
      name: args.name,
      status: "absent",
      lastSeen: now,
      firstSeen: now,
      gracePeriodEnd: now,
      pendingRegistration: false,
    });
    await ctx.db.insert("deviceLogs", {
      deviceId,
      changeType: "create",
      timestamp: now,
      details: `Device registered: ${args.name}`
    });

    return {
      _id: deviceId,
      macAddress: args.macAddress,
      name: args.name,
      status: "absent",
      lastSeen: now,
      firstSeen: now,
      gracePeriodEnd: now,
      pendingRegistration: false,
    };
  },
});

export const registerPendingDevice = mutation({
  args: {
    macAddress: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existingDevice = await ctx.db
      .query("devices")
      .withIndex("by_macAddress", (q) => q.eq("macAddress", args.macAddress))
      .first();

    if (existingDevice) {
      return existingDevice;
    }

    const now = Date.now();
    const gracePeriodEnd = now + GRACE_PERIOD_SECONDS * 1000;

    const deviceName = args.name || "";

    const deviceId = await ctx.db.insert("devices", {
      macAddress: args.macAddress,
      name: deviceName,
      status: "present",
      lastSeen: now,
      firstSeen: now,
      gracePeriodEnd,
      pendingRegistration: true,
    });
    await ctx.db.insert("deviceLogs", {
      deviceId,
      changeType: "create",
      timestamp: now,
      details: `Pending device created: ${deviceName || args.macAddress}`
    });

    return {
      _id: deviceId,
      macAddress: args.macAddress,
      name: deviceName,
      status: "present",
      lastSeen: now,
      firstSeen: now,
      gracePeriodEnd,
      pendingRegistration: true,
    };
  },
});

export const completeDeviceRegistration = mutation({
  args: {
    macAddress: v.string(),
    firstName: v.string(),
    lastName: v.string(),
    ucsdEmail: v.string(),
  },
  handler: async (ctx, args) => {
    if (!isValidUcsdEmail(args.ucsdEmail)) {
      throw new Error("A valid @ucsd.edu email is required");
    }

    const normalizedEmail = args.ucsdEmail.trim().toLowerCase();
    const existingEmailOwner = await ctx.db
      .query("devices")
      .withIndex("by_ucsdEmail", (q: any) => q.eq("ucsdEmail", normalizedEmail))
      .first();

    if (existingEmailOwner && existingEmailOwner.macAddress !== args.macAddress) {
      throw new Error("That UCSD email is already linked to another device");
    }

    const existingDevice = await ctx.db
      .query("devices")
      .withIndex("by_macAddress", (q) => q.eq("macAddress", args.macAddress))
      .first();

    if (!existingDevice) {
      throw new Error(`Device with MAC address ${args.macAddress} not found`);
    }

    const now = Date.now();
    await ctx.db.patch(existingDevice._id, {
      firstName: args.firstName,
      lastName: args.lastName,
      ucsdEmail: normalizedEmail,
      pendingRegistration: false,
      lastSeen: now,
      connectedSince: now,
    });

    // Log creation
    await ctx.db.insert("deviceLogs", {
      deviceId: existingDevice._id,
      changeType: "create",
      timestamp: now,
      details: `Device registered: ${args.firstName} ${args.lastName} (${normalizedEmail})`
    });

    return {
      ...existingDevice,
      firstName: args.firstName,
      lastName: args.lastName,
      ucsdEmail: normalizedEmail,
      pendingRegistration: false,
      lastSeen: now,
    };
  },
});

export const updateDeviceDetails = mutation({
  args: {
    id: v.id("devices"),
    firstName: v.string(),
    lastName: v.string(),
    ucsdEmail: v.string(),
    adminPassword: v.string(),
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminPassword);

    if (!isValidUcsdEmail(args.ucsdEmail)) {
      throw new Error("A valid @ucsd.edu email is required");
    }

    const device = await ctx.db.get(args.id);
    if (!device) throw new Error("Device not found");

    const normalizedEmail = args.ucsdEmail.trim().toLowerCase();
    const existingEmailOwner = await ctx.db
      .query("devices")
      .withIndex("by_ucsdEmail", (q: any) => q.eq("ucsdEmail", normalizedEmail))
      .first();

    if (existingEmailOwner && existingEmailOwner._id !== args.id) {
      throw new Error("That UCSD email is already linked to another device");
    }

    const now = Date.now();

    await ctx.db.patch(args.id, {
      firstName: args.firstName,
      lastName: args.lastName,
      ucsdEmail: normalizedEmail,
    });

    // Log update
    await ctx.db.insert("deviceLogs", {
      deviceId: args.id,
      changeType: "update",
      timestamp: now,
      details: `Updated details -> Name: ${args.firstName} ${args.lastName}, Email: ${normalizedEmail}`
    });

    return { success: true };
  }
});

export const deleteDevice = mutation({
  args: {
    id: v.id("devices"),
    adminPassword: v.string(),
  },
  handler: async (ctx, args) => {
    requireAdmin(args.adminPassword);

    const result = await deleteDeviceAndLogs(ctx, args.id);
    if (!result.success) {
      return { success: false, message: "Device not found" };
    }

    return { success: true };
  },
});

export const cleanupExpiredGracePeriods = action({
  args: {},
  handler: async (ctx): Promise<CleanupResult> => {
    return ctx.runMutation(internal.devices.cleanupExpiredGracePeriodsInternal, {});
  },
});

export const cleanupExpiredGracePeriodsInternal = internalMutation({
  args: {},
  handler: async (ctx): Promise<CleanupResult> => {
    return cleanupExpiredDevicesCore(ctx);
  },
});

export const getPresentUsers = query({
  args: {},
  handler: async (ctx) => {
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_status", (q) => q.eq("status", "present"))
      .collect();

    return devices
      .filter((d) => !d.pendingRegistration)
      .map((d) => ({
        firstName: d.firstName,
        lastName: d.lastName,
        name: d.name,
      }));
  },
});

export const getAbsentUsers = query({
  args: {},
  handler: async (ctx) => {
    const devices = await ctx.db
      .query("devices")
      .withIndex("by_status", (q) => q.eq("status", "absent"))
      .collect();

    return devices
      .filter((d) => !d.pendingRegistration)
      .map((d) => ({
        firstName: d.firstName,
        lastName: d.lastName,
        name: d.name,
      }));
  },
});

export const logAttendance = mutation({
  args: {
    userId: v.string(),
    userName: v.string(),
    status: v.union(v.literal("present"), v.literal("absent")),
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("attendanceLogs", {
      userId: args.userId,
      userName: args.userName,
      status: args.status,
      timestamp: now,
      deviceId: args.deviceId,
    });
    return { success: true };
  },
});

export const getAttendanceLogs = query({
  args: {
    adminPassword: v.string(),
  },
  handler: async (ctx, args) => {
    // @ts-ignore - process.env is available in Convex functions
    const environment = process.env;
    const adminPassword = environment.ADMIN_PASSWORD;
    if (args.adminPassword !== adminPassword) {
      throw new Error("Invalid admin password");
    }

    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const logs = await ctx.db
      .query("attendanceLogs")
      .withIndex("by_timestamp", (q: any) => q.gte("timestamp", fourteenDaysAgo))
      .order("desc")
      .collect();

    return logs;
  },
});

export const cleanupOldLogs = internalMutation({
  args: {},
  handler: async (ctx: any) => {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const oldLogs = await ctx.db
      .query("attendanceLogs")
      .withIndex("by_timestamp", (q: any) => q.lt("timestamp", thirtyDaysAgo))
      .collect();

    for (const log of oldLogs) {
      await ctx.db.delete(log._id);
    }

    return { deletedCount: oldLogs.length };
  },
});

export const getAppLinkingConfig = query({
  args: {
    adminPassword: v.optional(v.string()),
  },
  handler: async (ctx: any, args: any) => {
    const appConfig = await getOrCreateAppConfig(ctx);
    return buildAppConfigResponse(appConfig);
  },
});

export const getBoundaryControlAccess = query({
  args: {},
  handler: async (ctx) => {
    const canManageBoundary = await hasBoundaryAdminAccess(ctx);
    return {
      canManageBoundary,
    };
  },
});

export const saveAppBoundaryConfig = mutation({
  args: {
    adminPassword: v.string(),
    boundaryEnabled: v.boolean(),
    boundaryLatitude: v.optional(v.number()),
    boundaryLongitude: v.optional(v.number()),
    boundaryRadius: v.number(),
    boundaryRadiusUnit: v.union(v.literal("meters"), v.literal("miles")),
  },
  handler: async (ctx: any, args: any) => {
    requireAdmin(args.adminPassword);
    const appConfig = await getOrCreateAppConfig(ctx);

    if (!Number.isFinite(args.boundaryRadius) || args.boundaryRadius <= 0) {
      throw new Error("Boundary radius must be greater than 0");
    }

    const hasLatitude = typeof args.boundaryLatitude === "number";
    const hasLongitude = typeof args.boundaryLongitude === "number";

    if (args.boundaryEnabled && (!hasLatitude || !hasLongitude)) {
      throw new Error("Boundary latitude and longitude are required when boundary is enabled");
    }

    if (hasLatitude && (args.boundaryLatitude < -90 || args.boundaryLatitude > 90)) {
      throw new Error("Boundary latitude must be between -90 and 90");
    }

    if (hasLongitude && (args.boundaryLongitude < -180 || args.boundaryLongitude > 180)) {
      throw new Error("Boundary longitude must be between -180 and 180");
    }

    await ctx.db.patch(appConfig._id, {
      boundaryEnabled: args.boundaryEnabled,
      boundaryLatitude: hasLatitude ? args.boundaryLatitude : undefined,
      boundaryLongitude: hasLongitude ? args.boundaryLongitude : undefined,
      boundaryRadius: args.boundaryRadius,
      boundaryRadiusUnit: args.boundaryRadiusUnit,
    });

    const updated = await ctx.db.get(appConfig._id);
    return buildAppConfigResponse(updated);
  },
});

export const setBoundaryEnabledForAuthenticatedAdmin = mutation({
  args: {
    boundaryEnabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const canManageBoundary = await hasBoundaryAdminAccess(ctx);
    if (!canManageBoundary) {
      throw new Error("Admin email required");
    }

    const appConfig = await getOrCreateAppConfig(ctx);

    await ctx.db.patch(appConfig._id, {
      boundaryEnabled: args.boundaryEnabled,
    });

    const updated = await ctx.db.get(appConfig._id);
    return buildAppConfigResponse(updated);
  },
});

export const getDeviceByEmail = query({
  args: {
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedEmail = args.email.trim().toLowerCase();
    if (!isValidUcsdEmail(normalizedEmail)) {
      return null;
    }

    const device = await ctx.db
      .query("devices")
      .withIndex("by_ucsdEmail", (q: any) => q.eq("ucsdEmail", normalizedEmail))
      .first();

    if (!device || device.pendingRegistration) {
      return null;
    }

    return {
      _id: device._id,
      firstName: device.firstName,
      lastName: device.lastName,
      ucsdEmail: device.ucsdEmail,
      status: device.status,
      appStatus: device.appStatus || "absent",
    };
  },
});

export const fetchAppStatusByEmail = query({
  args: {
    apiKey: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const appConfig = await getOrCreateAppConfig(ctx);
    if (args.apiKey !== appConfig.apiKey) {
      throw new Error("Invalid API key");
    }

    const normalizedEmail = args.email.trim().toLowerCase();
    if (!isValidUcsdEmail(normalizedEmail)) {
      throw new Error("A valid @ucsd.edu email is required");
    }

    const device = await ctx.db
      .query("devices")
      .withIndex("by_ucsdEmail", (q: any) => q.eq("ucsdEmail", normalizedEmail))
      .first();

    if (!device || device.pendingRegistration) {
      throw new Error("No registered device found for this UCSD email");
    }

    const configResponse = buildAppConfigResponse(appConfig);

    return {
      success: true,
      email: normalizedEmail,
      appStatus: device.appStatus === "present" ? "present" : "absent",
      keyVersion: configResponse.keyVersion,
      boundaryEnabled: configResponse.boundaryEnabled,
      boundaryLatitude: configResponse.boundaryLatitude,
      boundaryLongitude: configResponse.boundaryLongitude,
      boundaryRadius: configResponse.boundaryRadius,
      boundaryRadiusUnit: configResponse.boundaryRadiusUnit,
    };
  },
});

export const rotateAppApiKey = mutation({
  args: {
    adminPassword: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    requireAdmin(args.adminPassword);
    const appConfig = await getOrCreateAppConfig(ctx);
    const apiKey = randomKey(APP_API_KEY_LENGTH);
    const keyVersion = (appConfig.keyVersion ?? 0) + 1;
    const rotatedAt = Date.now();

    await ctx.db.patch(appConfig._id, {
      apiKey,
      keyVersion,
      rotatedAt,
    });

    const updated = await ctx.db.get(appConfig._id);
    return buildAppConfigResponse(updated);
  },
});

export const flipAppStatusByEmail = mutation({
  args: {
    apiKey: v.string(),
    email: v.string(),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const appConfig = await getOrCreateAppConfig(ctx);
    if (args.apiKey !== appConfig.apiKey) {
      throw new Error("Invalid API key");
    }

    if (typeof args.latitude === "number" && (args.latitude < -90 || args.latitude > 90)) {
      throw new Error("Latitude must be between -90 and 90");
    }

    if (typeof args.longitude === "number" && (args.longitude < -180 || args.longitude > 180)) {
      throw new Error("Longitude must be between -180 and 180");
    }

    const normalizedEmail = args.email.trim().toLowerCase();
    if (!isValidUcsdEmail(normalizedEmail)) {
      throw new Error("A valid @ucsd.edu email is required");
    }

    const device = await ctx.db
      .query("devices")
      .withIndex("by_ucsdEmail", (q: any) => q.eq("ucsdEmail", normalizedEmail))
      .first();

    if (!device || device.pendingRegistration) {
      throw new Error("No registered device found for this UCSD email");
    }

    const boundaryEnabled = appConfig.boundaryEnabled === true;
    if (boundaryEnabled) {
      const hasLatitude = typeof args.latitude === "number";
      const hasLongitude = typeof args.longitude === "number";

      if (!hasLatitude || !hasLongitude) {
        throw new Error("missing_location: latitude and longitude are required when boundary checking is enabled");
      }

      const boundaryLatitude = appConfig.boundaryLatitude;
      const boundaryLongitude = appConfig.boundaryLongitude;
      if (typeof boundaryLatitude !== "number" || typeof boundaryLongitude !== "number") {
        throw new Error("boundary_not_configured: boundary center location is not configured");
      }

      const configuredRadius =
        typeof appConfig.boundaryRadius === "number" && appConfig.boundaryRadius > 0
          ? appConfig.boundaryRadius
          : DEFAULT_BOUNDARY_RADIUS_METERS;
      const maxDistanceMeters = boundaryRadiusToMeters(configuredRadius, appConfig.boundaryRadiusUnit);
      const requestLatitude = args.latitude as number;
      const requestLongitude = args.longitude as number;
      const distanceMeters = getDistanceMeters(
        requestLatitude,
        requestLongitude,
        boundaryLatitude,
        boundaryLongitude,
      );

      if (distanceMeters > maxDistanceMeters) {
        throw new Error(
          `outside_boundary: distance ${distanceMeters.toFixed(2)}m exceeds max ${maxDistanceMeters.toFixed(2)}m`,
        );
      }
    }

    const now = Date.now();
    const nextAppStatus = device.appStatus === "present" ? "absent" : "present";

    await ctx.db.patch(device._id, {
      appStatus: nextAppStatus,
      appLastSeen: now,
    });

    await ctx.db.insert("deviceLogs", {
      deviceId: device._id,
      changeType: "update",
      timestamp: now,
      details: `App status toggled to ${nextAppStatus} for ${normalizedEmail}`,
    });

    return {
      success: true,
      appStatus: nextAppStatus,
      email: normalizedEmail,
      keyVersion: appConfig.keyVersion,
      boundaryEnforced: boundaryEnabled,
    };
  },
});

export const getAttendanceHistory = query({
  args: {
    apiKey: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const appConfig = await getOrCreateAppConfig(ctx);
    if (args.apiKey !== appConfig.apiKey) {
      throw new Error("Invalid API key");
    }

    const normalizedEmail = args.email.trim().toLowerCase();
    if (!isValidUcsdEmail(normalizedEmail)) {
      throw new Error("A valid @ucsd.edu email is required");
    }

    const device = await ctx.db
      .query("devices")
      .withIndex("by_ucsdEmail", (q: any) => q.eq("ucsdEmail", normalizedEmail))
      .first();

    if (!device || device.pendingRegistration) {
      throw new Error("No registered device found for this UCSD email");
    }

    const logs = await ctx.db
      .query("deviceLogs")
      .withIndex("by_deviceId", (q: any) => q.eq("deviceId", device._id))
      .filter((q: any) =>
        q.or(
          q.eq(q.field("changeType"), "status_change"),
          q.eq(q.field("changeType"), "update"),
        )
      )
      .order("desc")
      .take(200);

    const FIVE_MINUTES_MS = 5 * 60 * 1000;

    const bluetoothStatusEvents = logs
      .filter((log: any) => log.changeType === "status_change" && typeof log.details === "string")
      .map((log: any) => {
        const match = log.details.match(/Status changed from (present|absent) to (present|absent)/i);
        const nextStatus = match?.[2]?.toLowerCase();
        if (nextStatus === "present" || nextStatus === "absent") {
          return { timestamp: log.timestamp, status: nextStatus };
        }
        return null;
      })
      .filter(Boolean)
      .map((entry: any) => entry)
      .sort((a: any, b: any) => a.timestamp - b.timestamp);

    const bluetoothCheckIns = bluetoothStatusEvents.filter((event: any) => event.status === "present");
    const bluetoothCheckOuts = bluetoothStatusEvents.filter((event: any) => event.status === "absent");

    const appStatusLogs = logs.filter((log: any) => typeof log.details === "string" && log.details.includes("App status"));

    const appStatusEvents = appStatusLogs
      .map((log: any) => {
        const match = log.details.match(/App status toggled to (present|absent)/i);
        const nextStatus = match?.[1]?.toLowerCase();
        if (nextStatus === "present" || nextStatus === "absent") {
          return { timestamp: log.timestamp, status: nextStatus };
        }
        return null;
      })
      .filter(Boolean)
      .map((entry: any) => entry)
      .sort((a: any, b: any) => a.timestamp - b.timestamp);

    const appCheckIns = appStatusEvents.filter((event: any) => event.status === "present");
    const appCheckOuts = appStatusEvents.filter((event: any) => event.status === "absent");

    const mergeEvents = (
      primaryEvents: { timestamp: number }[],
      secondaryEvents: { timestamp: number }[],
      options: {
        status: "present" | "absent";
        bothLabel: string;
        primaryLabel: string;
        secondaryLabel: string;
        bothSource: string;
        primarySource: string;
        secondarySource: string;
      },
    ) => {
      const merged: any[] = [];
      let primaryIndex = 0;
      let secondaryIndex = 0;

      while (primaryIndex < primaryEvents.length && secondaryIndex < secondaryEvents.length) {
        const primaryEvent = primaryEvents[primaryIndex];
        const secondaryEvent = secondaryEvents[secondaryIndex];
        const diff = Math.abs(primaryEvent.timestamp - secondaryEvent.timestamp);

        if (diff <= FIVE_MINUTES_MS) {
          merged.push({
            timestamp: Math.min(primaryEvent.timestamp, secondaryEvent.timestamp),
            status: options.status,
            source: options.bothSource,
            label: options.bothLabel,
          });
          primaryIndex += 1;
          secondaryIndex += 1;
        } else if (primaryEvent.timestamp < secondaryEvent.timestamp) {
          merged.push({
            timestamp: primaryEvent.timestamp,
            status: options.status,
            source: options.primarySource,
            label: options.primaryLabel,
          });
          primaryIndex += 1;
        } else {
          merged.push({
            timestamp: secondaryEvent.timestamp,
            status: options.status,
            source: options.secondarySource,
            label: options.secondaryLabel,
          });
          secondaryIndex += 1;
        }
      }

      while (primaryIndex < primaryEvents.length) {
        merged.push({
          timestamp: primaryEvents[primaryIndex].timestamp,
          status: options.status,
          source: options.primarySource,
          label: options.primaryLabel,
        });
        primaryIndex += 1;
      }

      while (secondaryIndex < secondaryEvents.length) {
        merged.push({
          timestamp: secondaryEvents[secondaryIndex].timestamp,
          status: options.status,
          source: options.secondarySource,
          label: options.secondaryLabel,
        });
        secondaryIndex += 1;
      }

      return merged;
    };

    const combinedCheckIns = mergeEvents(appCheckIns, bluetoothCheckIns, {
      status: "present",
      bothLabel: "app check in verified with bluetooth",
      primaryLabel: "checked in with app",
      secondaryLabel: "checked in with bluetooth",
      bothSource: "app+bluetooth",
      primarySource: "app",
      secondarySource: "bluetooth",
    });

    const combinedCheckOuts = mergeEvents(appCheckOuts, bluetoothCheckOuts, {
      status: "absent",
      bothLabel: "app check out verified with bluetooth",
      primaryLabel: "checked out via app",
      secondaryLabel: "checked out via bluetooth",
      bothSource: "app+bluetooth",
      primarySource: "app",
      secondarySource: "bluetooth",
    });

    const records = [...combinedCheckIns, ...combinedCheckOuts].sort((a, b) => b.timestamp - a.timestamp);

    return {
      success: true,
      email: normalizedEmail,
      records,
    };
  },
});

export const getCheckedInUsers = query({
  args: {},
  handler: async (ctx: any) => {
    try {
      const devices = await ctx.db.query("devices").collect();
      
      const checkedInUsers: any[] = [];
      
      for (const device of devices) {
        // Skip pending registration devices
        if (device.pendingRegistration) {
          continue;
        }
        
        // Check if device is checked in (via app or bluetooth)
        const isCheckedIn = device.status === "present" || device.appStatus === "present";
        
        if (!isCheckedIn) {
          continue;
        }
        
        // Default values
        let checkInTime = device.connectedSince || device.lastSeen || Date.now();
        let checkInMethod = "unknown";
        
        try {
          // Get recent logs for this device
          const logs = await ctx.db
            .query("deviceLogs")
            .withIndex("by_deviceId", (q: any) => q.eq("deviceId", device._id))
            .filter((q: any) =>
              q.or(
                q.eq(q.field("changeType"), "status_change"),
                q.eq(q.field("changeType"), "update"),
              )
            )
            .order("desc")
            .take(50);
          
          // Find recent check-in events
          const recentStatusChange = logs.find((log: any) => 
            log.changeType === "status_change" && 
            typeof log.details === "string" &&
            log.details.includes("to present")
          );
          
          const recentAppToggle = logs.find((log: any) => 
            log.changeType === "update" && 
            typeof log.details === "string" &&
            log.details.includes("App status toggled to present")
          );
          
          // Determine check-in time and method
          if (recentStatusChange && recentAppToggle) {
            const timeDiff = Math.abs(recentStatusChange.timestamp - recentAppToggle.timestamp);
            if (timeDiff <= 5 * 60 * 1000) {
              checkInTime = Math.min(recentStatusChange.timestamp, recentAppToggle.timestamp);
              checkInMethod = "app+bluetooth";
            } else if (recentStatusChange.timestamp > recentAppToggle.timestamp) {
              checkInTime = recentStatusChange.timestamp;
              checkInMethod = "bluetooth";
            } else {
              checkInTime = recentAppToggle.timestamp;
              checkInMethod = "app";
            }
          } else if (recentStatusChange) {
            checkInTime = recentStatusChange.timestamp;
            checkInMethod = "bluetooth";
          } else if (recentAppToggle) {
            checkInTime = recentAppToggle.timestamp;
            checkInMethod = "app";
          } else if (device.status === "present") {
            checkInMethod = "bluetooth";
          } else if (device.appStatus === "present") {
            checkInMethod = "app";
          }
        } catch (logError) {
          // If log query fails, use device defaults
          console.error("Error fetching logs for device", device._id, logError);
          if (device.status === "present") {
            checkInMethod = "bluetooth";
          } else if (device.appStatus === "present") {
            checkInMethod = "app";
          }
        }
        
        // Build display name
        const displayName = (device.firstName && device.lastName) 
          ? `${device.firstName} ${device.lastName}` 
          : (device.name || "Unknown");
        
        checkedInUsers.push({
          _id: device._id,
          name: displayName,
          firstName: device.firstName,
          lastName: device.lastName,
          email: device.ucsdEmail,
          checkInTime,
          checkInMethod,
          status: device.status,
          appStatus: device.appStatus,
        });
      }
      
      // Sort by check-in time, most recent first
      checkedInUsers.sort((a, b) => b.checkInTime - a.checkInTime);
      
      return checkedInUsers;
    } catch (error) {
      console.error("Error in getCheckedInUsers:", error);
      // Return empty array on error rather than crashing
      return [];
    }
  },
});

export const getAttendanceHistoryByDeviceId = query({
  args: {
    deviceId: v.id("devices"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const device = await ctx.db.get(args.deviceId);
    if (!device || device.pendingRegistration) {
      return [];
    }

    const maxRecords = args.limit || 20;

    const logs = await ctx.db
      .query("deviceLogs")
      .withIndex("by_deviceId", (q: any) => q.eq("deviceId", args.deviceId))
      .filter((q: any) =>
        q.or(
          q.eq(q.field("changeType"), "status_change"),
          q.eq(q.field("changeType"), "update"),
        )
      )
      .order("desc")
      .take(200);

    const FIVE_MINUTES_MS = 5 * 60 * 1000;

    const bluetoothStatusEvents = logs
      .filter((log: any) => log.changeType === "status_change" && typeof log.details === "string")
      .map((log: any) => {
        const match = log.details.match(/Status changed from (present|absent) to (present|absent)/i);
        const nextStatus = match?.[2]?.toLowerCase();
        if (nextStatus === "present" || nextStatus === "absent") {
          return { timestamp: log.timestamp, status: nextStatus };
        }
        return null;
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.timestamp - b.timestamp);

    const bluetoothCheckIns = bluetoothStatusEvents.filter((event: any) => event.status === "present");
    const bluetoothCheckOuts = bluetoothStatusEvents.filter((event: any) => event.status === "absent");

    const appStatusLogs = logs.filter((log: any) => typeof log.details === "string" && log.details.includes("App status"));

    const appStatusEvents = appStatusLogs
      .map((log: any) => {
        const match = log.details.match(/App status toggled to (present|absent)/i);
        const nextStatus = match?.[1]?.toLowerCase();
        if (nextStatus === "present" || nextStatus === "absent") {
          return { timestamp: log.timestamp, status: nextStatus };
        }
        return null;
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.timestamp - b.timestamp);

    const appCheckIns = appStatusEvents.filter((event: any) => event.status === "present");
    const appCheckOuts = appStatusEvents.filter((event: any) => event.status === "absent");

    const mergeEvents = (
      primaryEvents: { timestamp: number }[],
      secondaryEvents: { timestamp: number }[],
      options: {
        status: "present" | "absent";
        bothLabel: string;
        primaryLabel: string;
        secondaryLabel: string;
        bothSource: string;
        primarySource: string;
        secondarySource: string;
      },
    ) => {
      const merged: any[] = [];
      let primaryIndex = 0;
      let secondaryIndex = 0;

      while (primaryIndex < primaryEvents.length && secondaryIndex < secondaryEvents.length) {
        const primaryEvent = primaryEvents[primaryIndex];
        const secondaryEvent = secondaryEvents[secondaryIndex];
        const diff = Math.abs(primaryEvent.timestamp - secondaryEvent.timestamp);

        if (diff <= FIVE_MINUTES_MS) {
          merged.push({
            timestamp: Math.min(primaryEvent.timestamp, secondaryEvent.timestamp),
            status: options.status,
            source: options.bothSource,
            label: options.bothLabel,
          });
          primaryIndex += 1;
          secondaryIndex += 1;
        } else if (primaryEvent.timestamp < secondaryEvent.timestamp) {
          merged.push({
            timestamp: primaryEvent.timestamp,
            status: options.status,
            source: options.primarySource,
            label: options.primaryLabel,
          });
          primaryIndex += 1;
        } else {
          merged.push({
            timestamp: secondaryEvent.timestamp,
            status: options.status,
            source: options.secondarySource,
            label: options.secondaryLabel,
          });
          secondaryIndex += 1;
        }
      }

      while (primaryIndex < primaryEvents.length) {
        merged.push({
          timestamp: primaryEvents[primaryIndex].timestamp,
          status: options.status,
          source: options.primarySource,
          label: options.primaryLabel,
        });
        primaryIndex += 1;
      }

      while (secondaryIndex < secondaryEvents.length) {
        merged.push({
          timestamp: secondaryEvents[secondaryIndex].timestamp,
          status: options.status,
          source: options.secondarySource,
          label: options.secondaryLabel,
        });
        secondaryIndex += 1;
      }

      return merged;
    };

    const combinedCheckIns = mergeEvents(appCheckIns, bluetoothCheckIns, {
      status: "present",
      bothLabel: "app check in verified with bluetooth",
      primaryLabel: "checked in with app",
      secondaryLabel: "checked in with bluetooth",
      bothSource: "app+bluetooth",
      primarySource: "app",
      secondarySource: "bluetooth",
    });

    const combinedCheckOuts = mergeEvents(appCheckOuts, bluetoothCheckOuts, {
      status: "absent",
      bothLabel: "app check out verified with bluetooth",
      primaryLabel: "checked out via app",
      secondaryLabel: "checked out via bluetooth",
      bothSource: "app+bluetooth",
      primarySource: "app",
      secondarySource: "bluetooth",
    });

    const records = [...combinedCheckIns, ...combinedCheckOuts]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxRecords);

    return records;
  },
});
