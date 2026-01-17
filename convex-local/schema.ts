import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  devices: defineTable({
    macAddress: v.string(),
    name: v.string(),
    status: v.string(),
    lastSeen: v.number(),
    firstSeen: v.number(),
    gracePeriodEnd: v.number(),
    pendingRegistration: v.boolean(),
  })
    .index("by_macAddress", ["macAddress"])
    .index("by_status", ["status"]),
});
