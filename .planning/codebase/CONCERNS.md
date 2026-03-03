# Codebase Concerns

**Analysis Date:** 2026-03-03

## Tech Debt

**Type Safety - @ts-nocheck on All Files:**
- Issue: Six main source files (`integrations.ts`, `pwa.ts`, `dashboard.ts`, `logs.ts`, `auth.ts`, `service-worker.js.ts`) use `// @ts-nocheck` which completely disables TypeScript's type checking. This eliminates all type safety benefits of using TypeScript.
- Files: `src/scripts/integrations.ts:1`, `src/scripts/pwa.ts:1`, `src/scripts/dashboard.ts:1`, `src/scripts/logs.ts:1`, `src/scripts/auth.ts:1`, `src/pages/pwa/service-worker.js.ts:1`
- Impact: All type errors, null reference issues, and type mismatches go undetected. Makes codebase fragile and prone to runtime errors.
- Fix approach: Remove `@ts-nocheck` directives one file at a time, fix resulting type errors, add proper interface definitions, particularly in `src/scripts/globals.d.ts` where `any` types are used.

**Large Files - Monolithic Modules:**
- Issue: Several files exceed 800 lines with mixed concerns, making them difficult to maintain and test. The backend `devices.ts` is 1380 lines.
- Files:
  - `convex/devices.ts` (1380 lines) - Mixed backend logic, schema, and CRUD operations
  - `src/scripts/integrations.ts` (916 lines) - Map preview, form handling, API calls all in one file
  - `src/scripts/pwa.ts` (843 lines) - Auth, location, UI state mixed together
- Impact: Modules doing too much makes testing impossible, changes risk breaking unrelated functionality.
- Fix approach: Split large files by concern:
  - `integrations.ts` → `integrations/ui.ts`, `integrations/map.ts`, `integrations/api.ts`
  - `pwa.ts` → `pwa/auth.ts`, `pwa/location.ts`, `pwa/ui.ts`
  - `devices.ts` → `devices/crud.ts`, `devices/validation.ts`, `devices/queries.ts`

**Hardcoded External Dependencies:**
- Issue: Global variables `L`, `QRCode`, `convexClient` are declared with `any` type without proper type checking. Dependencies like Leaflet and QRCode library are assumed to exist on `window` without type definitions.
- Files: `src/scripts/globals.d.ts:49`, `src/scripts/globals.d.ts:59`, `src/scripts/globals.d.ts:10`
- Impact: Runtime failures if libraries fail to load or have version mismatches. `integrity.ts` line 209-210 shows Leaflet checking at runtime.
- Fix approach: Add proper npm dependencies with type definitions, use import statements, move globals to proper DI pattern.

**Console Logging in Production:**
- Issue: Extensive use of `console.log`, `console.error`, `console.warn` throughout source code in production paths (at least 30 occurrences found).
- Files: `src/scripts/pwa.ts` (multiple lines 30, 35, 53, 56, etc.), `src/scripts/integrations.ts:569,588`, `src/scripts/logs.ts`
- Impact: Exposes system internals, potential information leakage, performance overhead.
- Fix approach: Replace with proper logging library with environment-aware levels (debug in dev only, errors in production), remove all `console.log` statements.

## Known Bugs

**Null Reference Pattern - Global State:**
- Symptoms: Race conditions possible due to module-level mutable variables that may not be initialized (`convexClient`, `authClient`, `currentUser`, `currentDevice`).
- Files: `src/scripts/pwa.ts:6-12`, `src/scripts/integrations.ts:4-11`
- Trigger: Multiple concurrent async operations accessing global state before initialization completes.
- Workaround: None - potential runtime crashes.
- Current mitigation: null checks before usage throughout codebase.

**Map Preview Refresh Debouncing Issues:**
- Symptoms: `boundaryPreviewRefreshTimer` and `pendingBoundaryPreviewRefresh` flags coordination is complex and can cause stale UI states.
- Files: `src/scripts/integrations.ts:119-135`, `src/scripts/integrations.ts:262-277`
- Trigger: Rapid input changes or modal close during refresh.
- Workaround: Manual re-trigger by changing input.
- Current mitigation: `requestAnimationFrame` double-queue and timeout debouncing, but fragile.

