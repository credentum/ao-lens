# ao-lens v2.0 Implementation Plan

## Executive Summary

This plan addresses 4 detection gaps identified by the AO Panel review. Priority is based on exploit severity and implementation complexity.

| Phase | Rule | Current State | Severity | Effort |
|-------|------|---------------|----------|--------|
| P0 | hasMatchingTag-alone | Partial (needs handler body check) | CRITICAL | Low |
| P1 | nil-guard-required | Not implemented | CRITICAL | Medium |
| P2 | unsafe-or-in-auth | ✅ Already exists | CRITICAL | None |
| P3 | initialization-tracking | Not implemented | CRITICAL | High |

**Key Finding:** P2 (`UNSAFE_OWNER_OR_PATTERN`) is already implemented at `security-analyzer.ts:406-434`.

---

## Phase 0: hasMatchingTag-alone Enhancement

### Current State (Line 293-305)

```typescript
// HIGH: hasMatchingTag without additional validation
if (handler.signature_type === "hasMatchingTag" && handler.matcher_analysis.strictness === "loose") {
  if (this.isMutatingHandler(handler, result)) {
    findings.push({
      severity: "high",
      code: "LOOSE_MATCHER_MUTATION",
      message: `Handler "${handler.name}" uses loose matcher but mutates state`,
      // ...
    });
  }
}
```

**Problem:** Flags ALL hasMatchingTag matchers, even if handler body has proper auth.

### AO Panel Requirement

```lua
-- This is ACCEPTABLE (hasMatchingTag + handler body auth):
Handlers.add("Update",
  Handlers.utils.hasMatchingTag("Action", "Update"),
  function(msg)
    assert(msg.From == State.Owner, "Unauthorized")  -- Belt and suspenders!
    -- ... rest of handler
  end
)

-- This is VULNERABLE (hasMatchingTag + no handler body auth):
Handlers.add("Update",
  Handlers.utils.hasMatchingTag("Action", "Update"),
  function(msg)
    State.Value = msg.Data  -- Anyone can call this!
  end
)
```

### Implementation

**File:** `src/analyzers/security-analyzer.ts`

**Changes:**

1. Add helper to check handler body for authorization:

```typescript
/**
 * Check if handler body contains authorization check
 * Returns true if: assert(msg.From == State.Owner) or similar
 */
private handlerBodyHasAuth(handler: HandlerInfo, result: ParseResult): boolean {
  if (!result.sourceCode) return false;

  const lines = result.sourceCode.split("\n");
  const handlerLines = lines.slice(handler.line - 1, handler.end_line);
  const bodyText = handlerLines.join("\n");

  // Check for belt-and-suspenders patterns
  const hasAssertAuth = /assert\s*\([^)]*msg\.From\s*==\s*State\.Owner/.test(bodyText);
  const hasIfAuth = /if\s+.*msg\.From\s*==\s*State\.Owner/.test(bodyText);

  return hasAssertAuth || hasIfAuth;
}
```

2. Modify `LOOSE_MATCHER_MUTATION` check:

```typescript
// HIGH → CRITICAL: hasMatchingTag without handler body auth
if (handler.signature_type === "hasMatchingTag" && handler.matcher_analysis.strictness === "loose") {
  if (this.isMutatingHandler(handler, result)) {
    // Check if handler body has authorization (belt-and-suspenders)
    const hasBodyAuth = this.handlerBodyHasAuth(handler, result);

    if (!hasBodyAuth) {
      findings.push({
        severity: "critical",  // Upgraded from "high"
        code: "HASMATCHING_TAG_NO_HANDLER_AUTH",
        message: `Handler "${handler.name}" uses hasMatchingTag but handler body lacks authorization`,
        handler: handler.name,
        line: handler.line,
        suggestion: "Add 'assert(msg.From == State.Owner, \"Unauthorized\")' at start of handler body",
      });
    }
  }
}
```

### Test Cases

**File:** `tests/fixtures/hasmatching-tag-test.lua`

```lua
-- VULNERABLE: hasMatchingTag + no handler auth
Handlers.add("BadUpdate",
  Handlers.utils.hasMatchingTag("Action", "Update"),
  function(msg)
    State.Value = msg.Data  -- CRITICAL: Anyone can call!
  end
)

-- SAFE: hasMatchingTag + handler body auth (belt-and-suspenders)
Handlers.add("GoodUpdate",
  Handlers.utils.hasMatchingTag("Action", "Update"),
  function(msg)
    assert(msg.From == State.Owner, "Unauthorized")
    State.Value = msg.Data
  end
)
```

---

## Phase 1: nil-guard-required Detection

### The Vulnerability

