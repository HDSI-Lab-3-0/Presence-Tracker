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
const PACIFIC_TIME_ZONE = "America/Los_Angeles";

type CleanupResult = { deletedCount: number; deletedMacs: string[] };

type DeleteResult = { success: boolean; macAddress?: string | null };
type AttendanceAction = "check_in" | "check_out";
type AttendanceOrigin = "app" | "bluetooth" | "system";
type AttendanceStatusValue = "present" | "absent";
type AttendanceVerificationStatus = "verified" | "unverified" | "pending" | "expired" | "inferred";
type AttendanceVerifiedBy =
  | "bluetooth_immediate"
  | "bluetooth_followup"
  | "bluetooth_disconnect"
  | "none"
  | "manual"
  | "system_inferred";

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

const resolveBoundaryAdminEmailCandidate = async (ctx: any, claimedEmail?: string | null) => {
  const requestedEmail = normalizeEmail(claimedEmail);
  if (requestedEmail) {
    return requestedEmail;
  }

  let authenticatedEmail = "";
  try {
    const authUser = await authComponent.getAuthUser(ctx);
    authenticatedEmail = normalizeEmail(authUser?.email);
  } catch {
    // Auth context may be unavailable on some deployed call paths.
    authenticatedEmail = "";
  }
  return authenticatedEmail;
};

const hasBoundaryAdminAccess = async (ctx: any, claimedEmail?: string | null) => {
  const emailCandidate = await resolveBoundaryAdminEmailCandidate(ctx, claimedEmail);
  return isAdminEmailMatch(emailCandidate);
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

const STATUS_FROM_ACTION: Record<AttendanceAction, AttendanceStatusValue> = {
  check_in: "present",
  check_out: "absent",
};

const ACTION_FROM_STATUS: Record<AttendanceStatusValue, AttendanceAction> = {
  present: "check_in",
  absent: "check_out",
};

const isManualAttendanceDriver = (device: any): boolean =>
  device?.attendanceDriver === "manual"
  || (device?.attendanceDriver !== "bluetooth" && typeof device?.latestAppIntentAt === "number");

const attendanceStateFromDevice = (device: any): AttendanceStatusValue => {
  if (isManualAttendanceDriver(device)) {
    if (device?.attendanceStatus === "present" || device?.attendanceStatus === "absent") {
      return device.attendanceStatus;
    }
    return device?.appStatus === "present" ? "present" : "absent";
  }
  if (device?.attendanceStatus === "present" || device?.attendanceStatus === "absent") {
    return device.attendanceStatus;
  }
  if (device?.appStatus === "present" || device?.status === "present") {
    return "present";
  }
  return "absent";
};

const attendanceChangedAtFromDevice = (device: any) =>
  typeof device?.attendanceChangedAt === "number"
    ? device.attendanceChangedAt
    : typeof device?.appLastSeen === "number"
      ? device.appLastSeen
      : typeof device?.connectedSince === "number"
        ? device.connectedSince
        : device?.lastSeen;

const deviceDisplayName = (device: any) =>
  device?.firstName && device?.lastName
    ? `${device.firstName} ${device.lastName}`
    : (device?.name || device?.macAddress || "Unknown");

const pacificDayKey = (timestamp: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));

const pendingVerificationPatch = (
  action: AttendanceAction,
  eventId: Id<"attendanceLogs">,
  verificationDeadline: number,
) => ({
  pendingVerificationAction: action,
  pendingVerificationEventId: eventId,
  pendingVerificationExpiresAt: verificationDeadline,
});

const clearedPendingVerificationPatch = () => ({
  pendingVerificationAction: undefined,
  pendingVerificationEventId: undefined,
  pendingVerificationExpiresAt: undefined,
});

const shouldTreatPendingAsExpired = (log: any, now: number) =>
  log?.verificationStatus === "pending"
  && typeof log?.verificationDeadline === "number"
  && log.verificationDeadline <= now;

