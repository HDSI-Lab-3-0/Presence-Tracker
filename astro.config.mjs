// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

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