**Session Verification Retry Logic:**
- Symptoms: OAuth callback shows 3 retries with hardcoded delays (500ms, 1000ms, 1500ms) without exponential backoff or max retry limit parameterization.
- Files: `src/scripts/pwa.ts:160-182`
- Trigger: Slow OAuth provider responses.
- Workaround: User manually refreshes page.
- Current mitigation: Hardcoded retry loop with console logging for debugging.

## Security Considerations

**Admin Password in Browser Storage:**
- Risk: Admin passwords are stored in `sessionStorage` accessible via JavaScript. Any XSS vulnerability or compromised browser extension can read passwords.
- Files: `src/scripts/integrations.ts:374`, `src/scripts/auth.ts:61`, `src/scripts/dashboard.ts:487,539`
- Current mitigation: None - passwords stored in plain text.
- Recommendations:
  1. Never store passwords client-side. Use short-lived JWT tokens with proper expiration.
  2. Implement HTTP-only, SameSite cookies for authentication.
  3. Add CSRF protection.
  4. Audit all `sessionStorage` usage for sensitive data.

**Weak Session Management:**
- Risk: Session state stored in `sessionStorage` with simple boolean flags (`ieee_presence_authenticated`, `ieee_presence_role`). No token validation, no expiration checking, vulnerable to session fixation.
- Files: `src/scripts/auth.ts:5-7`, `src/scripts/auth.ts:10-13,57-61`
- Current mitigation: Page reload required for logout wipes storage.
- Recommendations:
  1. Implement proper JWT-based session with expiration
  2. Validate tokens on each API call
  3. Add refresh token rotation
  4. Use secure cookie storage instead of browser storage

**Missing Input Validation:**
- Risk: User inputs from forms and URL parameters are passed directly to Convex mutations without validation. Malicious input could cause backend errors or injection.
- Files: `src/scripts/dashboard.ts:386-397`, `src/scripts/integrations.ts:778-807`
- Current mitigation: Basic trim/length checks, no schema validation.
- Recommendations:
  1. Add Zod or Joi schemas for all user input
  2. Reject malformed data before API calls
  3. Sanitize HTML in user-generated content (XSS prevention)

**API Key Exposure in QR Code:**
- Risk: API keys can be scanned from QR codes by unauthorized users. No authorization check for QR access.
- Files: `src/scripts/integrations.ts:462-511`
- Current mitigation: None - QR available once modal opened.
- Recommendations:
  1. Add authentication check before displaying QR
  2. Rotate API keys periodically automatically
  3. Add rate limiting for API key usage
  4. Consider scoped permissions for mobile app linking

**No Content Security Policy:**
- Risk: No CSP headers observed in PWA service worker. Vulnerable to XSS attacks and data exfiltration.
- Files: `src/pages/pwa/service-worker.js.ts`
- Current mitigation: None.
- Recommendations:
  1. Implement strict CSP via Astro or meta tags
  2. Use nonces for inline scripts
  3. Block external script loading except trusted domains

## Performance Bottlenecks

**No Caching or Throttling on Location Requests:**
- Problem: Geolocation requests triggered on every button click with no debouncing or caching. High accuracy mode (10s timeout) is expensive.
- Files: `src/scripts/pwa.ts:426-478`, `src/scripts/pwa.ts:553` (triggered on clock toggle)
- Cause: Direct call to `navigator.geolocation.getCurrentPosition` without rate limiting.
- Improvement path: Cache location for 60 seconds (only 60s maxAge is set), add request deduplication, throttle to once per minute.

**Inefficient Device List Reconciliation:**
- Problem: DOM manipulation on every device update creates animations and renders for all cards, even when nothing changed. Diff-based reconciliation should skip unchanged elements.
- Files: `src/scripts/dashboard.ts:252-297` (residents), `src/scripts/dashboard.ts:315-361` (pending)
- Cause: No deep comparison before triggering DOM updates, `requestAnimationFrame` for every card regardless of change.
- Improvement path: Track previous device states, only update changed cards, batch DOM operations.

**Convex Query Without Pagination:**
- Problem: `convexClient.query("devices:getDevices", {})` fetches all devices without limit or offset. Scales poorly with team size.
- Files: `src/scripts/dashboard.ts:107`
- Cause: No pagination parameters passed to query.
- Improvement path: Add pagination to `devices:getDevices` query, virtual scrolling for large lists.