const normalizeAttendanceLogForResponse = (log: any, now = Date.now()) => {
  const status: AttendanceStatusValue =
    log?.status === "absent" ? "absent" : "present";
  const action: AttendanceAction =
    log?.action === "check_out" || log?.action === "check_in"
      ? log.action
      : ACTION_FROM_STATUS[status];
  const origin: AttendanceOrigin =
    log?.origin === "app" || log?.origin === "system" ? log.origin : "bluetooth";
  let verificationStatus: AttendanceVerificationStatus =
    log?.verificationStatus === "verified"
      || log?.verificationStatus === "unverified"
      || log?.verificationStatus === "pending"
      || log?.verificationStatus === "expired"
      || log?.verificationStatus === "inferred"
      ? log.verificationStatus
      : "verified";

  if (shouldTreatPendingAsExpired(log, now)) {
    verificationStatus = action === "check_in" ? "unverified" : "expired";
  }

  const verifiedBy: AttendanceVerifiedBy =
    log?.verifiedBy === "bluetooth_followup"
      || log?.verifiedBy === "bluetooth_disconnect"
      || log?.verifiedBy === "none"
      || log?.verifiedBy === "manual"
      || log?.verifiedBy === "system_inferred"
      ? log.verifiedBy
      : "bluetooth_immediate";

  const effectiveTimestamp =
    typeof log?.effectiveTimestamp === "number" ? log.effectiveTimestamp : log?.timestamp;
  const eventTimestamp =
    typeof log?.eventTimestamp === "number" ? log.eventTimestamp : effectiveTimestamp;

  const verifiedByBluetooth =
    verifiedBy === "bluetooth_immediate"
    || verifiedBy === "bluetooth_followup"
    || verifiedBy === "bluetooth_disconnect";

  const source =
    origin === "app"
      ? verificationStatus === "verified" && verifiedByBluetooth
        ? "app+bluetooth"
        : "app"
      : origin === "system"
        ? "system"
        : "bluetooth";

  let label = "";
  if (action === "check_in") {
    if (origin === "app" && verificationStatus === "verified" && verifiedBy === "manual") {
      label = "checked in via app (manual)";
    } else if (origin === "app" && verificationStatus === "verified" && verifiedByBluetooth) {
      label = "app check in verified with bluetooth";
    } else if (origin === "app" && verificationStatus === "pending") {
      label = "app check in awaiting bluetooth verification";
    } else if (origin === "app" && verificationStatus === "unverified") {
      label = "app check in not verified with bluetooth";
    } else if (origin === "system") {
      label = "checked in by system";
    } else {
      label = "checked in with bluetooth";
    }
  } else if (origin === "app" && verificationStatus === "verified" && verifiedBy === "manual") {
    label = "checked out via app (manual)";
  } else if (origin === "app" && verificationStatus === "verified" && verifiedByBluetooth) {
    label = "app check out verified with bluetooth";
  } else if (origin === "app" && verificationStatus === "pending") {
    label = "app check out awaiting bluetooth verification";
  } else if (origin === "app" && verificationStatus === "expired") {
    label = "app check out not verified with bluetooth";
  } else if (origin === "system") {
    label = "inferred end-of-day checkout";
  } else {
    label = "checked out via bluetooth";
  }

  return {
    ...log,
    action,
    status,
    origin,
    verificationStatus,
    verifiedBy,
    eventTimestamp,
    effectiveTimestamp,
    timestamp: effectiveTimestamp,
    source,
    label,
  };
};

const auditAttendance = async (ctx: any, deviceId: Id<"devices">, details: string) => {
  await ctx.db.insert("deviceLogs", {
    deviceId,
    changeType: "attendance",
    timestamp: Date.now(),
    details,
  });
};

const createAttendanceEvent = async (
  ctx: any,
  device: any,
  args: {
    action: AttendanceAction;
    origin: AttendanceOrigin;
    verificationStatus: AttendanceVerificationStatus;
    verifiedBy: AttendanceVerifiedBy;
    eventTimestamp: number;
    effectiveTimestamp: number;
    verificationDeadline?: number;
  },
) => {
  const status = STATUS_FROM_ACTION[args.action];
  const eventId = await ctx.db.insert("attendanceLogs", {
    userId: device.macAddress,
    userName: deviceDisplayName(device),
    deviceId: String(device._id),
    action: args.action,
    status,
    origin: args.origin,
    verificationStatus: args.verificationStatus,
    verifiedBy: args.verifiedBy,
    eventTimestamp: args.eventTimestamp,
    effectiveTimestamp: args.effectiveTimestamp,
    verificationDeadline: args.verificationDeadline,
    timestamp: args.effectiveTimestamp,
  });
  return eventId;
};

