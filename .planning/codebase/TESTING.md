# Testing Patterns

**Analysis Date:** 2026-03-03

## Test Framework

**Runner:**
- Not configured
- No test framework detected (Jest, Vitest, Mocha, etc.)

**Assertion Library:**
- Not configured

**Config:**
- No test configuration files present
- No `jest.config.js`, `vitest.config.ts`, or similar

**Run Commands:**
```bash
# No test commands configured in package.json
```

## Test File Organization

**Location:**
- No test directory present
- No test files in `src/` or `convex/` directories
- Only library tests found in `node_modules/` (zod package tests)

**Naming:**
- Not applicable - no test files exist

**Structure:**
```
# Not applicable - no test files exist
```

## Test Structure

**Suite Organization:**
```typescript
# Not applicable - no tests exist
```

**Patterns:**
- Not applicable

**Setup Pattern:**
- Not applicable

**Teardown Pattern:**
- Not applicable

**Assertion Pattern:**
- Not applicable

## Mocking

**Framework:** Not configured

**Patterns:**
```typescript
# Not applicable - no tests exist
```

**What to Mock:**
- Not applicable - no tests exist

**What NOT to Mock:**
- Not applicable - no tests exist

## Fixtures and Factories

**Test Data:**
```typescript
# Not applicable - no tests exist
```

**Location:**
- Not applicable - no test locations

## Coverage

**Requirements:**
- None enforced
- No coverage tool configured

**View Coverage:**
```bash
# No commands available - no test coverage tracking
```

**Current Coverage:**
- Not tracked
- Likely 0% for production code

## Test Types

**Unit Tests:**
- Not implemented

**Integration Tests:**
- Not implemented

**E2E Tests:**
- Not implemented

## Manual Testing

**Manual Testing Approach:**
Since no automated tests exist, testing appears to be done manually:

1. **Dashboard Testing:**
   - Manual browser testing of web interface
   - Testing device registration flow through UI
   - Manual verification of presence detection

2. **Convex Function Testing:**
   - Likely tested via Convex dashboard console
   - Manual query/mutation calls to verify behavior

3. **PWA Testing:**
   - Manual testing on mobile browsers
   - OAuth flow verification via actual sign-in
   - Location boundary testing with real coordinates

4. **Integration Testing:**
   - Manual testing of Discord/Slack webhook integrations
   - Verification of actual message delivery

**Manual Test Records:**
- No documented manual test procedures found
- No test fixtures or test data

## Common Testing Gaps

**Missing Tests:**
- All Convex functions lack unit tests
- Device registration/validation logic untested
- Email validation (`@ucsd.edu` requirement) untested
- Boundary calculation (Haversine formula) untested
- Auth flow untested
- API endpoint testing absent

**Risk Areas:**
- Core business logic (device presence, status changes) untested
- Security-critical code (auth, admin functions) untested
- Data normalization functions untested
- Complex logic (attendance history merging) untested

## Recommendations

**Immediate Actions:**
1. Add Jest or Vitest configuration
2. Create basic unit tests for:
   - Email validation functions
   - Boundary calculation
   - Password validation
3. Add test script to `package.json`
4. Set up coverage thresholds

**Priority:** High
Current state has zero test coverage, representing significant risk for refactors and features.

---

*Testing analysis: 2026-03-03*
