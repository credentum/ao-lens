#!/bin/bash
# run-training-batch.sh - Run training loop on multiple tasks
#
# Usage:
#   ./run-training-batch.sh                     # Run on recent tasks
#   ./run-training-batch.sh --pattern "ao-bench-02"  # Match pattern
#   ./run-training-batch.sh --list              # List available tasks
#   ./run-training-batch.sh --recent 5          # Run on 5 most recent
#
# Examples:
#   ./run-training-batch.sh --pattern "ao-bench-02_authorization"
#   ./run-training-batch.sh --recent 3

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEBUG_DIR="/veris_storage/debug"
PATTERN=""
RECENT_COUNT=0
LIST_ONLY=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --pattern)
            PATTERN="$2"
            shift 2
            ;;
        --recent)
            RECENT_COUNT="$2"
            shift 2
            ;;
        --list)
            LIST_ONLY=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Get unique task IDs (no ao-fix, first prompt per task)
get_task_ids() {
    ls "$DEBUG_DIR"/*.txt 2>/dev/null | xargs -I{} basename {} | \
        grep -v "ao-fix" | \
        sed 's/coder_prompt_//' | \
        sed 's/-wp-[0-9]*_.*//' | \
        sort -u
}

# Filter by pattern if specified
if [ -n "$PATTERN" ]; then
    TASKS=$(get_task_ids | grep "$PATTERN" || true)
else
    TASKS=$(get_task_ids)
fi

# Limit to recent if specified
if [ "$RECENT_COUNT" -gt 0 ]; then
    TASKS=$(echo "$TASKS" | tail -n "$RECENT_COUNT")
fi

# Count tasks
TASK_COUNT=$(echo "$TASKS" | grep -c . || echo 0)

if [ "$LIST_ONLY" = true ]; then
    echo "Available tasks (no ao-fix, unique):"
    echo ""
    echo "$TASKS" | head -30
    if [ "$TASK_COUNT" -gt 30 ]; then
        echo ""
        echo "... and $((TASK_COUNT - 30)) more"
    fi
    echo ""
    echo "Total: $TASK_COUNT tasks"
    exit 0
fi

if [ "$TASK_COUNT" -eq 0 ]; then
    echo "No tasks found."
    echo ""
    echo "Use --list to see available tasks"
    echo "Use --pattern 'filter' to filter by name"
    exit 1
fi

echo "========================================"
echo "AO-LENS TRAINING BATCH"
echo "========================================"
echo "Tasks to process: $TASK_COUNT"
echo ""

# Create batch results directory
BATCH_TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BATCH_DIR="/veris_storage/workspaces/training-batch-$BATCH_TIMESTAMP"
mkdir -p "$BATCH_DIR"

echo "Batch results: $BATCH_DIR"
echo ""

# Track results
PASSED=0
FAILED=0
GAPS_FOUND=0

# Process each task
TASK_NUM=0
for task_id in $TASKS; do
    TASK_NUM=$((TASK_NUM + 1))

    echo ""
    echo "========================================"
    echo "[$TASK_NUM/$TASK_COUNT] Task: $task_id"
    echo "========================================"

    TASK_LOG="$BATCH_DIR/$task_id.log"

    if bash "$SCRIPT_DIR/training-loop.sh" "$task_id" --keep-workspace > "$TASK_LOG" 2>&1; then
        # Check if gaps were found
        if grep -q "GAPS.*ao-lens missed" "$TASK_LOG"; then
            echo "  Result: GAPS FOUND"
            GAPS_FOUND=$((GAPS_FOUND + 1))
        else
            echo "  Result: PASSED (no gaps)"
            PASSED=$((PASSED + 1))
        fi
    else
        echo "  Result: FAILED (check $TASK_LOG)"
        FAILED=$((FAILED + 1))
    fi

    # Show brief summary from log
    if [ -f "$TASK_LOG" ]; then
        echo ""
        grep -A5 "GAP REPORT" "$TASK_LOG" 2>/dev/null | head -10 || true
    fi
done

echo ""
echo "========================================"
echo "BATCH COMPLETE"
echo "========================================"
echo ""
echo "Summary:"
echo "  Total tasks:  $TASK_COUNT"
echo "  Passed:       $PASSED"
echo "  Gaps found:   $GAPS_FOUND"
echo "  Failed:       $FAILED"
echo ""
echo "Results: $BATCH_DIR"
echo ""

# Generate aggregate report
echo "=== AGGREGATE GAP REPORT ===" > "$BATCH_DIR/aggregate-gaps.txt"
echo "" >> "$BATCH_DIR/aggregate-gaps.txt"

for log in "$BATCH_DIR"/*.log; do
    if [ -f "$log" ]; then
        task=$(basename "$log" .log)
        if grep -q "GAPS.*ao-lens missed" "$log"; then
            echo "=== $task ===" >> "$BATCH_DIR/aggregate-gaps.txt"
            grep -A20 "GAPS.*ao-lens missed" "$log" >> "$BATCH_DIR/aggregate-gaps.txt" 2>/dev/null || true
            echo "" >> "$BATCH_DIR/aggregate-gaps.txt"
        fi
    fi
done

echo "Aggregate gap report: $BATCH_DIR/aggregate-gaps.txt"