const patchAttendanceEvent = async (ctx: any, eventId: Id<"attendanceLogs">, patch: Record<string, any>) => {
  const effectiveTimestamp =
    typeof patch.effectiveTimestamp === "number" ? patch.effectiveTimestamp : undefined;
  await ctx.db.patch(eventId, {
    ...patch,
    ...(typeof effectiveTimestamp === "number" ? { timestamp: effectiveTimestamp } : {}),
  });
};

const refreshDevice = async (ctx: any, deviceId: Id<"devices">) => ctx.db.get(deviceId);

const settleExpiredPendingVerification = async (ctx: any, device: any, now: number) => {
  if (
    (device?.pendingVerificationAction !== "check_in" && device?.pendingVerificationAction !== "check_out")
    || typeof device?.pendingVerificationExpiresAt !== "number"
    || device.pendingVerificationExpiresAt > now
  ) {
    return device;
  }

  const pendingEvent = device.pendingVerificationEventId
    ? await ctx.db.get(device.pendingVerificationEventId)
    : null;

  const patch: Record<string, any> = {
    ...clearedPendingVerificationPatch(),
  };

  if (device.pendingVerificationAction === "check_in") {
    if (pendingEvent) {
      await patchAttendanceEvent(ctx, pendingEvent._id, {
        verificationStatus: "unverified",
        verifiedBy: "none",
      });
    }
    if (attendanceStateFromDevice(device) === "present" && device.attendanceOrigin === "app") {
      patch.attendanceVerificationStatus = "unverified";
      patch.attendanceVerifiedBy = "none";
    }
    await auditAttendance(ctx, device._id, "App check-in expired without bluetooth verification");
  } else {
    if (pendingEvent) {
      await patchAttendanceEvent(ctx, pendingEvent._id, {
        verificationStatus: "expired",
        verifiedBy: "none",
      });
    }
    await auditAttendance(ctx, device._id, "App check-out expired without bluetooth verification");
  }

  await ctx.db.patch(device._id, patch);
  return {
    ...device,
    ...patch,
  };
};

/** PWA clock is immediate; clear any legacy pending rows without bluetooth-themed audits. */
const clearPendingVerificationForAppFlip = async (ctx: any, device: any) => {
  if (device.pendingVerificationAction !== "check_in" && device.pendingVerificationAction !== "check_out") {
    return device;
  }

  if (device.pendingVerificationEventId) {
    const pendingEvent = await ctx.db.get(device.pendingVerificationEventId);
    if (pendingEvent) {
      if (device.pendingVerificationAction === "check_in") {
        await patchAttendanceEvent(ctx, pendingEvent._id, {
          verificationStatus: "unverified",
          verifiedBy: "none",
        });
      } else {
        await patchAttendanceEvent(ctx, pendingEvent._id, {
          verificationStatus: "expired",
          verifiedBy: "none",
        });
      }
    }
  }

  const patch = { ...clearedPendingVerificationPatch() };
  await ctx.db.patch(device._id, patch);
  return { ...device, ...patch };
};

const verifyPendingCheckInWithBluetooth = async (ctx: any, device: any) => {
  if (device?.pendingVerificationAction !== "check_in" || !device?.pendingVerificationEventId) {
    return device;
  }

  const pendingEvent = await ctx.db.get(device.pendingVerificationEventId);
  if (!pendingEvent) {
    const patch = clearedPendingVerificationPatch();
    await ctx.db.patch(device._id, patch);
    return { ...device, ...patch };
  }

  await patchAttendanceEvent(ctx, pendingEvent._id, {
    verificationStatus: "verified",
    verifiedBy: "bluetooth_followup",
  });

  const patch = {
    ...clearedPendingVerificationPatch(),
    attendanceVerificationStatus: "verified",
    attendanceVerifiedBy: "bluetooth_followup",
  };
  await ctx.db.patch(device._id, patch);
  await auditAttendance(ctx, device._id, "App check-in verified by bluetooth connection");
  return {
    ...device,
    ...patch,
  };
};

