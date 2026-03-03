# Architecture

**Analysis Date:** 2026-03-03

## Pattern Overview

**Overall:** Event-driven, multi-tier architecture with real-time reactive updates

**Key Characteristics:**
- Convex backend-as-a-platform provides managed database, real-time subscriptions, and serverless functions
- Astro frontend with two distinct views (dashboard and PWA) sharing common Convex client
- Rust agent for Bluetooth scanning that integrates with Convex via HTTP API
- External integration layer for Discord/Slack notifications
- Cron-based background tasks for cleanup and notification updates

## Layers

**Presentation Layer (Astro Frontend):**
- Purpose: User interface for dashboard administration and mobile PWA
- Location: `src/pages/`
- Contains: Astro page components (`index.astro`, `pwa/index.astro`), client-side scripts (`src/scripts/`), styles (`src/styles/`)
- Depends on: Convex client for data, Tailwind CSS for styling
- Used by: Web browsers and mobile PWA

**Data Access Layer (Convex Backend):**
- Purpose: Core business logic, data persistence, and real-time reactive queries
- Location: `convex/`
- Contains: Schema definition, queries, mutations, internal mutations, actions, HTTP endpoints, cron jobs
- Depends on: Convex platform (managed service)
- Used by: Frontend via ConvexClient, Rust agent via HTTP API, external integrations via webhooks

**Integration Layer:**
- Purpose: External service configuration and notification dispatch
- Location: `convex/integrations.ts`, `convex/notifications.ts`
- Contains: Integration CRUD operations, Discord/Slack API calls, message update logic
- Depends on: Data Access Layer for device status, external Discord/Slack APIs
- Used by: Cron jobs, internal mutations

**Agent Layer (Rust):**
- Purpose: Bluetooth scanning and presence detection on physical hardware
- Location: `rust-agent/src/`
- Contains: Bluetooth probing, presence detection loop, Convex client, GUI for configuration
- Depends on: System Bluetooth stack, Convex HTTP API
- Used by: Background service on Raspberry Pi/Linux

**Auth Layer:**
- Purpose: Authentication for dashboard (password-based) and PWA (Google OAuth)
- Location: `convex/auth.ts`, `convex/betterAuth.ts`, `convex/http.ts`
- Contains: Password validation, Auth configuration, OAuth flow
- Depends on: better-auth library, Convex auth components
- Used by: Frontend login flows

## Data Flow

**Device Detection Flow:**

1. Rust agent (`rust-agent/src/bluetooth_probe.rs`) scans for nearby Bluetooth devices at configured intervals
2. Device data (MAC address, RSSI) sent to Convex via `convex/devices.ts` mutations
3. Convex stores/updates device records in `devices` table with timestamps (`lastSeen`, `firstSeen`)
4. Grace period logic (`GRACE_PERIOD_SECONDS = 300`) determines if device status should flip from "present" to "absent"
5. Status changes logged to `deviceLogs` table via `convex/logs.ts`
6. Frontend subscribes to device changes via Convex client's reactive queries

**Status Update Flow:**

1. Mobile app (PWA) sends POST to `/api/change_status` with API key, email, and optional GPS coordinates
2. `convex/http.ts` validates API key and checks geofence if latitude/longitude provided
3. Mutation `flipAppStatusByEmail` updates `appStatus` on device record
4. New status triggers `deviceLogs` entry
5. Next cron run updates Discord/Slack notifications

**Notification Flow:**

1. Cron job runs every 1 minute (`updatePresenceNotifications`)
2. Fetches all present users via `getPresentUsers` query
3. Fetches configured integrations via `getIntegrations` query
4. For each enabled integration:
   - Builds message payload (embed or plain text)
   - Updates existing message or creates new one
   - Stores message ID for future updates via `updateIntegrationMessage` internal mutation

**Dashboard Real-time Updates:**

1. Browser loads `src/pages/index.astro`
2. Script imports Convex client from `convex/browser`
3. Subscribes to queries: `devices:getActiveDevices`, `devices:getPendingDevices`
4. Convex pushes updates whenever underlying data changes
5. DOM updates rendered via functions in `src/scripts/dashboard.ts`

**PWA OAuth Flow:**

