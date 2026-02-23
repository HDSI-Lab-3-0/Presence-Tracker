import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  devices: defineTable({
    macAddress: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    ucsdEmail: v.optional(v.string()),
    // specific fields
    status: v.string(),
    appStatus: v.optional(v.union(v.literal("present"), v.literal("absent"))),
    appLastSeen: v.optional(v.number()),
    lastSeen: v.number(),
    connectedSince: v.optional(v.number()), // Time when status became "present"
    firstSeen: v.number(),
    gracePeriodEnd: v.number(),
    pendingRegistration: v.boolean(),
    // legacy support (optional)
    name: v.optional(v.string()),
  })
    .index("by_macAddress", ["macAddress"])
    .index("by_ucsdEmail", ["ucsdEmail"])
    .index("by_status", ["status"]),

  appConfig: defineTable({
    apiKey: v.string(),
    keyVersion: v.number(),
    rotatedAt: v.number(),
  }),

  deviceLogs: defineTable({
    deviceId: v.id("devices"),
    changeType: v.string(), // "create", "update", "status_change"
    timestamp: v.number(),
    details: v.string(),
  })
    .index("by_deviceId", ["deviceId"])
    .index("by_timestamp", ["timestamp"]),

  integrations: defineTable({
    type: v.union(v.literal("discord"), v.literal("slack")),
    config: v.object({
      webhookUrl: v.optional(v.string()),
      botToken: v.optional(v.string()),
      channelId: v.optional(v.string()),
      displayName: v.optional(v.string()),
      useEmbeds: v.optional(v.boolean()),
      showAbsentUsers: v.optional(v.boolean()),
    }),
    isEnabled: v.boolean(),
    // Slack message ts or Discord message ID for persistent message updates
    messageId: v.optional(v.string()),
    // Keep track of the last successfully sent message ID to allow threading or replacement
    lastMessageId: v.optional(v.string()),
  }).index("by_type", ["type"]),

  integrationMessages: defineTable({
    platform: v.union(v.literal("slack"), v.literal("discord")),
    messageId: v.string(),
    channelId: v.optional(v.string()),
    lastUpdateTimestamp: v.number(),
  }).index("by_platform", ["platform"]),

  attendanceLogs: defineTable({
    userId: v.string(),
    userName: v.string(),
    status: v.union(v.literal("present"), v.literal("absent")),
    timestamp: v.number(),
    deviceId: v.string(),
  }).index("by_timestamp", ["timestamp"]),
});
