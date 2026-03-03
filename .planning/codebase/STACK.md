# Technology Stack

**Analysis Date:** 2026-03-03

## Languages

**Primary:**
- TypeScript (ES2020 target) - Used for Astro frontend, Convex backend functions, and client-side scripts

**Secondary:**
- Rust (2021 edition) - Presence tracking agent (`rust-agent/src/`) for Bluetooth operations
- TOML - Configuration format for rust-agent

## Runtime

**Environment:**
- Node.js (via Bun 1.2.22+ as runtime engine for Convex CLI and frontend dev)

**Package Manager:**
- Bun package manager
- Lockfile: `bun.lock` present

## Frameworks

**Core:**
- Astro 5.17.1 - Web framework for the frontend dashboard
- Convex 1.32.0 - Serverless backend for database, functions, and real-time updates
- Better Auth 1.4.9 - Authentication system with Convex integration (`@convex-dev/better-auth` 0.10.12)

**Styling:**
- Tailwind CSS 4.2.1 - Utility-first CSS framework via Vite plugin (`@tailwindcss/vite`)
- Vite - Build tool and module bundler

**Presentation:**
- Leaflet 1.9.4 - Interactive map library for presence boundary preview
- QRCode.js 1.0.0 - QR code generation for app linking

**Rust Agent:**
- eframe/egui 0.29 - GUI framework for agent mode
- bluer 0.17 - Bluetooth library for Linux (BlueZ)
- tokio 1.43 - Async runtime for Rust
- reqwest 0.12 - HTTP client for Rust
- chrono 0.4 - Date/time handling

## Key Dependencies

**Critical:**
- Convex - Core backend database and serverless functions. All data persistence and queries flow through Convex.
- Better Auth + `@convex-dev/better-auth` - Provides authentication and session management with Convex integration.
- Astro - Frontend framework for the dashboard web application.

**Infrastructure:**
- `@tailwindcss/vite` - Adds Tailwind CSS via Vite plugin
- TypeScript 5.9.3 - Type system for codebase

**Rust Agent Dependencies:**
- `bluer` - Bluetooth communication via BlueZ stack
- `tokio` - Async runtime
- `reqwest` - HTTP client for Convex API calls
- `eframe`/`egui` - GUI for agent configuration

## Configuration

**Environment:**
- Environment-based configuration via `.env` files
 - `.env.example` documents required variables
- Runtime config generation via `scripts/generate-runtime-config.mjs`
- Admin password required for integration settings

**Build:**
- Astro config: `astro.config.mjs`
- TypeScript config: `tsconfig.json` (ES2020, Node16 module)
- Convex config: `convex/convex.config.ts` and `convex.json`
- Docker: Multi-stage build (oven/bun builder, nginx:alpine runner)

## Platform Requirements

**Development:**
- Bun runtime 1.2.22+ (`bun install`, `bun run`)
- Node.js (accessed via Bun)
- TypeScript 5.9.3
- Rust/cargo for rust-agent development
- BlueZ bluetooth stack (Linux) for rust-agent

**Production:**
- **Frontend**: Docker container with nginx:alpine, port 3132
- **Backend**: Convex cloud (serverless deployment)
- **Agent**: Linux host with BlueZ (Raspberry Pi 4/5 recommended)
- **Deployment**: GitHub Actions for GitHub Pages hosting

---

*Stack analysis: 2026-03-03*