**Log History Without Limit:**
- Problem: `devices:getAttendanceHistoryByDeviceId` can return unlimited history if limit is not properly enforced. Frontend hardcodes limit to 20 but backend should enforce.
- Files: `src/scripts/pwa.ts:604`
- Cause: Trust of client-provided limit parameter.
- Improvement path: Enforce maximum fetch limit in Convex schema, add time range windowing.

## Fragile Areas

**Authentication Race Conditions:**
- Files: `src/scripts/pwa.ts:146-200` (checkAuthSession), `src/scripts/auth.ts:16-99`
- Why fragile: OAuth callback handling and session checks assume synchronous completion but are async. Multiple state transitions possible during authentication flow.
- Safe modification: Add state machine pattern, prevent concurrent auth operations, ensure only one auth method active at a time.
- Test coverage gaps: No integration tests for auth flow, no tests for network failure during OAuth.

**Modal State Management:**
- Files: `src/scripts/integrations.ts:513-544,573-576`, `src/scripts/dashboard.ts:363-383`
- Why fragile: Multiple modals using manual class toggling, no centralized modal state, can open multiple modals simultaneously. Cleanup functions in `closeIntegrationsModal` don't guard against already-closed state.
- Safe modification: Move to proper modal component with proper state management, ensure only one modal open at a time, handle escape key globally.
- Test coverage gaps: No tests for modal open/close sequences, no tests for modal cleanup on page navigation.

**Global Convex Client Assignment:**
- Files: `src/scripts/pwa.ts:6,99,102`, `src/scripts/dashboard.ts:4,11`
- Why fragile: Multiple files assume `window.convexClient` is initialized before use. Race condition if Convex URL is set dynamically after initial load.
- Safe modification: Use dependency injection, add Convex client availability checks everywhere, initialize lazily on first access.
- Test coverage gaps: No tests for Convex initialization failure, no tests for dynamic URL changes.

**Boundary Preview Map Lifecycle:**
- Files: `src/scripts/integrations.ts:205-339`
- Why fragile: Map may be detached from DOM on modal close but null checks are inconsistent. ResizeObserver not always disconnected. Preview refresh may reference stale elements.
- Safe modification: Use WeakMap for element tracking, ensure all resources cleaned up on modal close, add null checks for all L.map operations.
- Test coverage gaps: No tests for map lifecycle, no tests for modal close during refresh.

**Service Worker Cache Staleness:**
- Files: `src/pages/pwa/service-worker.js.ts`
- Why fragile: Cache version hardcoded to `'presence-tracker-pwa-v2'`, requires manual update on deployment. No cache-invalidation strategy for HTML files or config.
- Safe modification: Use generated cache version based on build hash, implement granular cache control, add network-first for config.
- Test coverage gaps: No tests for cache updates, no tests for offline fallback.

## Scaling Limits

**Single-Process Convex Backend:**
- Current capacity: No sharding observed. All queries hit single database instance.
- Limit: Unknown Convex scaling properties, but assumes single region deployment. Real-time presence updates rely on WebSocket subscriptions.
- Scaling path: Implement read replicas for dashboard queries, cache device lists in Redis, use Convex deployment regions.

**Log Storage Growth:**
- Current capacity: Event log collection in `convex/logs.ts` with no apparent retention policy.
- Limit: Convex document count limits (typically 1-5M docs before performance degradation).
- Scaling path: Add TTL-based log archiving, implement time-based partitioning, move old logs to cold storage.

**No Horizontal Scaling for PWA:**
- Current capacity: Single PWA instance per user, no multi-device sync expectations.
- Limit: Session state in browser storage breaks across devices. Presence updates from other devices not reflected.
- Scaling path: Implement sync across device sessions, use cloud sync for preferences, add push notifications for cross-device updates.

## Dependencies at Risk

**Better-Auth Plugin Integration:**
- Risk: `@convex-dev/better-auth` is a community plugin that may get out of sync with better-auth core. Current usage of `crossDomainClient` is experimental.
- Impact: Authentication flow could break on version mismatch. OAuth callback uses optional chaining `auth.crossDomain?.oneTimeToken?.verify` suggesting uncertain API stability.
- Migration plan: Monitor plugin releases, prepare for manual auth implementation if plugin deprecated, ensure all optional chaining paths have fallbacks.

