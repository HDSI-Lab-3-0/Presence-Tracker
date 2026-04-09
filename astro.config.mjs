// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// Set ASTRO_BASE at build time: "/" for custom-domain root, "/repo-name/" for github.io project Pages.
// CI sets this; local default "/" matches dev.
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
