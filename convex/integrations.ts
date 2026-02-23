import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";

const requireAdmin = (adminPassword: string) => {
    // @ts-ignore - process.env is available in Convex functions
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected || adminPassword !== expected) {
        throw new Error("Admin access required");
    }
};

export const getIntegrations = query({
    handler: async (ctx: any) => {
        return await ctx.db.query("integrations").collect();
    },
});

export const saveIntegration = mutation({
    args: {
        adminPassword: v.string(),
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
    },
    handler: async (ctx: any, args: any) => {
        requireAdmin(args.adminPassword);

        const existing = await ctx.db
            .query("integrations")
            .withIndex("by_type", (q: any) => q.eq("type", args.type))
            .first();

        if (existing) {
            await ctx.db.patch(existing._id, {
                config: args.config,
                isEnabled: args.isEnabled,
            });
        } else {
            await ctx.db.insert("integrations", {
                type: args.type,
                config: args.config,
                isEnabled: args.isEnabled,
            });
        }
    },
});

export const toggleIntegration = mutation({
    args: {
        adminPassword: v.string(),
        id: v.id("integrations"),
        isEnabled: v.boolean(),
    },
    handler: async (ctx: any, args: any) => {
        requireAdmin(args.adminPassword);
        await ctx.db.patch(args.id, { isEnabled: args.isEnabled });
    },
});

export const deleteIntegration = mutation({
    args: {
        adminPassword: v.string(),
        id: v.id("integrations"),
    },
    handler: async (ctx: any, args: any) => {
        requireAdmin(args.adminPassword);
        await ctx.db.delete(args.id);
    },
});

export const getIntegrationMessage = internalQuery({
    args: { platform: v.union(v.literal("slack"), v.literal("discord")) },
    handler: async (ctx: any, args: any) => {
        return await ctx.db
            .query("integrationMessages")
            .withIndex("by_platform", (q: any) => q.eq("platform", args.platform))
            .first();
    },
});

export const updateIntegrationMessage = internalMutation({
    args: {
        platform: v.union(v.literal("slack"), v.literal("discord")),
        messageId: v.string(),
        channelId: v.optional(v.string()),
    },
    handler: async (ctx: any, args: any) => {
        const existing = await ctx.db
            .query("integrationMessages")
            .withIndex("by_platform", (q: any) => q.eq("platform", args.platform))
            .first();

        const timestamp = Date.now();

        if (existing) {
            await ctx.db.patch(existing._id, {
                messageId: args.messageId,
                channelId: args.channelId,
                lastUpdateTimestamp: timestamp,
            });
        } else {
            await ctx.db.insert("integrationMessages", {
                platform: args.platform,
                messageId: args.messageId,
                channelId: args.channelId,
                lastUpdateTimestamp: timestamp,
            });
        }
    },
});

export const updateIntegrationMessageId = internalMutation({
    args: {
        id: v.id("integrations"),
        messageId: v.string(),
    },
    handler: async (ctx: any, args: any) => {
        await ctx.db.patch(args.id, {
            messageId: args.messageId,
        });
    },
});

