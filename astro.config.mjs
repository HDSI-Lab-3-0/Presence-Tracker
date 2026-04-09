// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Build-time base (asset URLs are rewritten to be HTML-relative in scripts/relativize-astro-assets.mjs).
const base = process.env.ASTRO_BASE?.trim() || "/";

export default defineConfig({
  base,
  vite: {
    plugins: [tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/convex")) {
              return "convex";
            }
          },
        },
      },
    },
  },
});
