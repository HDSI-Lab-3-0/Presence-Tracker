# Codebase Structure

**Analysis Date:** 2026-03-03

## Directory Layout

```
HDSI-Presence-Tracker/
├── convex/                  # Convex backend code
│   ├── _generated/          # Auto-generated Convex types
│   ├── auth.config.ts       # Auth configuration for better-auth
│   ├── auth.ts              # Password validation queries
│   ├── betterAuth.ts        # better-auth setup with Google OAuth
│   ├── convex.config.ts     # Convex app configuration
│   ├── crons.ts             # Scheduled cron jobs
│   ├── devices.ts           # Device management (queries/mutations/actions)
│   ├── fixPendingDevices.ts # One-time migration script
│   ├── http.ts              # HTTP API endpoints
│   ├── integrations.ts      # Integration CRUD operations
│   ├── logs.ts              # Device logging queries/mutations
│   ├── notifications.ts     # Discord/Slack notification actions
│   └── schema.ts            # Database schema definition
├── config/                  # Configuration files
│   └── agent.toml           # Rust agent configuration
├── docker/                  # Docker deployment files
│   ├── Dockerfile           # Container image build
│   └── docker-compose.yml   # Service orchestration
├── public/                  # Static assets
│   └── pwa/                 # PWA icons and manifest
├── rust-agent/              # Rust Bluetooth scanning agent
│   ├── src/
│   │   ├── main.rs          # CLI entry point
│   │   ├── bluetooth_agent.rs # BlueZ agent interface
│   │   ├── bluetooth_probe.rs # Device probing
│   │   ├── config.rs        # Configuration parsing
│   │   ├── convex_client.rs # Convex HTTP client
│   │   ├── gui.rs           # Configuration UI (egui)
│   │   ├── gui_simple.rs    # Simplified GUI
│   │   ├── logging.rs       # Logging utilities
│   │   └── presence_loop.rs # Main presence detection loop
│   └── Cargo.toml           # Rust dependencies
├── scripts/                 # Utility scripts
│   └── generate-runtime-config.mjs # Config generation
├── src/                     # Astro frontend source
│   ├── pages/
│   │   ├── index.astro      # Dashboard page
│   │   └── pwa/
│   │       ├── index.astro  # PWA mobile page
│   │       └── service-worker.js.ts # Service worker
│   ├── scripts/
│   │   ├── auth.ts          # Authentication logic
│   │   ├── dashboard.ts     # Dashboard UI and interactions
│   │   ├── integrations.ts  # Integration modal logic
│   │   ├── logs.ts          # Logs view logic
│   │   ├── pwa.ts           # PWA application logic
│   │   └── globals.d.ts     # Global type definitions
│   └── styles/
│       ├── global.css       # Global styles
│       ├── dashboard.css    # Dashboard-specific styles
│       └── pwa.css          # PWA-specific styles
├── .planning/               # Planning documents
│   └── codebase/            # Architecture analysis
├── .env.example             # Environment variable template
├── astro.config.mjs         # Astro framework config
├── package.json             # Node.js dependencies
├── setup.sh                 # Setup/installation script
└── README.md                # Project documentation
```

## Directory Purposes

**convex/:
- Purpose: Convex backend-as-a-platform code (database, functions, HTTP endpoints)
- Contains: Schema definition, queries, mutations, actions, cron jobs, HTTP routes, auth
- Key files: `schema.ts` (data model), `devices.ts` (core business logic), `http.ts` (external API)

**src/:
- Purpose: Astro frontend source code for dashboard and PWA
- Contains: Astro page components, client-side TypeScript scripts, CSS stylesheets
- Key files: `pages/index.astro` (dashboard), `pages/pwa/index.astro` (mobile app), `scripts/dashboard.ts` (main UI)

**rust-agent/:
- Purpose: Bluetooth scanning agent running on Raspberry Pi or Linux
- Contains: Rust modules for Bluetooth detection, Convex integration, GUI, presence loop
- Key files: `src/main.rs` (CLI entry), `src/bluetooth_probe.rs` (device scanning), `src/presence_loop.rs` (presence detection)

