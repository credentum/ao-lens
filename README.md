# ao-lens

Agent-native semantic analysis engine for AO/Lua development.

## Overview

ao-lens helps AI agents understand AO code semantically through:
- **Global context** - not just current cursor position
- **Relationship mapping** - who calls what, what mutates state
- **Semantic validity** - is this handler secure?
- **Agent-driven exploration** - query handlers by semantic criteria

Unlike traditional LSPs that optimize for human developers (latency, UI, autocomplete), ao-lens provides primitives agents need.

## Installation

```bash
npm install
npm run build
```

## CLI Usage

```bash
# Parse a single file (JSON output)
ao-lens parse pid.lua

# Parse with pretty output
ao-lens parse pid.lua --pretty

# Parse a directory
ao-lens parse ao/

# Run security audit
ao-lens audit ao/
```

## MCP Server

ao-lens exposes 11 semantic analysis tools via Model Context Protocol:

```bash
# Start MCP server
npm run mcp
# or
node dist/mcp-server.js
```

### Available Tools

| Tool | Description |
|------|-------------|
| `analyze_file` | Parse Lua file and extract handlers, functions, state access |
| `analyze_handler` | Get detailed handler analysis by name |
| `list_handlers` | List handlers with action tags and strictness levels |
| `map_architecture` | Generate IPC topology graph (json/mermaid/summary) |
| `find_state_mutations` | Find all State.* mutations in files |
| `check_determinism` | Check for replay-safety violations |
| `security_audit` | Run security audit with severity-ranked findings |
| `get_function_details` | Get function details by name with body analysis |
| `get_handler_body` | Get handler source and detailed analysis |
| `find_state_usage` | Find reads/writes to state field across files |
| `query_handlers` | Query handlers with semantic filters |

### Agent-Driven Semantic Exploration (Sprint 7)

Four new tools enable coder agents to navigate code semantically:

#### get_function_details
```json
{
  "file_path": "pid.lua",
  "function_name": "validateParams"
}
// Returns: name, params, source_snippet, body_analysis (calls, state access)
```

#### get_handler_body
```json
{
  "file_path": "pid.lua",
  "handler_name": "Update"
}
// Returns: source code, auth_pattern, checks_frozen, state_reads/writes, ao_sends, local_functions_called
```

#### find_state_usage
```json
{
  "path": "ao/",
  "state_field": "State.Params"
}
// Returns: all reads/writes with handler context
```

#### query_handlers
```json
{
  "path": "ao/",
  "filters": {
    "mutates_state": true,
    "has_auth": false
  }
}
// Returns: handlers matching semantic criteria
```

**Filter options:**
- `action_pattern` - Regex for action tag (e.g., `"Set.*"`)
- `name_pattern` - Regex for handler name
- `has_auth` - Has authorization check
- `has_frozen_check` - Checks frozen state
- `mutates_state` - Modifies State.*
- `strictness` - `"loose"` | `"moderate"` | `"strict"`

### MCP Configuration

```json
{
  "mcpServers": {
    "ao-lens": {
      "command": "node",
      "args": ["/path/to/ao-lens/dist/mcp-server.js"]
    }
  }
}
```

## Output Schema (v1.5)

```json
{
  "schema_version": "1.5",
  "file": "pid.lua",
  "success": true,
  "functions": [...],
  "globals": [...],
  "handlers": [
    {
      "name": "Update",
      "line": 51,
      "signature_type": "function_matcher",
      "trigger": { "action_tag": "Update", "checks_frozen": true },
      "matcher_analysis": { "strictness": "strict", "checks_authorization": true }
    }
  ],
  "state_analysis": {
    "state_mutations": [...],
    "ao_sends": [...],
    "determinism_issues": [...]
  },
  "stats": {
    "total_lines": 118,
    "function_count": 6,
    "handler_count": 3,
    "state_write_count": 5,
    "ao_send_count": 3
  }
}
```

## Sprint Status

- [x] Sprint 1: AST Foundation
- [x] Sprint 2: Handler Mapper
- [x] Sprint 3: State & Side-Effect Tracking
- [x] Sprint 4: IPC Topology
- [x] Sprint 5: Agent Interface (MCP)
- [x] Sprint 6: CI Integration & Security Audit
- [x] Sprint 7: Agent-Driven Semantic Exploration

## Security Checks

ao-lens includes 25+ security checks:

| Severity | Check |
|----------|-------|
| Critical | Nil guard on State.Owner comparison |
| Critical | Owner never initialized |
| Critical | Local State shadow |
| High | No authorization check |
| High | No frozen check on mutating handler |
| High | JSON decode without pcall |
| High | JSON encode without pcall |
| High | Owner `or` pattern allows hijack if false (NEW) |
| High | Determinism violations (os.time, math.random) |
| High | assert(not State.Frozen) nil bypass |
| Medium | Missing schema validation |
| Medium | Conditional auth instead of assert |
| Medium | Inconsistent nil/truthiness checks (NEW) |
| Medium | Unsafe direct state assignment |
| Low | `and` truthiness in auth assertions (NEW) |
| Low | Info leak: sender address in error message (NEW) |
| Low | Info leak: input data in error message (NEW) |

## Technology

- **Parser**: tree-sitter with @tree-sitter-grammars/tree-sitter-lua
- **Language**: TypeScript
- **Interface**: CLI + MCP Server
- **Protocol**: Model Context Protocol (MCP) v1.25
