# Add ao-lens to Your AO Project in 5 Minutes

ao-lens is a static analysis tool for AO/Lua processes. It finds auth bugs, nil guards, replay safety violations, and missing frozen checks before they hit mainnet.

Three ways to run it. CLI, MCP server for Claude Code, or GitHub Action.

---

## 1. CLI (30 seconds)

```bash
# Audit a single file
npx ao-lens audit process.lua --pretty

# Audit a directory
npx ao-lens audit ./ao/ --pretty

# Parse structure (handlers, functions, state)
npx ao-lens parse process.lua --json

# Generate IPC topology
npx ao-lens graph ./ao/ --mermaid
```

The `--pretty` output looks like this:

```
============================================================
SECURITY AUDIT REPORT
============================================================

RESULT: FAIL

  Critical: 3  High: 8  Medium: 5  Low: 11

  [CRITICAL] OWNER_NEVER_INITIALIZED (line 1)
    State.Owner is referenced but never properly initialized

  [HIGH] NO_FROZEN_CHECK (line 33)
    Handler "Mint" does not check Frozen state

  [HIGH] JSON_DECODE_NO_PCALL (line 58)
    json.decode() without pcall crashes on malformed JSON
```

---

## 2. MCP Server for Claude Code (2 minutes)

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "ao-lens": {
      "command": "npx",
      "args": ["-y", "ao-lens-mcp"]
    }
  }
}
```

Now Claude Code has 11 analysis tools:

- `security_audit`: full audit with severity rankings
- `analyze_file`: parse handlers, functions, globals, state access
- `analyze_handler`: deep dive on a specific handler
- `query_handlers`: find handlers by pattern (e.g., all mutating handlers without auth)
- `find_state_mutations`: track all `State.*` writes
- `find_state_usage`: trace a specific field across handlers
- `check_determinism`: find replay-safety violations
- `map_architecture`: IPC topology across files
- `list_handlers`: overview with action tags and strictness
- `get_handler_body`: handler source code and body analysis
- `get_function_details`: function parameters, line range, body analysis

Ask Claude "find all handlers that mutate state but have no authorization check" and it will call `query_handlers` with `{ mutates_state: true, has_auth: false }`.

---

## 3. GitHub Action for CI (2 minutes)

```yaml
name: AO Security Audit
on: [push, pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: credentum/ao-lens@v0.1.0
        with:
          path: 'ao/'
          fail-on-high: 'true'
```

The action exits with code 1 if it finds critical or high severity issues. PRs get blocked automatically.

---

## Custom Detection Rules

ao-lens ships with built-in checks across seven categories. Add your own with YAML:

```bash
ao-lens audit process.lua --skills-dir ./my-rules --pretty
```

See [Write Custom Security Rules](./03-write-custom-security-rules.md) for the full format.

---

## What It Catches

| Severity | Check | What it catches |
|----------|-------|-----------------|
| Critical | NIL_GUARD_REQUIRED | `msg.From == State.Owner` passes when both nil |
| Critical | STATE_OVERWRITE_ON_REPLAY | `State = {...}` wipes state on every replay |
| High | NO_AUTH_CHECK | Handler mutates state without checking msg.From |
| High | NO_FROZEN_CHECK | No emergency stop on mutating handler |
| High | JSON_DECODE_NO_PCALL | json.decode crashes on malformed input |
| High | DETERMINISM_VIOLATION | os.time(), math.random() break replay |

---

## Links

- Install globally: `npm install -g ao-lens`
- GitHub: [github.com/credentum/ao-lens](https://github.com/credentum/ao-lens)
- Previous: [Your AO Handler Auth Is Probably Broken](./01-your-ao-handler-auth-is-broken.md)
- Next: [Write Custom Security Rules](./03-write-custom-security-rules.md)