```lua
-- VULNERABLE: nil == nil returns TRUE in Lua!
if msg.From == State.Owner then  -- If State.Owner is nil, nil == nil = TRUE
  State.Value = msg.Data         -- Attacker bypasses auth!
end

-- SAFE: Explicit nil guards
if State.Owner and msg.From and msg.From == State.Owner then
  State.Value = msg.Data
end
```

### Implementation

**File:** `src/analyzers/security-analyzer.ts`

**Add new method after `checkOwnerInitPattern`:**

```typescript
/**
 * Check for equality comparisons with State.Owner without nil guards
 * Pattern: if msg.From == State.Owner then (without preceding nil checks)
 * This allows nil == nil bypass if State.Owner is uninitialized
 */
private checkNilGuardRequired(sourceCode: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = sourceCode.split("\n");

  // Pattern: equality comparison with State.Owner
  const equalityPattern = /msg\.From\s*==\s*State\.Owner/;

  // Safe pattern: nil guards before comparison
  // Must check: State.Owner and msg.From and msg.From == State.Owner
  const safePattern = /State\.Owner\s+and\s+msg\.From\s+and\s+msg\.From\s*==\s*State\.Owner/;

  // Alternative safe: assert with nil check on same line
  const assertSafePattern = /assert\s*\(\s*State\.Owner\s*~=\s*nil/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip if it's already the safe pattern
    if (safePattern.test(line)) {
      continue;
    }

    // Check for vulnerable equality pattern
    if (equalityPattern.test(line)) {
      // Check if previous lines have nil guard for State.Owner
      const contextLines = lines.slice(Math.max(0, i - 5), i + 1).join("\n");

      // Check for safe patterns in context
      const hasNilGuard = safePattern.test(contextLines);
      const hasAssertNilCheck = assertSafePattern.test(contextLines);

      if (!hasNilGuard && !hasAssertNilCheck) {
        findings.push({
          severity: "critical",
          code: "NIL_GUARD_REQUIRED",
          message: "msg.From == State.Owner without nil guards allows nil==nil bypass",
          line: i + 1,
          suggestion: "Use: if State.Owner and msg.From and msg.From == State.Owner then",
        });
      }
    }
  }

  return findings;
}
```

**Add call in `analyze()` method (after line 87):**

```typescript
// Check for nil guards on State.Owner comparisons
if (result.sourceCode) {
  findings.push(...this.checkOwnerInitPattern(result.sourceCode));
  findings.push(...this.checkNilGuardRequired(result.sourceCode));  // NEW
}
```

### Test Cases

**File:** `tests/fixtures/nil-guard-test.lua`

```lua
-- VULNERABLE: No nil guards
Handlers.add("BadAuth", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if msg.From == State.Owner then return true end  -- CRITICAL: nil==nil bypass!
  return false
end, function(msg)
  State.Value = msg.Data
end)

-- SAFE: Proper nil guards
Handlers.add("GoodAuth", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  if State.Owner and msg.From and msg.From == State.Owner then return true end
  return false
end, function(msg)
  State.Value = msg.Data
end)

-- SAFE: Assert-based nil check
Handlers.add("AssertAuth", function(msg)
  if msg.Tags.Action ~= "Update" then return false end
  return true
end, function(msg)
  assert(State.Owner ~= nil, "Owner not initialized")
  assert(msg.From == State.Owner, "Unauthorized")
  State.Value = msg.Data
end)
```

---

## Phase 2: unsafe-or-in-auth (Already Implemented!)

### Current Implementation (Line 406-434)

```typescript
private checkOwnerInitPattern(sourceCode: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = sourceCode.split("\n");

  // Pattern: State.Owner = State.Owner or X
  const orPattern = /State\.Owner\s*=\s*State\.Owner\s+or\s+\w+/;
  // Required follow-up: assert(State.Owner ~= nil, ...)
  const assertPattern = /assert\s*\(\s*State\.Owner\s*~=\s*nil/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (orPattern.test(line)) {
      // Check next 5 lines for the assert
      const nextLines = lines.slice(i, i + 6).join("\n");
      if (!assertPattern.test(nextLines)) {
        findings.push({
          severity: "critical",
          code: "UNSAFE_OWNER_OR_PATTERN",
          message: "State.Owner uses 'or' fallback without nil assertion - allows nil==nil bypass",
          line: i + 1,
          suggestion:
            "Add immediately after: assert(State.Owner ~= nil, \"Owner not initialized\")",
        });
      }
    }
  }

  return findings;
}
```

**Status:** ✅ Already implemented. No changes needed.

### Verification Test

Add to `tests/fixtures/pid.lua` or create `tests/fixtures/or-pattern-test.lua`:

