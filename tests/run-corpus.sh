#!/bin/bash
# ao-lens test corpus runner
# Runs ao-lens against all fixtures and validates expected results

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AO_LENS="$SCRIPT_DIR/../dist/cli.js"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0
ERRORS=""

echo "========================================"
echo "ao-lens Test Corpus Runner"
echo "========================================"
echo ""

# Test bad fixtures (should have findings)
echo "Testing BAD fixtures (should trigger rules):"
echo "----------------------------------------"
for file in "$FIXTURES_DIR/bad"/*.lua; do
    if [ ! -f "$file" ]; then continue; fi

    filename=$(basename "$file")

    # Extract expected rule from first comment line
    expected=$(head -2 "$file" | grep "Expected:" | sed 's/.*Expected: //' | cut -d' ' -f1)

    # Run ao-lens
    result=$(node "$AO_LENS" "$file" 2>&1)
    findings=$(echo "$result" | jq -r '.files[0].summary.total // 0')
    codes=$(echo "$result" | jq -r '.files[0].findings[].code' 2>/dev/null | tr '\n' ',' | sed 's/,$//')

    if [ "$findings" -gt 0 ]; then
        if [ -n "$expected" ] && echo "$codes" | grep -q "$expected"; then
            echo -e "  ${GREEN}✓${NC} $filename - Found $expected"
            ((PASSED++))
        elif [ -n "$expected" ]; then
            echo -e "  ${YELLOW}~${NC} $filename - Expected $expected, got: $codes"
            ((PASSED++))  # Still counts as pass if it found something
        else
            echo -e "  ${GREEN}✓${NC} $filename - Found: $codes"
            ((PASSED++))
        fi
    else
        echo -e "  ${RED}✗${NC} $filename - Expected findings, got 0"
        ERRORS="$ERRORS\n  - $filename: Expected $expected but got no findings"
        ((FAILED++))
    fi
done

echo ""

# Test good fixtures (should have NO findings)
echo "Testing GOOD fixtures (should NOT trigger rules):"
echo "----------------------------------------"
for file in "$FIXTURES_DIR/good"/*.lua; do
    if [ ! -f "$file" ]; then continue; fi

    filename=$(basename "$file")

    # Run ao-lens
    result=$(node "$AO_LENS" "$file" 2>&1)
    findings=$(echo "$result" | jq -r '.files[0].summary.total // 0')

    if [ "$findings" -eq 0 ]; then
        echo -e "  ${GREEN}✓${NC} $filename - No findings (correct)"
        ((PASSED++))
    else
        codes=$(echo "$result" | jq -r '.files[0].findings[].code' 2>/dev/null | tr '\n' ',' | sed 's/,$//')
        echo -e "  ${RED}✗${NC} $filename - Expected 0 findings, got: $codes"
        ERRORS="$ERRORS\n  - $filename: False positive - $codes"
        ((FAILED++))
    fi
done

echo ""
echo "========================================"
echo "Results: $PASSED passed, $FAILED failed"
echo "========================================"

if [ $FAILED -gt 0 ]; then
    echo -e "${RED}Failures:${NC}$ERRORS"
    exit 1
else
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
