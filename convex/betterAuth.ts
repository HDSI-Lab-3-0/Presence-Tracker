import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex, crossDomain } from "@convex-dev/better-auth/plugins";
import { components } from "./_generated/api";
import { type DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { betterAuth } from "better-auth";
import authConfig from "./auth.config";

function normalizeBaseUrl(url?: string) {
  if (!url) return "";
  return url.replace("/api/query", "").replace("/api/mutation", "").replace(/\/$/, "");
}

function ensureHttpAccessibleUrl(url: string) {
  if (!url) return "";
  if (url.includes(".convex.cloud")) {
    return url.replace(".convex.cloud", ".convex.site");
  }
  return url;
}

function deriveAuthBaseUrl() {
  if (process.env.CONVEX_SITE_URL) {
    return ensureHttpAccessibleUrl(normalizeBaseUrl(process.env.CONVEX_SITE_URL));
  }
  if (process.env.CONVEX_URL) {
    return ensureHttpAccessibleUrl(normalizeBaseUrl(process.env.CONVEX_URL));
  }
  if (process.env.CONVEX_CLOUD_URL) {
    return ensureHttpAccessibleUrl(normalizeBaseUrl(process.env.CONVEX_CLOUD_URL));
  }
  return "http://localhost:3211";
}

const authBaseUrl = deriveAuthBaseUrl();
const siteUrl = process.env.SITE_URL || "http://localhost:3132";
const defaultTrustedOrigins = [siteUrl, "http://localhost:3132", "http://127.0.0.1:3132"];
if (process.env.FRONTEND_URL) {
  defaultTrustedOrigins.push(process.env.FRONTEND_URL);
}

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth({
    baseURL: authBaseUrl,
    trustedOrigins: [...new Set(defaultTrustedOrigins)],
    database: authComponent.adapter(ctx),
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      },
    },
    plugins: [
      crossDomain({ siteUrl }),
      convex({ authConfig }),
    ],
  });
};

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return authComponent.getAuthUser(ctx);
  },
});