```lua
-- VULNERABLE: 'or' without assert
State.Owner = State.Owner or msg.From  -- CRITICAL: Will be flagged

-- SAFE: 'or' with assert
State.Owner = State.Owner or msg.From
assert(State.Owner ~= nil, "Owner not initialized")
```

---

## Phase 3: Initialization Tracking (GitHub Issue)

This requires flow analysis and is out of scope for this PR. See GitHub issue for detailed specification.

### The Problem

```lua
-- Initialization order matters!
local function checkAuth(msg)
  -- State.Owner might not be set yet!
  assert(msg.From == State.Owner, "Unauthorized")
end

-- If handler calls checkAuth before Initialize handler runs...
Handlers.add("Update", ..., function(msg)
  checkAuth(msg)  -- BUG: State.Owner may be nil
  State.Value = msg.Data
end)

Handlers.add("Initialize", ..., function(msg)
  State.Owner = msg.From  -- This should run FIRST
end)
```

### Why It's Complex

1. Requires control flow graph (CFG) construction
2. Need to track function call order
3. Handler execution order is non-deterministic
4. Static analysis can't prove runtime order

### Recommended Approach (For Future)

Instead of full flow analysis, require explicit initialization checks:

```lua
-- PATTERN: Guard against uninitialized state
local function requireInitialized()
  assert(State.Owner ~= nil, "Process not initialized - call Initialize first")
end

Handlers.add("Update", ..., function(msg)
  requireInitialized()  -- Explicit guard
  assert(msg.From == State.Owner, "Unauthorized")
  State.Value = msg.Data
end)
```

---

## Implementation Order

### PR #1: P0 + P1 (This Sprint)

1. Add `handlerBodyHasAuth()` helper
2. Upgrade `LOOSE_MATCHER_MUTATION` to check handler body
3. Add `checkNilGuardRequired()` method
4. Add test fixtures
5. Update CLI output for new rule codes

**Estimated Changes:** ~100 lines in `security-analyzer.ts`

### PR #2: P3 GitHub Issue (Backlog)

Create issue with specification for flow analysis.

---

## Testing Strategy

### Unit Tests

```bash
# Run existing tests
npm test

# Add new test cases
npm test -- --grep "nil-guard"
npm test -- --grep "hasMatchingTag"
```

### Integration Tests

```bash
# Test against fixtures
npx ao-lens audit tests/fixtures/nil-guard-test.lua --json

# Expected output for vulnerable patterns
{
  "findings": [
    {
      "severity": "critical",
      "code": "NIL_GUARD_REQUIRED",
      "line": 4
    }
  ]
}
```

### Benchmark Tests

Run against ao-benchmark-02 to verify:
1. Good code (with nil guards) passes
2. Vulnerable code (without nil guards) is flagged

---

## Success Criteria

| Metric | Target |
|--------|--------|
| False positives on pid.lua (reference) | 0 |
| Detection of nil==nil bypass | 100% |
| Detection of hasMatchingTag-alone | 100% |
| ao-benchmark-02 pass rate | 100% |
| Build time impact | < 5% |

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/analyzers/security-analyzer.ts` | Add `handlerBodyHasAuth()`, `checkNilGuardRequired()` |
| `tests/fixtures/nil-guard-test.lua` | New test fixture |
| `tests/fixtures/hasmatching-tag-test.lua` | New test fixture |
| `README.md` | Document new rules |

---

## Rollout Plan

1. Implement in feature branch
2. Test against vivarium codebase
3. Run against ao-benchmark-02
4. Create PR with before/after comparison
5. Deploy to agent pipeline

---

## Appendix: Rule Reference

### New Rule Codes

| Code | Severity | Description |
|------|----------|-------------|
| `HASMATCHING_TAG_NO_HANDLER_AUTH` | CRITICAL | hasMatchingTag matcher + handler body lacks auth |
| `NIL_GUARD_REQUIRED` | CRITICAL | msg.From == State.Owner without nil guards |

### Existing Rule Codes (Unchanged)

| Code | Severity | Description |
|------|----------|-------------|
| `NO_AUTH_CHECK` | CRITICAL | Handler mutates state without msg.From |
| `UNSAFE_OWNER_OR_PATTERN` | CRITICAL | State.Owner = X or Y without assert |
| `LOOSE_MATCHER_MUTATION` | HIGH | Loose matcher on mutating handler |
| `NO_FROZEN_CHECK` | MEDIUM | Missing State.Frozen check |
| `NO_SCHEMA_VALIDATION` | MEDIUM | Missing pcall/type validation |
| `ALWAYS_TRUE_MATCHER` | LOW | Matcher always returns true |
