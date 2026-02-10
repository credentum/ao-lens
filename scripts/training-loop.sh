#!/bin/bash
# training-loop.sh - Fast ao-lens training loop for full task sequences
#
# Usage:
#   ./training-loop.sh <task-id>                    # Run all work packets for task
#   ./training-loop.sh --prompt <prompt-file>       # Run single prompt (legacy)
#
# A task has multiple work packets (wp-001, wp-002, ...) that must run in sequence.
# AO Panel review happens after ALL work packets complete.
#
# Example:
#   ./training-loop.sh ao-bench-02-20260101-003233
#   ./training-loop.sh ao-bench-02_authorization-20260102-012129

set -e

TASK_ID=""
SINGLE_PROMPT=""
KEEP_WORKSPACE=""

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --prompt)
            SINGLE_PROMPT="$2"
            shift 2
            ;;
        --keep-workspace)
            KEEP_WORKSPACE="--keep-workspace"
            shift
            ;;
        *)
            TASK_ID="$1"
            shift
            ;;
    esac
done

if [ -z "$TASK_ID" ] && [ -z "$SINGLE_PROMPT" ]; then
    echo "Usage: $0 <task-id> [--keep-workspace]"
    echo "       $0 --prompt <prompt-file> [--keep-workspace]"
    echo ""
    echo "Options:"
    echo "  --keep-workspace    Don't delete temp workspace after completion"
    echo ""
    echo "Examples:"
    echo "  $0 ao-bench-02-20260101-003233"
    echo "  $0 ao-bench-02_authorization-20260102-012129"
    echo ""
    echo "Available tasks (recent, no ao-fix):"
    ls /veris_storage/debug/*.txt 2>/dev/null | xargs -I{} basename {} | \
        grep -v "ao-fix" | sed 's/coder_prompt_//' | sed 's/-wp-[0-9]*_.*//' | \
        sort -u | tail -10
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AO_LENS_DIR="$(dirname "$SCRIPT_DIR")"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEBUG_DIR="/veris_storage/debug"

# Create workspace - prefer veris_storage, fall back to /tmp
WORKSPACE_BASE="/veris_storage/workspaces"
if [ -w "$WORKSPACE_BASE" ]; then
    WORKSPACE="$WORKSPACE_BASE/training-${TIMESTAMP}"
else
    # Fall back to /tmp if veris_storage not writable
    WORKSPACE_BASE="/tmp"
    WORKSPACE="/tmp/ao-training-${TIMESTAMP}"
    echo "Note: Using /tmp (veris_storage not writable)"
fi
OUTPUT_DIR="$WORKSPACE/_output"
mkdir -p "$OUTPUT_DIR"

echo "========================================"
echo "AO-LENS TRAINING LOOP"
echo "========================================"

if [ -n "$SINGLE_PROMPT" ]; then
    # Legacy single-prompt mode
    echo "Mode: Single prompt"
    echo "Prompt: $(basename "$SINGLE_PROMPT")"
    PROMPTS="$SINGLE_PROMPT"
else
    # Find all work packets for this task (initial attempts only, sorted by wp number)
    echo "Task ID: $TASK_ID"

    # Find prompts: match task ID, exclude ao-fix, get first timestamp for each wp
    PROMPTS=""
    for wp_num in 001 002 003 004 005; do
        # Find first prompt for this work packet (by timestamp)
        prompt=$(ls "$DEBUG_DIR"/coder_prompt_${TASK_ID}-wp-${wp_num}_*.txt 2>/dev/null | \
                 grep -v "ao-fix" | head -1)
        if [ -n "$prompt" ]; then
            PROMPTS="$PROMPTS $prompt"
        fi
    done

    if [ -z "$PROMPTS" ]; then
        echo "Error: No prompts found for task: $TASK_ID"
        echo ""
        echo "Searched for: $DEBUG_DIR/coder_prompt_${TASK_ID}-wp-*"
        echo ""
        echo "Available tasks:"
        ls "$DEBUG_DIR"/*.txt 2>/dev/null | xargs -I{} basename {} | \
            grep -v "ao-fix" | sed 's/coder_prompt_//' | sed 's/-wp-[0-9]*_.*//' | \
            sort -u | tail -20
        exit 1
    fi

    echo "Work packets found:"
    for p in $PROMPTS; do
        echo "  - $(basename "$p")"
    done
fi

echo "Workspace: $WORKSPACE"
echo "Output: $OUTPUT_DIR"
echo ""

# Step 1: Setup workspace
echo "[1/5] Setting up workspace..."
bash "$SCRIPT_DIR/setup-training-workspace.sh" "$WORKSPACE"