const verifyPendingCheckOutWithBluetooth = async (ctx: any, device: any) => {
  if (device?.pendingVerificationAction !== "check_out" || !device?.pendingVerificationEventId) {
    return device;
  }

  const pendingEvent = await ctx.db.get(device.pendingVerificationEventId);
  if (!pendingEvent) {
    const patch = clearedPendingVerificationPatch();
    await ctx.db.patch(device._id, patch);
    return { ...device, ...patch };
  }

  const effectiveTimestamp =
    typeof pendingEvent?.effectiveTimestamp === "number"
      ? pendingEvent.effectiveTimestamp
      : pendingEvent?.timestamp;

  await patchAttendanceEvent(ctx, pendingEvent._id, {
    verificationStatus: "verified",
    verifiedBy: "bluetooth_disconnect",
    effectiveTimestamp,
  });

  const patch = {
    ...clearedPendingVerificationPatch(),
    attendanceStatus: "absent",
    attendanceChangedAt: effectiveTimestamp,
    attendanceOrigin: "app",
    attendanceVerificationStatus: "verified",
    attendanceVerifiedBy: "bluetooth_disconnect",
    appStatus: "absent",
  };
  await ctx.db.patch(device._id, patch);
  await auditAttendance(ctx, device._id, "App check-out verified by bluetooth disconnect");
  return {
    ...device,
    ...patch,
  };
};

const inferMissingPriorDayCheckout = async (ctx: any, device: any, now: number) => {
  if (isManualAttendanceDriver(device)) {
    return device;
  }
  if (attendanceStateFromDevice(device) !== "present") {
    return device;
  }

  const previousChangeAt = attendanceChangedAtFromDevice(device);
  if (typeof previousChangeAt !== "number" || pacificDayKey(previousChangeAt) === pacificDayKey(now)) {
    return device;
  }

  const lastBluetoothAbsentAt =
    typeof device?.lastBluetoothAbsentAt === "number" ? device.lastBluetoothAbsentAt : undefined;
  if (
    typeof lastBluetoothAbsentAt !== "number"
    || lastBluetoothAbsentAt <= previousChangeAt
    || lastBluetoothAbsentAt >= now
  ) {
    return device;
  }

  await createAttendanceEvent(ctx, device, {
    action: "check_out",
    origin: "system",
    verificationStatus: "inferred",
    verifiedBy: "system_inferred",
    eventTimestamp: lastBluetoothAbsentAt,
    effectiveTimestamp: lastBluetoothAbsentAt,
  });

  const patch = {
    attendanceStatus: "absent",
    attendanceChangedAt: lastBluetoothAbsentAt,
    attendanceOrigin: "system",
    attendanceVerificationStatus: "inferred",
    attendanceVerifiedBy: "system_inferred",
    appStatus: "absent",
    ...clearedPendingVerificationPatch(),
  };
  await ctx.db.patch(device._id, patch);
  await auditAttendance(ctx, device._id, "Inferred prior-day bluetooth checkout before next bluetooth check-in");
  return {
    ...device,
    ...patch,
  };
};

