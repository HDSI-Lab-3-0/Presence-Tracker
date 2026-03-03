# External Integrations

**Analysis Date:** 2026-03-03

## APIs & External Services

**Convex:**
- Convex cloud platform - Serverless backend for all database operations, queries, mutations, and auth
  - SDK/Client: `convex` 1.32.0, `@convex-dev/better-auth` 0.10.12
  - Client SDK: `convex/browser` (for web dashboard)
  - Rust client: `convex` 0.10 crate (for rust-agent)
  - Deployment URL: `CONVEX_DEPLOYMENT_URL` env var
  - Functions location: `/convex/*.ts`

**Discord:**
- Discord Webhooks - Send presence status notifications to Discord channels
  - Config: Discord webhook URL stored in `convex.integrations` table
  - Method: POST to webhook URL with JSON payloads (embed support)
  - Features: Rich embeds, persistent message updates, `useEmbeds` and `showAbsentUsers` options
  - Implementation: `convex/notifications.ts` → `handleDiscord()`

**Slack:**
- Slack Web API - Bot-based notifications to Slack channels
  - Config: Bot token (`xoxb-...`) and channel ID stored in `convex.integrations` table
  - Method: `POST https://slack.com/api/chat.postMessage` and `chat.update`
  - Features: Persistent message updates, `showAbsentUsers` option
  - Implementation: `convex/notifications.ts` → `handleSlack()`

**OpenStreetMap / Leaflet:**
- OpenStreetMap tiles - Map imagery for presence boundary preview
  - Endpoint: `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`
  - Purpose: Visualize geographic boundary for mobile app linking
  - Library: Leaflet 1.9.4 (loaded from unpkg CDN)

**QR Code Generation:**
- QRCode.js - Generate QR codes for mobile app linking configuration
  - Source: `https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js`
  - Purpose: Encode API key and endpoint for mobile app scanning

## Data Storage

**Databases:**
- Convex Serverless Database
  - Connection: `CONVEX_DEPLOYMENT_URL` or `CONVEX_URL` env vars
  - Client: Convex SDK (browser for web, rust crate for agent)
  - Tables: `devices`, `appConfig`, `deviceLogs`, `integrations`, `integrationMessages`, `attendanceLogs`
  - Features: Real-time subscriptions, indexed queries, generated TypeScript types

**File Storage:**
- None detected - All data stored in Convex database

**Caching:**
- None detected at application level

## Authentication & Identity

**Auth Provider:**
- Better Auth (via `@convex-dev/better-auth` adapter) - Custom authentication on Convex
  - Implementation: Password-based authentication with admin/user roles
  - Session storage: `sessionStorage` (client-side)
  - Admin password validation: `auth:validatePassword` Convex query
  - Config: `convex/betterAuth.ts`, `convex/auth.config.ts`
  - Protection: Admin password required for integration settings (`ADMIN_PASSWORD` env var)

## Monitoring & Observability

**Error Tracking:**
- None detected - Console logging only

**Logs:**
- Browser console logging throughout frontend scripts
- Convex functions use `console.error()` for error logging
- Rust agent uses logging module (`rust-agent/src/logging.rs`)

## CI/CD & Deployment

**Hosting:**
- GitHub Pages - Frontend web dashboard hosting
  - Workflow: `.github/workflows/deploy.yml`
  - Triggers: Push to `main` branch, manual dispatch
  - Build: Bun → Astro build → Upload artifact → Deploy to Pages

**Docker:**
- Frontend containerized with nginx:alpine
  - Dockerfile: Multi-stage (oven/bun builder → nginx runner)
  - Port: 3132
  - docker-compose.yml: Web dashboard service only

**CI Pipeline:**
- GitHub Actions for frontend deployment to GitHub Pages

**Convex Deployment:**
- Manual via `bun run deploy` or `convex deploy` command

## Environment Configuration

**Required env vars:**
- `CONVEX_DEPLOYMENT_URL` - Convex cloud deployment URL
- `CONVEX_URL_MODE` - URL configuration mode
- `CONVEX_SELF_HOSTED_URL` - Optional self-hosted Convex instance
- `ORGANIZATION_NAME` - Display name for organization
- `ADMIN_PASSWORD` - Admin password for settings (stored in Convex env)
- `FRONTEND_PORT` - Web dashboard port (default: 3132)

**Optional env vars:**
- Rust agent environment variables documented in `.env.example` (polling intervals, tiered scanning, bluetooth settings, etc.)

**Secrets location:**
- GitHub Secrets for CI/CD (`CONVEX_URL_MODE`, `CONVEX_DEPLOYMENT_URL`, `CONVEX_SELF_HOSTED_URL`, `ORGANIZATION_NAME`)
- Convex environment variables for backend (`ADMIN_PASSWORD`)
- `rust-agent/.env` for local agent configuration

## Webhooks & Callbacks

**Incoming:**
- None detected by default

**Outgoing:**
- Discord Webhooks - Presence status notifications (`POST` to webhook URLs)
- Slack Web API - Presence status notifications (`POST` to `chat.postMessage` and `chat.update`)

## Custom HTTP API Endpoints

**Convex HTTP Routes:**
- `POST /api/change_status` - Toggle user presence status via API key
- `POST /api/fetch` - Fetch user status via API key
- `POST /api/attendance` - Get attendance history via API key
- Better Auth routes - `/api/auth/*` (registered via `@convex-dev/better-auth`)

**Mobile App API:**
- Mobile apps can call `/api/change_status` and `/api/fetch` using API key from `appConfig` table
- Supports optional latitude/longitude validation with boundary enforcement

---

*Integration audit: 2026-03-03*
