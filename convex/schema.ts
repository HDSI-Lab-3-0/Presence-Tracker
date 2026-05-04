import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  devices: defineTable({
    macAddress: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    ucsdEmail: v.optional(v.string()),
    /** "manual" once user clocks via PWA; omit or "bluetooth" for BT-only roster */
    attendanceDriver: v.optional(v.union(v.literal("bluetooth"), v.literal("manual"))),
    // specific fields
    status: v.string(),
    appStatus: v.optional(v.union(v.literal("present"), v.literal("absent"))),
    appLastSeen: v.optional(v.number()),
    attendanceStatus: v.optional(v.union(v.literal("present"), v.literal("absent"))),
    attendanceChangedAt: v.optional(v.number()),
    attendanceOrigin: v.optional(v.union(v.literal("app"), v.literal("bluetooth"), v.literal("system"))),
    attendanceVerificationStatus: v.optional(
      v.union(
        v.literal("verified"),
        v.literal("unverified"),
        v.literal("pending"),
        v.literal("expired"),
        v.literal("inferred"),
      ),
    ),
    attendanceVerifiedBy: v.optional(
      v.union(
        v.literal("bluetooth_immediate"),
        v.literal("bluetooth_followup"),
        v.literal("bluetooth_disconnect"),
        v.literal("none"),
        v.literal("manual"),
        v.literal("system_inferred"),
      ),
    ),
    latestAppIntent: v.optional(v.union(v.literal("check_in"), v.literal("check_out"))),
    latestAppIntentAt: v.optional(v.number()),
    pendingVerificationAction: v.optional(v.union(v.literal("check_in"), v.literal("check_out"))),
    pendingVerificationExpiresAt: v.optional(v.number()),
    pendingVerificationEventId: v.optional(v.id("attendanceLogs")),
    lastBluetoothPresentAt: v.optional(v.number()),
    lastBluetoothAbsentAt: v.optional(v.number()),
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
    boundaryEnabled: v.optional(v.boolean()),
    boundaryLatitude: v.optional(v.number()),
    boundaryLongitude: v.optional(v.number()),
    boundaryRadius: v.optional(v.number()),
    boundaryRadiusUnit: v.optional(v.union(v.literal("meters"), v.literal("miles"))),
    /** YYYY-MM-DD (America/Los_Angeles) — last day pacificMidnightCheckoutIfDue ran */
    lastPacificMidnightCheckoutDay: v.optional(v.string()),
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
    action: v.optional(v.union(v.literal("check_in"), v.literal("check_out"))),
    origin: v.optional(v.union(v.literal("app"), v.literal("bluetooth"), v.literal("system"))),
    verificationStatus: v.optional(
      v.union(
        v.literal("verified"),
        v.literal("unverified"),
        v.literal("pending"),
        v.literal("expired"),
        v.literal("inferred"),
      ),
    ),
    verifiedBy: v.optional(
      v.union(
        v.literal("bluetooth_immediate"),
        v.literal("bluetooth_followup"),
        v.literal("bluetooth_disconnect"),
        v.literal("none"),
        v.literal("manual"),
        v.literal("system_inferred"),
      ),
    ),
    eventTimestamp: v.optional(v.number()),
    effectiveTimestamp: v.optional(v.number()),
    verificationDeadline: v.optional(v.number()),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_deviceId_timestamp", ["deviceId", "timestamp"]),
});