const buildAttendanceStatePayload = (device: any, email?: string) => ({
  success: true,
  email,
  attendanceStatus: attendanceStateFromDevice(device),
  attendanceChangedAt: attendanceChangedAtFromDevice(device),
  attendanceOrigin:
    device?.attendanceOrigin === "app" || device?.attendanceOrigin === "system"
      ? device.attendanceOrigin
      : "bluetooth",
  attendanceVerificationStatus:
    device?.attendanceVerificationStatus === "verified"
    || device?.attendanceVerificationStatus === "unverified"
    || device?.attendanceVerificationStatus === "pending"
    || device?.attendanceVerificationStatus === "expired"
    || device?.attendanceVerificationStatus === "inferred"
      ? device.attendanceVerificationStatus
      : (device?.status === "present" ? "verified" : "unverified"),
  attendanceVerifiedBy:
    device?.attendanceVerifiedBy === "bluetooth_followup"
    || device?.attendanceVerifiedBy === "bluetooth_disconnect"
    || device?.attendanceVerifiedBy === "none"
    || device?.attendanceVerifiedBy === "manual"
    || device?.attendanceVerifiedBy === "system_inferred"
      ? device.attendanceVerifiedBy
      : "bluetooth_immediate",
  latestAppIntent: device?.latestAppIntent || null,
  latestAppIntentAt: device?.latestAppIntentAt ?? null,
  pendingVerificationAction: isManualAttendanceDriver(device)
    ? null
    : (device?.pendingVerificationAction || null),
  pendingVerificationExpiresAt: isManualAttendanceDriver(device)
    ? null
    : (device?.pendingVerificationExpiresAt ?? null),
  attendanceDriver: isManualAttendanceDriver(device) ? "manual" : "bluetooth",
  bluetoothStatus: device?.status === "present" ? "present" : "absent",
  appStatus: device?.appStatus === "present" ? "present" : "absent",
  appLastSeen: device?.appLastSeen ?? null,
  lastBluetoothPresentAt: device?.lastBluetoothPresentAt ?? null,
  lastBluetoothAbsentAt: device?.lastBluetoothAbsentAt ?? null,
});

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
        attendanceStatus: attendanceStateFromDevice(device),
        attendanceChangedAt: attendanceChangedAtFromDevice(device),
        attendanceOrigin: device.attendanceOrigin,
        attendanceVerificationStatus: device.attendanceVerificationStatus,
        attendanceVerifiedBy: device.attendanceVerifiedBy,
        latestAppIntent: device.latestAppIntent,
        latestAppIntentAt: device.latestAppIntentAt,
        pendingVerificationAction: isManualAttendanceDriver(device)
          ? null
          : device.pendingVerificationAction,
        pendingVerificationExpiresAt: isManualAttendanceDriver(device)
          ? null
          : device.pendingVerificationExpiresAt,
        attendanceDriver: isManualAttendanceDriver(device) ? "manual" : "bluetooth",
        lastBluetoothPresentAt: device.lastBluetoothPresentAt,
        lastBluetoothAbsentAt: device.lastBluetoothAbsentAt,
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
        appStatus: args.status === "present" ? "present" : "absent",
        attendanceStatus: args.status === "present" ? "present" : "absent",
        attendanceChangedAt: now,
        attendanceOrigin: "bluetooth",
        attendanceVerificationStatus: args.status === "present" ? "verified" : "unverified",
        attendanceVerifiedBy: args.status === "present" ? "bluetooth_immediate" : "none",
        lastBluetoothPresentAt: args.status === "present" ? now : undefined,
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
    let device = await settleExpiredPendingVerification(ctx, existingDevice, now);

    if (device.status !== args.status) {
      const tenSecondsAgo = now - 10000;
      const recentLogs = await ctx.db
        .query("deviceLogs")
        .withIndex("by_deviceId", (q: any) => q.eq("deviceId", existingDevice._id))
        .filter((q: any) =>
          q.and(
            q.eq(q.field("changeType"), "status_change"),
            q.gte(q.field("timestamp"), tenSecondsAgo),
          )
        )
        .collect();

      const isDuplicate = recentLogs.some((log: any) =>
        log.details.includes(`from ${existingDevice.status} to ${args.status}`)
        || log.details.includes(`from ${args.status} to ${existingDevice.status}`),
      );

      if (!isDuplicate) {
        await ctx.db.insert("deviceLogs", {
          deviceId: existingDevice._id,
          changeType: "status_change",
          timestamp: now,
          details: `Status changed from ${existingDevice.status} to ${args.status}`,
        });
      }
    }

    if (args.status === device.status) {
      await ctx.db.patch(device._id, {
        lastSeen: now,
      });
      return {
        ...device,
        lastSeen: now,
      };
    }

    if (isManualAttendanceDriver(device)) {
      if (args.status === "present") {
        await ctx.db.patch(device._id, {
          status: "present",
          lastSeen: now,
          connectedSince: now,
          lastBluetoothPresentAt: now,
        });
        return {
          ...device,
          status: "present",
          lastSeen: now,
          connectedSince: now,
          lastBluetoothPresentAt: now,
        };
      }
      await ctx.db.patch(device._id, {
        status: "absent",
        lastSeen: now,
        lastBluetoothAbsentAt: now,
      });
      return {
        ...device,
        status: "absent",
        lastSeen: now,
        lastBluetoothAbsentAt: now,
      };
    }

    if (args.status === "present") {
      device = await inferMissingPriorDayCheckout(ctx, device, now);

      if (
        device.pendingVerificationAction === "check_in"
        && typeof device.pendingVerificationExpiresAt === "number"
        && device.pendingVerificationExpiresAt >= now
      ) {
        device = await verifyPendingCheckInWithBluetooth(ctx, device);
      } else if (attendanceStateFromDevice(device) === "absent" && !device.pendingRegistration) {
        await createAttendanceEvent(ctx, device, {
          action: "check_in",
          origin: "bluetooth",
          verificationStatus: "verified",
          verifiedBy: "bluetooth_immediate",
          eventTimestamp: now,
          effectiveTimestamp: now,
        });
        await auditAttendance(ctx, device._id, "Automatically checked in via bluetooth");
        device = {
          ...device,
          attendanceStatus: "present",
          attendanceChangedAt: now,
          attendanceOrigin: "bluetooth",
          attendanceVerificationStatus: "verified",
          attendanceVerifiedBy: "bluetooth_immediate",
        };
      }

      await ctx.db.patch(device._id, {
        status: "present",
        lastSeen: now,
        connectedSince: now,
        lastBluetoothPresentAt: now,
        attendanceStatus: attendanceStateFromDevice(device),
        attendanceChangedAt: attendanceChangedAtFromDevice(device),
        attendanceOrigin: device.attendanceOrigin,
        attendanceVerificationStatus: device.attendanceVerificationStatus,
        attendanceVerifiedBy: device.attendanceVerifiedBy,
      });

      return {
        ...device,
        status: "present",
        lastSeen: now,
        connectedSince: now,
        lastBluetoothPresentAt: now,
      };
    }

    if (
      device.pendingVerificationAction === "check_out"
      && typeof device.pendingVerificationExpiresAt === "number"
      && device.pendingVerificationExpiresAt >= now
    ) {
      device = await verifyPendingCheckOutWithBluetooth(ctx, device);
    } else if (attendanceStateFromDevice(device) === "present" && !device.pendingRegistration) {
      await createAttendanceEvent(ctx, device, {
        action: "check_out",
        origin: "bluetooth",
        verificationStatus: "verified",
        verifiedBy: "bluetooth_disconnect",
        eventTimestamp: now,
        effectiveTimestamp: now,
      });
      await auditAttendance(ctx, device._id, "Automatically checked out via bluetooth disconnect");
      device = {
        ...device,
        attendanceStatus: "absent",
        attendanceChangedAt: now,
        attendanceOrigin: "bluetooth",
        attendanceVerificationStatus: "verified",
        attendanceVerifiedBy: "bluetooth_disconnect",
        appStatus: "absent",
      };
    }

    await ctx.db.patch(device._id, {
      status: "absent",
      lastSeen: now,
      lastBluetoothAbsentAt: now,
      appStatus: device.appStatus === "present" ? "present" : "absent",
      attendanceStatus: attendanceStateFromDevice(device),
      attendanceChangedAt: attendanceChangedAtFromDevice(device),
      attendanceOrigin: device.attendanceOrigin,
      attendanceVerificationStatus: device.attendanceVerificationStatus,
      attendanceVerifiedBy: device.attendanceVerifiedBy,
    });

    return {
      ...device,
      status: "absent",
      lastSeen: now,
      lastBluetoothAbsentAt: now,
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
      appStatus: "absent",
      attendanceStatus: "absent",
      attendanceChangedAt: now,
      attendanceOrigin: "bluetooth",
      attendanceVerificationStatus: "unverified",
      attendanceVerifiedBy: "none",
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
      appStatus: "absent",
      attendanceStatus: "present",
      attendanceChangedAt: now,
      attendanceOrigin: "bluetooth",
      attendanceVerificationStatus: "verified",
      attendanceVerifiedBy: "bluetooth_immediate",
      lastBluetoothPresentAt: now,
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
      connectedSince: existingDevice.connectedSince ?? now,
      attendanceStatus: attendanceStateFromDevice(existingDevice),
      attendanceChangedAt: attendanceChangedAtFromDevice(existingDevice) ?? now,
      attendanceOrigin: existingDevice.attendanceOrigin ?? "bluetooth",
      attendanceVerificationStatus:
        existingDevice.attendanceVerificationStatus
        ?? (existingDevice.status === "present" ? "verified" : "unverified"),
      attendanceVerifiedBy:
        existingDevice.attendanceVerifiedBy
        ?? (existingDevice.status === "present" ? "bluetooth_immediate" : "none"),
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
    const devices = await ctx.db.query("devices").collect();

    return devices
      .filter((d) => !d.pendingRegistration && attendanceStateFromDevice(d) === "present")
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
    const devices = await ctx.db.query("devices").collect();

    return devices
      .filter((d) => !d.pendingRegistration && attendanceStateFromDevice(d) === "absent")
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
      action: ACTION_FROM_STATUS[args.status],
      origin: "bluetooth",
      verificationStatus: "verified",
      verifiedBy: args.status === "present" ? "bluetooth_immediate" : "bluetooth_disconnect",
      eventTimestamp: now,
      effectiveTimestamp: now,
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

    return logs.map((log: any) => normalizeAttendanceLogForResponse(log));
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

export const expirePendingAttendanceVerifications = internalMutation({
  args: {},
  handler: async (ctx: any) => {
    const now = Date.now();
    const devices = await ctx.db.query("devices").collect();
    let updatedCount = 0;

    for (const device of devices) {
      if (
        (device.pendingVerificationAction === "check_in" || device.pendingVerificationAction === "check_out")
        && typeof device.pendingVerificationExpiresAt === "number"
        && device.pendingVerificationExpiresAt <= now
      ) {
        await settleExpiredPendingVerification(ctx, device, now);
        updatedCount += 1;
      }
    }

    return { updatedCount };
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
  args: {
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let canManageBoundary = false;
    try {
      canManageBoundary = await hasBoundaryAdminAccess(ctx, args.email);
    } catch {
      canManageBoundary = false;
    }
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
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const canManageBoundary = await hasBoundaryAdminAccess(ctx, args.email);
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
      attendanceStatus: attendanceStateFromDevice(device),
      attendanceChangedAt: attendanceChangedAtFromDevice(device),
      attendanceOrigin: device.attendanceOrigin ?? "bluetooth",
      attendanceVerificationStatus:
        device.attendanceVerificationStatus
        ?? (device.status === "present" ? "verified" : "unverified"),
      attendanceVerifiedBy:
        device.attendanceVerifiedBy
        ?? (device.status === "present" ? "bluetooth_immediate" : "none"),
      latestAppIntent: device.latestAppIntent ?? null,
      latestAppIntentAt: device.latestAppIntentAt ?? null,
      pendingVerificationAction: isManualAttendanceDriver(device)
        ? null
        : (device.pendingVerificationAction ?? null),
      pendingVerificationExpiresAt: isManualAttendanceDriver(device)
        ? null
        : (device.pendingVerificationExpiresAt ?? null),
      attendanceDriver: isManualAttendanceDriver(device) ? "manual" : "bluetooth",
      lastBluetoothPresentAt: device.lastBluetoothPresentAt ?? null,
      lastBluetoothAbsentAt: device.lastBluetoothAbsentAt ?? null,
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
      ...buildAttendanceStatePayload(device, normalizedEmail),
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
    let currentDevice = await clearPendingVerificationForAppFlip(ctx, device);
    const desiredAction: AttendanceAction =
      attendanceStateFromDevice(currentDevice) === "present" ? "check_out" : "check_in";

    let devicePatch: Record<string, any>;
    let requestedStatus: AttendanceStatusValue;

    if (desiredAction === "check_in") {
      requestedStatus = "present";
      await createAttendanceEvent(ctx, currentDevice, {
        action: "check_in",
        origin: "app",
        verificationStatus: "verified",
        verifiedBy: "manual",
        eventTimestamp: now,
        effectiveTimestamp: now,
      });
      await auditAttendance(ctx, currentDevice._id, "Checked in via app (manual, independent of bluetooth)");
      devicePatch = {
        appStatus: "present",
        appLastSeen: now,
        latestAppIntent: "check_in",
        latestAppIntentAt: now,
        attendanceStatus: "present",
        attendanceChangedAt: now,
        attendanceOrigin: "app",
        attendanceVerificationStatus: "verified",
        attendanceVerifiedBy: "manual",
        attendanceDriver: "manual",
        ...clearedPendingVerificationPatch(),
      };
    } else {
      requestedStatus = "absent";
      await createAttendanceEvent(ctx, currentDevice, {
        action: "check_out",
        origin: "app",
        verificationStatus: "verified",
        verifiedBy: "manual",
        eventTimestamp: now,
        effectiveTimestamp: now,
      });
      await auditAttendance(ctx, currentDevice._id, "Checked out via app (manual, independent of bluetooth)");
      devicePatch = {
        appStatus: "absent",
        appLastSeen: now,
        latestAppIntent: "check_out",
        latestAppIntentAt: now,
        attendanceStatus: "absent",
        attendanceChangedAt: now,
        attendanceOrigin: "app",
        attendanceVerificationStatus: "verified",
        attendanceVerifiedBy: "manual",
        attendanceDriver: "manual",
        ...clearedPendingVerificationPatch(),
      };
    }

    await ctx.db.patch(currentDevice._id, devicePatch);
    const updatedDevice = await refreshDevice(ctx, currentDevice._id);

    return {
      ...buildAttendanceStatePayload(updatedDevice, normalizedEmail),
      keyVersion: appConfig.keyVersion,
      boundaryEnforced: boundaryEnabled,
      requestedAction: desiredAction,
      requestedStatus,
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

    const rawLogs = await ctx.db
      .query("attendanceLogs")
      .withIndex("by_deviceId_timestamp", (q: any) => q.eq("deviceId", String(device._id)))
      .order("desc")
      .take(200);

    const records = rawLogs.map((log: any) => normalizeAttendanceLogForResponse(log));

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
        if (device.pendingRegistration || attendanceStateFromDevice(device) !== "present") {
          continue;
        }

        const manualDriver = isManualAttendanceDriver(device);
        const checkInMethod = manualDriver
          ? "manual"
          : device.attendanceOrigin === "app"
            ? device.attendanceVerificationStatus === "verified"
              ? "app+bluetooth"
              : "app"
            : "bluetooth";

        checkedInUsers.push({
          _id: device._id,
          name: deviceDisplayName(device),
          firstName: device.firstName,
          lastName: device.lastName,
          email: device.ucsdEmail,
          checkInTime: attendanceChangedAtFromDevice(device) || device.lastSeen || Date.now(),
          checkInMethod,
          bluetoothStatus: device.status === "present" ? "present" : "absent",
          status: device.status,
          appStatus: device.appStatus,
          attendanceStatus: attendanceStateFromDevice(device),
          attendanceOrigin: device.attendanceOrigin ?? "bluetooth",
          attendanceVerificationStatus:
            device.attendanceVerificationStatus
            ?? (device.status === "present" ? "verified" : "unverified"),
          pendingVerificationAction: manualDriver ? null : (device.pendingVerificationAction ?? null),
          attendanceDriver: manualDriver ? "manual" : "bluetooth",
        });
      }

      checkedInUsers.sort((a, b) => b.checkInTime - a.checkInTime);

      return checkedInUsers;
    } catch (error) {
      console.error("Error in getCheckedInUsers:", error);
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
      .query("attendanceLogs")
      .withIndex("by_deviceId_timestamp", (q: any) => q.eq("deviceId", String(args.deviceId)))
      .order("desc")
      .take(maxRecords);

    return logs.map((log: any) => normalizeAttendanceLogForResponse(log));
  },
});