1. User clicks "Sign in with Google" in `src/pages/pwa/index.astro`
2. `better-auth` redirects to Google OAuth
3. One-time token verification via `crossDomainClient` plugin
4. Session established and stored in browser
5. User's email matched against `ucsdEmail` field in `devices` table
6. If match found, user can toggle status; otherwise shows mismatch screen

**State Management:**

- Frontend: Convex client handles reactive state automatically via subscriptions
- Backend: Convex single source-of-truth database with ACID transactions
- Notifications: Message IDs stored in `integrations` table for idempotent updates
- PWA: Session state managed by better-auth cookies

## Key Abstractions

**Convex Function Types:**
- Purpose: Separate read, write, internal, and action operations with appropriate access controls
- Examples: `convex/devices.ts` (queries/mutations/actions), `convex/logs.ts` (query/mutation), `convex/notifications.ts` (internalAction)
- Pattern: Use `query` for reads, `mutation` for writes, `internalMutation` for system-internal writes, `action` for network calls or external I/O

**Device Status Model:**
- Purpose: Represent presence state with grace periods for flaky Bluetooth
- Examples: `convex/schema.ts` (devices table), `convex/devices.ts` (cleanup logic)
- Pattern: Dual status fields (`status` for Bluetooth, `appStatus` for PWA) with separate timestamps (`lastSeen`, `appLastSeen`)

**Integration Configuration:**
- Purpose: Externalize notification platform settings
- Examples: `convex/schema.ts` (integrations table), `convex/integrations.ts` (CRUD operations)
- Pattern: Store configuration as flexible object with optional fields, separate message tracking for updates

**Geofence Validation:**
- Purpose: Ensure PWA status changes only within physical boundary
- Examples: `convex/devices.ts` (distance calculation using Haversine formula)
- Pattern: Store boundary config (lat/lon/radius/unit) in `appConfig` table, validate on status flip

**Admin Authorization:**
- Purpose: Protect sensitive operations
- Examples: `convex/devices.ts` (requireAdmin helper), `convex/auth.ts` (validatePassword query)
- Pattern: Compare provided password against environment variables (`ADMIN_PASSWORD`, `AUTH_PASSWORD)

## Entry Points

**Astro Dashboard:**
- Location: `src/pages/index.astro`
- Triggers: HTTP GET request to root path
- Responsibilities: Authentication UI, device grid display, pending device list, admin settings, logs view

**PWA Application:**
- Location: `src/pages/pwa/index.astro`
- Triggers: HTTP GET request to `/pwa/`
- Responsibilities: Google OAuth sign-in, status toggle, location verification, activity logs display

**Convex HTTP API:**
- Location: `convex/http.ts`
- Triggers: External HTTP POST requests
- Responsibilities: `/api/change_status` (mobile app status), `/api/fetch` (status retrieval), `/api/attendance` (attendance history), CORS handling

**Rust Agent:**
- Location: `rust-agent/src/main.rs`
- Triggers: System boot or manual execution
- Responsibilities: Bluetooth scanning loop, Convex API communication, GUI for configuration

**Cron Jobs:**
- Location: `convex/crons.ts`
- Triggers: Scheduled by Convex platform
- Responsibilities: `updatePresenceNotifications` (every minute), `cleanupExpiredGracePeriodsInternal` (every minute), `cleanupOldLogs` (daily at midnight)

## Error Handling

**Strategy:** Throw errors from mutations/queries, catch in frontend with user-friendly toasts

**Patterns:**

- HTTP endpoints return JSON error responses with status codes (401 for auth, 403 for boundary violation, 400 for invalid input)
- Frontend scripts (`src/scripts/dashboard.ts`, `src/scripts/pwa.ts`) call `showToast(message, "error")` for UI feedback
- Convex functions validate inputs using `v` types and throw custom error messages
- Cron jobs log errors via `console.error` without blocking other integrations

## Cross-Cutting Concerns

**Logging:** Server-side logs via `console.error` in Convex functions, client-side logs in browser console
**Validation:** Input validation using Convex `v` types in mutation args, runtime checks in HTTP endpoints
**Authentication:** Password-based for dashboard (`convex/auth.ts`), Google OAuth for PWA (`convex/betterAuth.ts`), Bearer token for HTTP API
**Environment Configuration:** Required env vars: `ADMIN_PASSWORD`, `AUTH_PASSWORD`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CONVEX_URL`

---

*Architecture analysis: 2026-03-03*
