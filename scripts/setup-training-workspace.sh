#!/bin/bash
# setup-training-workspace.sh - Setup workspace for ao-lens training loop
#
# Usage: ./setup-training-workspace.sh <workspace-dir>
#
# Creates a workspace in /veris_storage/workspaces/ with:
# - ao/                 (where generated Lua goes)
# - tools/ao-lens/tests/fixtures/  (reference patterns)
# - .claude/            (symlink to skills for AO Panel)
# - CLAUDE.md           (minimal instructions)

set -e

WORKSPACE="$1"

if [ -z "$WORKSPACE" ]; then
    echo "Usage: $0 <workspace-dir>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AO_LENS_DIR="$(dirname "$SCRIPT_DIR")"
VIVARIUM_DIR="$(dirname "$(dirname "$AO_LENS_DIR")")"

echo "Setting up training workspace: $WORKSPACE"

# Create required directories
mkdir -p "$WORKSPACE/ao/lib"
mkdir -p "$WORKSPACE/tools/ao-lens/tests/fixtures"

# Copy the Safe library (CRITICAL - this enables secure-by-default patterns)
if [ -f "$VIVARIUM_DIR/ao/lib/safe.lua" ]; then
    cp "$VIVARIUM_DIR/ao/lib/safe.lua" "$WORKSPACE/ao/lib/"
    echo "  Copied Safe library from vivarium"
fi

# Copy reference fixtures (prompts reference these as read-only)
if [ -d "$AO_LENS_DIR/tests/fixtures" ]; then
    cp -r "$AO_LENS_DIR/tests/fixtures"/* "$WORKSPACE/tools/ao-lens/tests/fixtures/" 2>/dev/null || true
    echo "  Copied fixtures from ao-lens"
fi

# Setup .claude directory with skills
# Check multiple possible locations for skills
SKILLS_SOURCES=(
    "/claude-workspace/.claude/skills"
    "/veris_storage/workspaces/dev_team/.claude"
    "$VIVARIUM_DIR/.claude/skills"
    "/app/agent-dev/.claude/skills"
)

CLAUDE_DIR="$WORKSPACE/.claude"
mkdir -p "$CLAUDE_DIR"

for skills_src in "${SKILLS_SOURCES[@]}"; do
    if [ -d "$skills_src" ]; then
        if [ -L "$skills_src" ]; then
            # It's a symlink, get the real path
            real_path=$(readlink -f "$skills_src")
            if [ -d "$real_path" ]; then
                ln -sf "$real_path" "$CLAUDE_DIR/skills" 2>/dev/null || cp -r "$real_path" "$CLAUDE_DIR/skills" 2>/dev/null || true
                echo "  Linked skills from: $real_path"
                break
            fi
        else
            ln -sf "$skills_src" "$CLAUDE_DIR/skills" 2>/dev/null || cp -r "$skills_src" "$CLAUDE_DIR/skills" 2>/dev/null || true
            echo "  Linked skills from: $skills_src"
            break
        fi
    fi
done

# Create MCP config with ao-lens server path
# The path must be absolute for Claude CLI to find it
cat > "$WORKSPACE/mcp.json" << EOF
{
  "mcpServers": {
    "ao-lens": {
      "command": "node",
      "args": ["$AO_LENS_DIR/dist/mcp-server.js"],
      "env": {},
      "_comment": "ao-lens MCP server for Lua/AO semantic analysis"
    }
  }
}
EOF
echo "  Created MCP config with ao-lens at: $AO_LENS_DIR/dist/mcp-server.js"

# Create CLAUDE.md that MANDATES Safe library
cat > "$WORKSPACE/CLAUDE.md" << 'EOF'
# CLAUDE.md - AO/Lua Development

## MANDATORY: Use the Safe Library

**ALL AO code MUST use the Safe library.** This eliminates 90%+ of security issues.

```lua
local Safe = require("ao.lib.safe")

-- Initialize state (REQUIRED first)
Safe.initState({ Params = { Kp = 0.5 }, History = {} })

-- Owner-only handler (default: owner=true, frozen=true)
Safe.handler("Update", {}, function(msg, data)
  State.Params = data.params
  Safe.reply(msg, "Updated", { params = State.Params })
end)

-- Public query (no auth required)
Safe.query("GetState", function(msg, data)
  Safe.reply(msg, "State", State.Params)
end)

-- Add standard freeze/unfreeze handlers
Safe.addFreezeHandlers()
```

### Safe Library Functions

| Function | Purpose |
|----------|---------|
| `Safe.initState(defaults)` | Initialize State with Owner from spawn |
| `Safe.handler(name, opts, fn)` | Secure handler with all guards |
| `Safe.query(name, fn)` | Public read-only handler |
| `Safe.send(target, action, data)` | Safe message send |
| `Safe.reply(msg, action, data)` | Reply to sender |
| `Safe.decode(raw)` | JSON decode with pcall |
| `Safe.encode(data)` | JSON encode with pcall |
| `Safe.validate(data, schema)` | Validate field types |
| `Safe.validateBounds(val, min, max)` | Check numeric bounds |

## FORBIDDEN: Raw Patterns

**NEVER use these directly** (use Safe library instead):

```lua
-- FORBIDDEN: Use Safe.handler() instead
Handlers.add("Update", function(msg) ... end, function(msg) ... end)

-- FORBIDDEN: Use Safe.decode() instead
local data = json.decode(msg.Data)

-- FORBIDDEN: Use Safe.send() or Safe.reply() instead
ao.send({ Target = msg.From, Data = json.encode(data) })

-- FORBIDDEN: Use Safe.initState() instead
State.Owner = State.Owner or msg.From  -- FIRST-CALLER-WINS VULNERABILITY!
```

## Complete Example

```lua
-- pid.lua - PID Controller with Safe Library
local Safe = require("ao.lib.safe")

Safe.initState({
  Params = { Kp = 0.5, Ki = 0.1, Kd = 0.05 },
  History = {},
  BestScore = math.huge
})

Safe.handler("Update", {}, function(msg, data)
  local ok, err = Safe.validate(data, { Kp = "number", Ki = "number", Kd = "number" })
  if not ok then Safe.error(msg, err); return end

  local ok, err = Safe.validateBounds(data.Kp, 0, 10, "Kp")
  if not ok then Safe.error(msg, err); return end

  State.Params = { Kp = data.Kp, Ki = data.Ki, Kd = data.Kd }
  table.insert(State.History, { timestamp = msg.Timestamp, params = State.Params })
  Safe.reply(msg, "Updated", { params = State.Params })
end)

Safe.query("GetState", function(msg, data)
  Safe.reply(msg, "State", State.Params)
end)

Safe.addFreezeHandlers()
```
EOF

# Create .luacheckrc for linting
cat > "$WORKSPACE/.luacheckrc" << 'EOF'
globals = {"State", "Handlers", "ao", "json", "msg", "Safe"}
max_line_length = 120
EOF

echo "Workspace ready: $WORKSPACE"
echo "  - ao/                          (write Lua here)"
echo "  - tools/ao-lens/tests/fixtures/ (reference patterns)"
echo "  - .claude/skills/              (AO Panel skill)"
echo "  - CLAUDE.md                    (instructions)"