**config/:
- Purpose: Runtime configuration files for agent and deployment
- Contains: TOML configuration for Rust agent
- Key files: `agent.toml` (Rust agent settings)

**public/:
- Purpose: Static web assets
- Contains: PWA icons, manifest, service worker, other public files
- Key files: `pwa/icons/` (app icons), `pwa/manifest.json` (PWA manifest)

**docker/:
- Purpose: Container deployment configuration
- Contains: Dockerfile and docker-compose for production deployment
- Key files: `Dockerfile` (image build), `docker-compose.yml` (services)

**scripts/:
- Purpose: Build and utility scripts
- Contains: Config generation, setup helpers
- Key files: `generate-runtime-config.mjs` (runtime config builder)

## Key File Locations

**Entry Points:**
- `src/pages/index.astro`: Main dashboard web page
- `src/pages/pwa/index.astro`: Mobile PWA application
- `rust-agent/src/main.rs`: Rust agent CLI entry point
- `convex/http.ts`: HTTP API endpoints for external access

**Configuration:**
- `astro.config.mjs`: Astro framework configuration (Tailwind, build settings)
- `convex/convex.config.ts`: Convex app configuration
- `config/agent.toml`: Rust agent configuration
- `convex/auth.config.ts`: better-auth configuration

**Core Logic:**
- `convex/schema.ts`: Database schema (tables, indexes)
- `convex/devices.ts`: Device management (status, registration, cleanup)
- `convex/notifications.ts`: Discord/Slack notification logic
- `rust-agent/src/presence_loop.rs`: Main Bluetooth presence detection loop

**Testing:**
- Not detected - no dedicated test directory found

## Naming Conventions

**Files:**
- `.astro`: Astro page components (`index.astro`, `index.astro`)
- `.ts`: TypeScript source files (convex functions, client scripts, service worker)
- `.mjs`: JavaScript modules for Node.js (build scripts)
- `.rs`: Rust source modules (bluetooth, config, GUI)
- `.toml`: Configuration files (agent settings)
- `.css`: Stylesheets (component-scoped and global)

**Directories:**
- `camelCase`: No detected - snake_case used for rust-agent
- Mixed: `src/`, `convex/`, `public/`, `config/`, `scripts/`, `docker/`, `rust-agent/`, `.planning/`

## Where to Add New Code

**New Backend Feature:**
- Primary code: `convex/*.ts` (add new file or existing based on concern)
- Schema changes: `convex/schema.ts`
- HTTP endpoints: `convex/http.ts`

**New Frontend Feature:**
- UI components: `src/pages/*.astro` (based on view type)
- Client logic: `src/scripts/*.ts` (matching file to component)
- Styles: `src/styles/*.css` (component CSS)

**New Cron Job:**
- Implementation: `convex/crons.ts` (add new interval/cron schedule)
- Logic: New function in relevant `convex/*.ts` file (e.g., `devices.ts` for device-related)

**New Integration:**
- Implementation: `convex/integrations.ts` (add query/mutation), `convex/notifications.ts` (add handler)
- Schema: `convex/schema.ts` (add integration type to `integrations` union)

**Rust Agent Module:**
- Implementation: `rust-agent/src/*.rs` (new module file)
- Export: Add `mod` declaration in `rust-agent/src/main.rs`

**Utility Functions:**
- Shared helpers: `src/scripts/globals.d.ts` (types), individual script files in `src/scripts/`

## Special Directories

**convex/_generated/:
- Purpose: Auto-generated Convex type definitions (API, data model, server)
- Generated: Yes (by Convex CLI)
- Committed: Yes (for TypeScript type checking)

**public/pwa/:
- Purpose: PWA-specific assets (icons, manifest, service worker)
- Generated: No
- Committed: Yes

**dist/:
- Purpose: Astro build output (deployed web assets)
- Generated: Yes (by `astro build`)
- Committed: No (gitignored)

**rust-agent/target/:
- Purpose: Rust build artifacts (compiled binaries)
- Generated: Yes (by `cargo build`)
- Committed: No (gitignored)

**node_modules/:
- Purpose: npm/bun dependency packages
- Generated: Yes (by package manager)
- Committed: No (gitignored)

---

*Structure analysis: 2026-03-03*
