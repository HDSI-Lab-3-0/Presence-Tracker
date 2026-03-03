# HDSI Presence Tracker

## What This Is

Bluetooth-based presence tracking system that monitors when devices (phones, laptops) are connected/disconnected from a Raspberry Pi via Bluetooth. The system includes a real-time web dashboard for monitoring device status and a mobile PWA for users to self-report their presence, with Discord/Slack integrations for notifications.

## Core Value

Users can reliably track and report their physical presence at a location using passive Bluetooth detection and active mobile app self-reporting, enabling automated attendance tracking and real-time status updates.

## Requirements

### Validated

**Base System (existing):**
- ✓ Bluetooth presence detection via Raspberry Pi scanning
- ✓ Real-time web dashboard for device monitoring
- ✓ Mobile PWA with Google OAuth for user authentication
- ✓ Presence boundary/geofence validation with location checks
- ✓ Discord/Slack notification integrations
- ✓ Device registration workflow with UCSD email enforcement
- ✓ Activity logging and attendance history tracking
- ✓ Grace period handling for unregistered device cleanup
- ✓ Admin password protection for dashboard operations

### Active

**Current work scope:**
- [ ] Remove QR code generator and mobile app linking features from codebase
- [ ] Keep boundary/geofence settings functionality intact
- [ ] Add ADMIN_EMAIL environment variable for admin user identification
- [ ] Restrict boundary control visibility in PWA to admin users only
- [ ] Test boundary controls with admin/non-admin accounts

### Out of Scope

- [QR code generation logic] — Users no longer need mobile app linking
- [Mobile app linking flow] — Simplified workflow, no longer required

## Context

**Technical Environment:**
- Astro 5.17.1 frontend with Tailwind CSS
- Convex 1.32.0 serverless backend (database, functions, real-time updates)
- Better Auth 1.4.9 with Google OAuth for PWA authentication
- Rust agent for Bluetooth scanning on Raspberry Pi

**Existing Architecture:**
- Three-layer system: Rust agent (Bluetooth) → Convex backend → Astro frontend (dashboard + PWA)
- Real-time reactive updates via Convex client subscriptions
- Separate authentication flows: password-based for dashboard, Google OAuth for PWA
- Dual status tracking: Bluetooth status (from agent) + app status (from PWA)

**User Feedback Context:**
This work responds to user feedback that the QR code generator and mobile app linking features are no longer needed. Users prefer the simpler PWA-based self-reporting approach. The boundary/geofence validation remains valuable but should be restricted to admin users only to prevent unauthorized configuration changes.

## Constraints

- **Tech Stack**: Must maintain existing Astro, Convex, Rust, and Better Auth implementations
- **Environment Variables**: ADMIN_EMAIL is a new required variable in Convex environment
- **Authentication**: Cannot disrupt existing Google OAuth flow for PWA or password auth for dashboard
- **UI/UX**: PWA boundary controls should be conditionally rendered based on user email match
- **Backward Compatibility**: Existing registered users and device records must remain functional

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Remove QR code generator | Users no longer need mobile app linking, simplifies codebase | — Pending |
| Add ADMIN_EMAIL env var | Enables admin-only boundary control restriction | — Pending |
| Keep boundary settings intact | Presence geofencing remains valuable feature | — Pending |

---
*Last updated: 2026-03-03 after project initialization*