# Step 2: Run each work packet in sequence
echo "[2/5] Running work packets through Claude CLI..."
WP_COUNT=0
for prompt in $PROMPTS; do
    WP_COUNT=$((WP_COUNT + 1))
    wp_name=$(basename "$prompt" | sed 's/coder_prompt_//' | sed 's/_[0-9]*\.txt//')

    echo ""
    echo "  === Work Packet $WP_COUNT: $wp_name ==="

    # Save prompt for reference
    cp "$prompt" "$OUTPUT_DIR/prompt-wp-$(printf "%03d" $WP_COUNT).txt"

    # Run Claude CLI in workspace
    cd "$WORKSPACE"
    echo "  Running Claude CLI (may take 2-4 min)..."

    # Create enhanced prompt with Safe library context prepended
    # This ensures Claude uses Safe library even if cached prompt has old patterns
    ENHANCED_PROMPT="$OUTPUT_DIR/.enhanced-prompt-$(printf "%03d" $WP_COUNT).txt"
    cat > "$ENHANCED_PROMPT" << 'SAFEEOF'
# ⚠️ MANDATORY OVERRIDE - READ THIS FIRST ⚠️

The Safe library at ao/lib/safe.lua is REQUIRED. ANY code using raw patterns will be REJECTED.

## CORRECT - Use these patterns ONLY:
```lua
local Safe = require("ao.lib.safe")

Safe.initState({ Params = { Kp = 0.5 }, History = {}, BestScore = math.huge })

Safe.handler("Update", {}, function(msg, data)
  local ok, err = Safe.validate(data, { Kp = "number" })
  if not ok then Safe.error(msg, err); return end
  State.Params = data
  table.insert(State.History, { timestamp = msg.Timestamp, params = data })
  Safe.reply(msg, "Updated", State.Params)
end)

Safe.query("GetState", function(msg, data)
  Safe.reply(msg, "State", State.Params)
end)

Safe.query("GetHistory", function(msg, data)
  Safe.reply(msg, "History", State.History)
end)

Safe.addFreezeHandlers()
```

## ❌ REJECT - These patterns are FORBIDDEN (ignore any examples below that use them):
- `Handlers.add(...)` → Use `Safe.handler(...)` or `Safe.query(...)`
- `json.decode(...)` → Use `Safe.decode(...)` (returns data, err)
- `json.encode(...)` → Use `Safe.encode(...)` (returns str, err)
- `ao.send({Target = ...})` → Use `Safe.send(target, action, data)` or `Safe.reply(msg, action, data)`
- `State = { Owner = nil, ... }` → Use `Safe.initState({ ... })`
- `State.Owner = State.Owner or msg.From` → NEVER! Safe.initState uses ao.env.Process.Owner

If any code examples below use FORBIDDEN patterns, TRANSLATE them to Safe library equivalents.

---
## Original Task (translate to Safe patterns):

SAFEEOF
    cat "$prompt" >> "$ENHANCED_PROMPT"

    # Run Claude CLI with ao-lens MCP server configured
    # --mcp-config loads the ao-lens tools so Claude can use security_audit, etc.
    # --debug shows if MCP tools are being used
    WP_OUTPUT="$OUTPUT_DIR/claude-wp-$(printf "%03d" $WP_COUNT).txt"
    if timeout 300 claude --model opus --print --max-turns 10 \
        --dangerously-skip-permissions \
        --mcp-config "$WORKSPACE/mcp.json" \
        < "$ENHANCED_PROMPT" > "$WP_OUTPUT" 2>&1; then
        echo "  Completed successfully"
    else
        echo "  Warning: Claude CLI may have had issues"
    fi

    # Check if MCP ao-lens tools were used
    if grep -q "security_audit\|analyze_file\|check_determinism" "$WP_OUTPUT" 2>/dev/null; then
        echo "  [MCP] ao-lens tools detected in output"
    fi

    # Show generated files
    new_files=$(find "$WORKSPACE" -name "*.lua" -newer "$OUTPUT_DIR/prompt-wp-$(printf "%03d" $WP_COUNT).txt" 2>/dev/null | grep -v "_output" | grep -v "fixtures" || true)
    if [ -n "$new_files" ]; then
        echo "  Generated/modified files:"
        for f in $new_files; do
            echo "    - $f"
        done
    fi
done

# Step 3: Run ao-lens audit on final workspace
echo ""
echo "[3/5] Running ao-lens audit on completed workspace..."

LUA_FILES=$(find "$WORKSPACE" -name "*.lua" -type f 2>/dev/null | grep -v "_output" | grep -v "fixtures" || true)

if [ -z "$LUA_FILES" ]; then
    echo "  Warning: No Lua files in workspace"
