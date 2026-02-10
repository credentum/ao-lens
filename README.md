# ao-lens

Static analysis and security auditing for [AO](https://ao.arweave.dev/) processes.

Catches common vulnerabilities in Lua code before they reach production — nil guard bypasses, determinism violations, missing authorization, unsafe JSON handling, and more.

## Install

```bash
npm install -g ao-lens
```

Or use directly with npx:

```bash
npx ao-lens audit ./ao/
```

## Quick Start

```bash
# Audit a file
ao-lens audit process.lua --pretty

# Audit a directory
ao-lens audit ./ao/ --pretty

# Parse structure (handlers, functions, state access)
ao-lens parse process.lua --json

# Generate IPC topology diagram
ao-lens graph ./ao/ --mermaid

# List loaded detection rules
ao-lens rules --skills-dir ./skills
```

### Example Output

```
============================================================
SECURITY AUDIT REPORT
============================================================

  [CRITICAL] NIL_GUARD_REQUIRED (line 15)
    msg.From == State.Owner passes when both are nil

  [HIGH] JSON_DECODE_NO_PCALL (line 23)
    json.decode without pcall — malformed input crashes handler

  [HIGH] NO_FROZEN_CHECK (line 15)
    Mutating handler without State.Frozen check

RESULT: FAIL
  Critical: 1  High: 2  Medium: 0  Low: 0
============================================================
```

## What It Catches

ao-lens includes 25+ built-in security checks plus 20 extensible rules:

### Critical

| Check | What it catches |
|-------|-----------------|
| `NIL_GUARD_REQUIRED` | `msg.From == State.Owner` passes when both nil (`nil == nil` is `true` in Lua) |
| `OWNER_NEVER_INITIALIZED` | `State.Owner` never set — all auth checks pass for anyone |
| `LOCAL_STATE_SHADOW` | `local State = {}` shadows global State silently |
| `UNSAFE_OWNER_OR_PATTERN` | `State.Owner = State.Owner or msg.From` — first caller wins |
| `STATE_OVERWRITE_ON_REPLAY` | `State = {...}` without `or` guard wipes state on replay |

### High

| Check | What it catches |
|-------|-----------------|
| `NO_AUTH_CHECK` | Handler mutates state without checking `msg.From` |
| `NO_FROZEN_CHECK` | Mutating handler without emergency stop check |
| `JSON_DECODE_NO_PCALL` | `json.decode()` without pcall — crashes on bad input |
| `JSON_ENCODE_NO_PCALL` | `json.encode()` without pcall — crashes on circular refs |
| `DETERMINISM_VIOLATION` | `os.time()`, `math.random()` — breaks state on replay |

### Medium / Low

Missing schema validation, conditional auth, info leaks in error messages, `0` used as falsy, nil concatenation, and more.

## GitHub Action

Add ao-lens to your CI pipeline:

```yaml
- uses: credentum/ao-lens@v0.1.0
  with:
    path: 'ao/'
    fail-on-high: 'true'
```

The action exits with code 1 if critical or high severity issues are found.

## MCP Server

ao-lens runs as an [MCP](https://modelcontextprotocol.io/) server, giving AI coding assistants direct access to semantic analysis.

### Setup

Add to your MCP config (Claude Code, Cursor, etc.):

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

Or run directly:

```bash
ao-lens-mcp
```

### Available Tools

| Tool | Description |
|------|-------------|
| `analyze_file` | Parse file — extract handlers, functions, globals, state access |
| `analyze_handler` | Detailed handler analysis by name |
| `list_handlers` | List all handlers with action tags and strictness |
| `security_audit` | Run full security audit with severity rankings |
| `check_determinism` | Check for replay-safety violations |
| `find_state_mutations` | Find all `State.*` writes across files |
| `find_state_usage` | Track reads/writes to a specific state field |
| `get_function_details` | Function parameters, body analysis, calls |
| `get_handler_body` | Handler source with auth pattern and state access |
| `query_handlers` | Filter handlers by auth, frozen, mutation, strictness |
| `map_architecture` | Cross-file IPC topology (json / mermaid / summary) |

## Custom Detection Rules

ao-lens loads detection rules from YAML skill files. The repo ships with 7 rule files covering the most common AO security pitfalls.

### Using Rules

```bash
# Use the included rules
ao-lens audit process.lua --skills-dir ./skills --pretty

# Point to your own rules
ao-lens audit process.lua --skills-dir /path/to/your/skills --pretty

# Or set via environment variable
AO_LENS_SKILLS_DIR=./skills ao-lens audit process.lua --pretty
```

### Included Rule Files

| File | Rules | Covers |
|------|-------|--------|
| `skill_ao_determinism` | 4 | `os.time`, `math.random`, `os.date`, `io.*` |
| `skill_ao_authorization` | 3 | first-caller-wins, nil==nil bypass, missing auth |
| `skill_ao_json_safety` | 2 | json.decode/encode without pcall |
| `skill_ao_frozen_state` | 2 | missing emergency stop, uninitialized frozen |
| `skill_lua_nil_safety` | 3 | nil concat crash, 0-is-truthy, nested table access |
| `skill_ao_handler_patterns` | 3 | hasMatchingTag without body auth, nil send target |
| `skill_ao_replay_safe_init` | 3 | `State = {}` wipes on replay, globals without `or` |

### Writing Your Own Rules

Create a YAML file in a `skills/ao/` directory:

```yaml
skill_id: skill_my_project
title: "My Project Rules"
domain: lua/ao
tech_stack: [lua, ao]

anti_patterns:
  - id: MY_CUSTOM_CHECK
    description: "Description of the problem"
    severity: high  # critical | high | medium | low
    detection:
      type: regex
      pattern: "some\\.dangerous\\.pattern"
    bad_code: |
      -- What not to do
      some.dangerous.pattern()
    good_code: |
      -- What to do instead
      safe.alternative()
```

Detection types:
- **`regex`** — match a pattern in source code. Optional `requires_context` to check surrounding lines for a guard pattern.
- **`handler_analysis`** — match handler names and body content via `body_matches`, `handler_name_contains`, `handler_name_not_contains`.

## Programmatic Usage

```typescript
import { LuaParser } from 'ao-lens';

const parser = new LuaParser();
const result = parser.parse(sourceCode, 'process.lua');

console.log(result.handlers);       // Handler definitions
console.log(result.state_analysis); // State mutations, ao.sends, determinism issues
console.log(result.stats);          // Summary counts
```

## CLI Reference

```
ao-lens <command> [path] [options]

Commands:
  audit <path>     Run security audit (default)
  parse <path>     Parse and extract structure
  graph <path>     Generate IPC topology
  rules            List loaded detection rules
  diff             Compare baseline vs current audit

Options:
  --pretty         Human-readable output
  --json           JSON output
  --mermaid        Mermaid diagram (graph command)
  --ci             Exit 1 on critical/high issues
  --skills-dir     Path to custom detection rules
  --handlers       Scope to specific handlers
```

## Technology

- **Parser**: [tree-sitter](https://tree-sitter.github.io/) with Lua grammar — robust AST parsing without running code
- **Language**: TypeScript
- **Protocol**: [Model Context Protocol](https://modelcontextprotocol.io/) (MCP)
- **License**: MIT

## Contributing

Issues and pull requests welcome at [github.com/credentum/ao-lens](https://github.com/credentum/ao-lens).

To develop locally:

```bash
git clone https://github.com/credentum/ao-lens.git
cd ao-lens
npm install
npm run build
npm test
```
