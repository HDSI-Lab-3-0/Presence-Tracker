import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc } from "./_generated/dataModel";

/**
 * Log a device change event (create, update, status_change, etc.)
 */
export const logDeviceChange = mutation({
  args: {
    deviceId: v.id("devices"),
    changeType: v.string(),
    details: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("deviceLogs", {
      deviceId: args.deviceId,
      changeType: args.changeType,
      timestamp: now,
      details: args.details,
    });
    return { success: true };
  },
});

/**
 * Fetch all device status change logs with device information joined.
 * Requires admin password for access.
 */
export const getAllStatusLogs = query({
  args: { adminPassword: v.string() },
  handler: async (ctx, args) => {
    // Validate admin password
    const environment = process.env;
    const adminPassword = environment.ADMIN_PASSWORD;
    if (args.adminPassword !== adminPassword) {
      throw new Error("Invalid admin password");
    }

    // Fetch all device logs
    const logs = await ctx.db.query("deviceLogs").withIndex("by_timestamp").order("desc").collect();

    // Fetch all devices to join information
    const devices = await ctx.db.query("devices").collect();
    const deviceMap = new Map(devices.map(d => [d._id.toString(), d]));

    // Join logs with device information
    const enrichedLogs = logs
      .filter(log => {
        // Only include status_change logs
        return log.changeType === "status_change";
      })
      .map((log) => {
        const device = deviceMap.get(log.deviceId.toString());
        const personName = device && device.firstName && device.lastName
          ? `${device.firstName} ${device.lastName}`
          : (device?.name || "Unknown");
        const macAddress = device?.macAddress || "Unknown";
        
        // Parse status from details
        const statusMatch = log.details?.match(/Status changed from (present|absent) to (present|absent)/);
        const status = statusMatch ? statusMatch[2] : "unknown";

        return {
          logId: log._id,
          deviceId: log.deviceId,
          personName,
          macAddress,
          status,
          timestamp: log.timestamp,
          details: log.details,
        };
      });

    return enrichedLogs;
  },
});