**Leaflet Global Injection:**
- Risk: Leaflet loaded via CDN and attached to `window.L` with TypeScript bypass (`any` type). No version guarantee across deployments.
- Impact: Map preview could break on browser compatibility issues or CDN changes. `integrity.ts:209` checks for undefined but no version pinning.
- Migration plan: Move to npm package `leaflet` with import, add proper type definitions, pin version in package.json.

**QRCode.js Global Injection:**
- Risk: QRCode library loaded via CDN and attached to window with minimal error handling.
- Impact: QR code generation fails silently on load failure. `integrity.ts:488` shows basic failure message but no fallback.
- Migration plan: Use `qrcode` npm package, add proper TypeScript types, handle library load failures gracefully.

**Rust Agent Binary Distribution:**
- Risk: `rust-agent/` directory contains compiled binaries that must match platform/architecture of deployment.
- Impact: PWA or backend may fail to invoke agent on architecture mismatch. No build-from-source fallback observed.
- Migration plan: Add platform detection, provide Docker images for agent, add npm-based fallback or WASM version.

## Missing Critical Features

**No Monitoring or Observability:**
- Problem: No structured logging, error tracking (Sentry), or metrics collection. Production issues invisible to developers.
- Blocks: Debugging production failures, performance monitoring, error rate tracking.
- Current state: Only `console.error` calls that are not centrally collected.

**No Audit Logging:**
- Problem: Admin actions (device edits, deletions, config changes) are not logged to backend audit trail.
- Blocks: Compliance requirements, incident investigation, change tracking.
- Current state: `convex/logs.ts` exists but scope unknown. Dashboard has device-specific logs view but no admin action audit.

**No Rate Limiting:**
- Problem: No observed rate limiting on Convex mutations or endpoints. API keys have unlimited usage.
- Blocks: API abuse prevention, DoS protection, usage billing control.
- Current state: `devices:rotateAppApiKey` generates new keys but no usage tracking.

**No Backup/Restore:**
- Problem: No mechanism to export device configurations, integration settings, or user registrations for backup or migration.
- Blocks: Disaster recovery, environment promotion, data portability.
- Current state: PWA has export for app linking config only as JSON via `downloadAppLinkingJson`.

**No Health Checks:**
- Problem: No health check endpoints or connection status monitoring. PWA assumes Convex is always available.
- Blocks: Deployment smoke tests, load balancer health checks, outage detection.
- Current state: Basic try-catch on Convex initialization with alert dialog.

## Test Coverage Gaps

**Zero Test Coverage:**
- What's not tested: All functionality is untested. No unit tests, integration tests, or E2E tests found in source.
- Files: No `*.test.ts` or `*.spec.ts` files in `src/` directory (only node_modules has tests).
- Risk: Regression on every change, unreliable deployments, confidence loss.
- Priority: High - Add tests for auth flow, device CRUD, location verification, boundary logic.

**No Integration Tests:**
- What's not tested: Convex backend integration, API contract validation, OAuth flow with real providers.
- Risk: API changes break frontend silently, Convex migration issues, environment-specific failures.
- Priority: High - Add end-to-end tests for critical user journeys (login, clock in/out, register device).

**No Unit Tests:**
- What's not tested: Pure functions (coordinate parsing, distance calculation, log formatting), utility functions, helper logic.
- Risk: Logic bugs in helper functions propagate undetected.
- Priority: Medium - Extract pure logic to testable modules, add full coverage.

**No Component Tests:**
- What's not tested: React/Astro components, modal interactions, form validation, responsive behavior.
- Risk: UI changes break user workflows, accessibility regressions, mobile compatibility issues.
- Priority: Medium - Add component tests for modals, forms, and critical UI flows.

**No Contract Tests:**
- What's not tested: Convex schema types match frontend usage, API response formats, query argument validation.
- Risk: Backend schema changes break frontend without detection.
- Priority: High - Generate TypeScript types from Convex schema, add contract validation tests.

*Concerns audit: 2026-03-03*
