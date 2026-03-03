# Coding Conventions

**Analysis Date:** 2026-03-03

## Naming Patterns

**Files:**
- `.ts` files for TypeScript source
- `.astro` files for Astro pages/components
- `.d.ts` files for type definitions
- Kebab-case for service worker files (`service-worker.js.ts`)

**Functions:**
- camelCase for all functions: `handleAuth`, `showToast`, `renderLogs`
- `window.functionName` pattern for functions that need global scope from UI

**Variables:**
- camelCase: `convexClient`, `currentUser`, `appConfig`
- UPPER_SNAKE_CASE for constants: `AUTH_SESSION_KEY`, `LOGS_PER_PAGE`

**Types:**
- PascalCase for interfaces and types in TypeScript: `Doc`, `Id`, `DataModel`

## Code Style

**Formatting:**
- Two-space indentation
- No configured linter/formatter (no ESLint, Prettier, or Biome config detected)
- Semi-colons used consistently

**Linting:**
- No linting tool configured
- No style enforcement tools detected

**TypeScript Directives:**
- `// @ts-nocheck` at top of all `src/scripts/*.ts` files
- Type-checking disabled for browser-facing scripts
- `// @ts-check` used in `astro.config.mjs`

## Import Organization

**Order:**
1. External library imports
2. Internal/relative imports
3. Imports from `convex` packages

**Examples:**
```typescript
import { ConvexClient } from "convex/browser";
import { showToast } from "./dashboard";
```

**Path Aliases:**
- No path aliases configured
- Uses relative imports with `./` prefix

**Convex imports:**
```typescript
import { action, mutation, query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
```

## Error Handling

**Patterns:**
- Try-catch blocks for all async operations
- `console.error()` for error logging
- Descriptive error messages with context

**Typical error handling:**
```typescript
try {
  await convexClient.mutation("devices:save", { data });
  showToast("Success", "success");
} catch (error) {
  console.error("Operation failed:", error);
  showToast(`Error: ${error.message}`, "error");
}
```

**Validation:**
- Null checks with optional chaining: `document.getElementById("element")?.value`
- Early return patterns: `if (!client) return;`
- User input validation for forms

**Error Messages:**
- User-facing: `showToast("message", "error")`
- Internal: `console.error("context", error)`

## Logging

**Framework:** `console` browser API

**Patterns:**
- `console.error()` for errors with context
- `console.log()` for debugging with prefixes: `[Auth]`, `[OAuth]`, `[Status]`
- No structured logging library
- No log levels (only error/log)

**When to log:**
- All async errors
- OAuth/callback handling
- Session state changes
- Configuration initialization

## Comments

**When to Comment:**
- Above function definitions for purpose
- For complex logic explanations
- Inline comments for non-obvious operations

**Examples:**
```typescript
/**
 * Validate the provided password against stored passwords.
 * Returns the access level: "admin", "user", or null if invalid.
 */
export const validatePassword = query({...});

// Note: We no longer delete pending devices when they go absent
// They will remain in the database for manual review
```

**JSDoc/TSDoc:** Not used

## Function Design

**Size:**
- Functions range from 10-100+ lines
- No strict size guidelines observed
- Large functions broken into smaller helpers in some places

**Parameters:**
- Destructured objects for complex args: `{ apiKey, email, latitude, longitude }`
- Optional parameters not extensively used in browser scripts
- Type annotations in Convex functions with `v.string()`, `v.id()`, etc.

**Return Values:**
- Async functions return Promises
- `showToast` returns early with early `if` checks
- Convex queries/mutations return typed results

**Examples:**
```typescript
async function handleAuth(event) {
  event.preventDefault();
  // ...
  return false;
}

export const validatePassword = query({
  args: { password: v.string() },
  handler: async (ctx, args) => {
    // ...
  }
});
```

## Variable and Style Patterns

**Variables:**
- Local variables: `camelCase`
- DOM queries: Optional chaining: `const element = document.getElementById("id")?.value`
- Boolean flags: `isEnabled`, `hasValue`, `isPresent`

**Constants:**
- UPPER_SNAKE_CASE at file top: `AUTH_SESSION_KEY`, `LOGS_PER_PAGE`
- Magic numbers: Use named constants, not literals

**String Handling:**
- Template literals for HTML: `` `html string` ``
- Escape functions for user content: `escapeHtml()`, `escapeSingleQuote()`
- Trim/lowercase for normalized inputs: `email.trim().toLowerCase()`

## DOM Manipulation

**Element Selection:**
- `document.getElementById()` with optional chaining
- `querySelector()` for selectors
- Dataset attributes: `element.dataset.tab`

**Common Patterns:**
```typescript
const element = document.getElementById("id");
if (element) element.textContent = "value";
if (element) element.classList.add("class");

window.functionName = function() { ... };
```

**Event Listeners:**
```typescript
document.addEventListener("DOMContentLoaded", () => { ... });
element.addEventListener("click", (event) => { ... });
element.addEventListener("change", (event) => { ... });
window.addEventListener("beforeinstallprompt", (event) => { ... });
```

## CSS Conventions

**Naming:**
- kebab-case for classes: `.auth-overlay`, `.resident-card`
- BEM-ish patterns: `.resident-card__header`, `.log-entry`
- Component scoped: `.`, not `#` for styling (except for specific IDs)

**Custom Properties:**
- CSS variables in `:root`: `--primary: #0284C7;`
- Descriptive names: `--font-main`, `--tech-glow`
- Group by function: colors, spacing, effects

**Comments:**
- Section headers explaining theme purpose

## Module Design

**Exports:**
- Named exports for functions: `export async function initializeApp()`
- Exported globals for UI: `window.functionName = function()`
- Convex uses `export const` for queries/mutations/actions

**File Organization:**
- `src/scripts/` - Browser TypeScript modules
- `convex/` - Backend Convex functions
- `src/pages/` - Astro pages
- `src/styles/` - CSS files

**Barrel Files:**
- Not used

## Convex-specific Conventions

**Function Types:**
- `query()` - Read-only data fetches
- `mutation()` - Data modifications
- `action()` - Operations with side effects
- `internalMutation()` - Internal use in Convex

**Naming:**
- Namespace pattern: `"devices:getDevices"`, `"auth:validatePassword"`
- Descriptive handler names: `getPresentUsers`, `cleanupExpiredDevices`

**Schema Definitions:**
- `defineTable()` with `v.string()`, `v.boolean()`, etc.
- Indexes: `.index("by_field", ["field"])`
- Field types: `v.optional()`, `v.union()`, `v.literal()`

---

*Convention analysis: 2026-03-03*
