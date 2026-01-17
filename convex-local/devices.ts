import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";

const GRACE_PERIOD_SECONDS = 300;

export const getDevices = query({
  args: {},
  handler: async (ctx) => {
    const devices = await ctx.db.query("devices").collect();
    return devices.map(
      (device: Doc<"devices">) => ({
        macAddress: device.macAddress,
        name: device.name,
        status: device.status,
        lastSeen: device.lastSeen,
      }),
    );
  },
});

export const upsertDevice = mutation({
  args: {
    macAddress: v.string(),
    name: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const existingDevice = await ctx.db
      .query("devices")
      .withIndex("by_macAddress", (q) => q.eq("macAddress", args.macAddress))
      .first();

    const now = Date.now();

    if (existingDevice) {
      await ctx.db.patch(existingDevice._id, {
        name: args.name,
        status: args.status,
        lastSeen: now,
      });
      return { ...existingDevice, name: args.name, status: args.status, lastSeen: now };
    } else {
      const deviceId = await ctx.db.insert("devices", {
        macAddress: args.macAddress,
        name: args.name,
        status: args.status,
        lastSeen: now,
        firstSeen: now,
        gracePeriodEnd: now,
        pendingRegistration: false,
      });
      return {
        _id: deviceId,
        macAddress: args.macAddress,
        name: args.name,
        status: args.status,
        lastSeen: now,
        firstSeen: now,
        gracePeriodEnd: now,
        pendingRegistration: false,
      };
    }
  },
});

export const updateDeviceStatus = mutation({
  args: {
    macAddress: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const existingDevice = await ctx.db
      .query("devices")
      .withIndex("by_macAddress", (q) => q.eq("macAddress", args.macAddress))
      .first();

    if (!existingDevice) {
      throw new Error(`Device with MAC address ${args.macAddress} not found`);
    }

    const now = Date.now();

    if (args.status === "absent" && existingDevice.pendingRegistration) {
      await ctx.db.delete(existingDevice._id);
      return { ...existingDevice, status: "absent", lastSeen: now };
    }

    await ctx.db.patch(existingDevice._id, {
      status: args.status,
      lastSeen: now,
    });

    return {
      ...existingDevice,
      status: args.status,
      lastSeen: now,
    };
  },
});

export const registerDevice = mutation({
  args: {
    macAddress: v.string(),
    name: v.string(),
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
    const deviceId = await ctx.db.insert("devices", {
      macAddress: args.macAddress,
      name: args.name,
      status: "absent",
      lastSeen: now,
      firstSeen: now,
      gracePeriodEnd: now,
      pendingRegistration: false,
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
    const deviceId = await ctx.db.insert("devices", {
      macAddress: args.macAddress,
      name: "",
      status: "present",
      lastSeen: now,
      firstSeen: now,
      gracePeriodEnd,
      pendingRegistration: true,
    });

    return {
      _id: deviceId,
      macAddress: args.macAddress,
      name: "",
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
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const existingDevice = await ctx.db
      .query("devices")
      .withIndex("by_macAddress", (q) => q.eq("macAddress", args.macAddress))
      .first();

    if (!existingDevice) {
      throw new Error(`Device with MAC address ${args.macAddress} not found`);
    }

    const now = Date.now();
    await ctx.db.patch(existingDevice._id, {
      name: args.name,
      pendingRegistration: false,
      lastSeen: now,
    });

    return {
      ...existingDevice,
      name: args.name,
      pendingRegistration: false,
      lastSeen: now,
    };
  },
});

export const cleanupExpiredGracePeriods = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const devices = await ctx.db.query("devices").collect();

    const expiredDevices = devices.filter(
      (device) =>
        device.pendingRegistration &&
        now > device.gracePeriodEnd &&
        device.status === "absent",
    );

    for (const device of expiredDevices) {
      await ctx.db.delete(device._id);
    }

    return { deletedCount: expiredDevices.length };
  },
});
