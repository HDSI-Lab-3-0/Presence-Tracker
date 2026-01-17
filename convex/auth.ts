import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Validate the provided password against stored passwords.
 * Returns the access level: "admin", "user", or null if invalid.
 * 
 * - AUTH_PASSWORD: Regular user access (can view but not edit)
 * - ADMIN_PASSWORD: Full admin access (can view and edit/manage)
 */
export const validatePassword = query({
    args: { password: v.string() },
    handler: async (ctx, args) => {
        const authPassword = process.env.AUTH_PASSWORD;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (!authPassword) {
            console.error("AUTH_PASSWORD environment variable is not set");
            return { success: false, error: "Authentication not configured" };
        }

        // Check admin password first (if set)
        if (adminPassword && args.password === adminPassword) {
            return { success: true, role: "admin" };
        }

        // Check regular user password
        if (args.password === authPassword) {
            return { success: true, role: "user" };
        }

        return { success: false, error: "Incorrect password" };
    },
});
