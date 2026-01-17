import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  devices: defineTable({
    macAddress: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    // specific fields
    status: v.string(),
    lastSeen: v.number(),
    connectedSince: v.optional(v.number()), // Time when status became "present"
    firstSeen: v.number(),
    gracePeriodEnd: v.number(),
    pendingRegistration: v.boolean(),
    // legacy support (optional)
    name: v.optional(v.string()),
  })
    .index("by_macAddress", ["macAddress"])
    .index("by_status", ["status"]),

  deviceLogs: defineTable({
    deviceId: v.id("devices"),
    changeType: v.string(), // "create", "update", "status_change"
    timestamp: v.number(),
    details: v.string(),
  })
    .index("by_deviceId", ["deviceId"])
    .index("by_timestamp", ["timestamp"]),
});