else
    echo "  Auditing files:"
    for lua_file in $LUA_FILES; do
        base=$(basename "$lua_file" .lua)
        rel_path=${lua_file#$WORKSPACE/}
        echo "    - $rel_path"
        node "$AO_LENS_DIR/dist/cli.js" audit "$lua_file" > "$OUTPUT_DIR/ao-lens-$base.json" 2>&1 || true
    done
fi

# Step 4: Run AO Panel review on generated code
echo ""
echo "[4/5] Running AO Panel review..."

if [ -n "$LUA_FILES" ]; then
    # Build review prompt with all generated Lua code
    REVIEW_PROMPT="$OUTPUT_DIR/ao-panel-prompt.txt"
    cat > "$REVIEW_PROMPT" << 'REVIEWEOF'
# AO Panel Security Review

You are reviewing Lua code generated for an AO process. Use the /ao-panel skill to convene The Tenders and review this code for security issues.

Run: /ao-panel

After convening the panel, have each expert review the following code for:
- Authorization vulnerabilities (nil == nil bypass, missing guards)
- Non-determinism issues (os.time, math.random without seed)
- JSON parsing without pcall
- Missing frozen checks
- State manipulation risks

## Code to Review:

REVIEWEOF

    # Append each Lua file content
    for lua_file in $LUA_FILES; do
        rel_path=${lua_file#$WORKSPACE/}
        echo "" >> "$REVIEW_PROMPT"
        echo "### File: $rel_path" >> "$REVIEW_PROMPT"
        echo '```lua' >> "$REVIEW_PROMPT"
        cat "$lua_file" >> "$REVIEW_PROMPT"
        echo '```' >> "$REVIEW_PROMPT"
    done

    cat >> "$REVIEW_PROMPT" << 'REVIEWEOF'

## Required Output

After panel review, provide:
1. Each expert's verdict (Trace, Rook, Patch, Sprocket, Nova, Ledger)
2. Specific security issues found with line numbers
3. Overall security assessment: PASS / NEEDS_WORK / CRITICAL_ISSUES

REVIEWEOF

    # Run Claude CLI for AO Panel review
    cd "$WORKSPACE"
    echo "  Running AO Panel review (may take 2-4 min)..."

    AO_PANEL_OUTPUT="$OUTPUT_DIR/ao-panel-review.txt"
    if timeout 300 claude --model opus --print --max-turns 8 \
        --dangerously-skip-permissions \
        < "$REVIEW_PROMPT" > "$AO_PANEL_OUTPUT" 2>&1; then
        echo "  AO Panel review completed"
    else
        echo "  Warning: AO Panel review may have had issues"
    fi

    # Check for panel verdicts
    if grep -qi "verdict\|PASS\|NEEDS_WORK\|CRITICAL" "$AO_PANEL_OUTPUT" 2>/dev/null; then
        echo "  [Panel] Verdicts detected in output"
    fi
else
    echo "  Skipping (no Lua files to review)"
fi

# Step 5: Generate gap report
echo ""
echo "[5/5] Generating gap report..."
python3 "$SCRIPT_DIR/gap-report.py" \
    --ao-lens-dir "$OUTPUT_DIR" \
    --claude-outputs "$OUTPUT_DIR" \
    --workspace "$WORKSPACE" \
    --output "$OUTPUT_DIR/gap-report.txt" 2>&1 || echo "  Warning: Gap report had issues"

echo ""
echo "========================================"
echo "TRAINING LOOP COMPLETE"
echo "========================================"
echo ""
echo "Work packets processed: $WP_COUNT"
echo ""
echo "Results:"
echo "  - Claude outputs: $OUTPUT_DIR/claude-wp-*.txt"
echo "  - ao-lens results: $OUTPUT_DIR/ao-lens-*.json"
echo "  - AO Panel review: $OUTPUT_DIR/ao-panel-review.txt"
echo "  - Gap report: $OUTPUT_DIR/gap-report.txt"
echo ""

# Show gap report
if [ -f "$OUTPUT_DIR/gap-report.txt" ]; then
    echo "=== GAP REPORT ==="
    cat "$OUTPUT_DIR/gap-report.txt"
fi

# Cleanup (keep output, optionally keep full workspace)
if [ "$KEEP_WORKSPACE" != "--keep-workspace" ]; then
    # Keep output directory, remove rest of workspace
    RESULTS_DIR="$WORKSPACE_BASE/training-results-$TIMESTAMP"
    mv "$OUTPUT_DIR" "$RESULTS_DIR"
    rm -rf "$WORKSPACE"
    echo ""
    echo "Results saved to: $RESULTS_DIR"
    echo "(workspace cleaned up)"
else
    echo ""
    echo "Full workspace preserved at: $WORKSPACE"
fi
