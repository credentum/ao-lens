#!/usr/bin/env python3
"""
gap-finder.py - Find gaps between ao-lens and AO Panel checks

Usage:
    python3 scripts/gap-finder.py <lua-file>
    python3 scripts/gap-finder.py --from-redis <packet-id>

This tool helps identify what AO Panel catches that ao-lens misses,
so we can add new rules to ao-lens.
"""

import json
import subprocess
import sys
import os
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))


def run_ao_lens(lua_file: str) -> dict:
    """Run ao-lens audit on a Lua file."""
    script_dir = Path(__file__).parent.parent
    cli_path = script_dir / "dist" / "cli.js"

    result = subprocess.run(
        ["node", str(cli_path), "audit", lua_file],
        capture_output=True,
        text=True,
        cwd=str(script_dir)
    )

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"error": result.stderr or result.stdout}


def get_ao_panel_from_redis(packet_id: str) -> list[dict]:
    """Get AO Panel results from Redis saga events."""
    try:
        import redis
        from dotenv import load_dotenv
        load_dotenv("/claude-workspace/.env")

        r = redis.Redis(
            host="redis",
            port=6379,
            password=os.environ.get("REDIS_PASSWORD", ""),
            decode_responses=True
        )

        # Try exact match first
        stream_key = f"dev_team:saga_events:{packet_id}"
        events = r.xrange(stream_key)

        if not events:
            # Try pattern match
            for key in r.scan_iter(f"dev_team:saga_events:*{packet_id}*"):
                events = r.xrange(key)
                if events:
                    break

        issues = []
        for event_id, data in events:
            if "ao_panel_completed" in data.get("event_type", ""):
                details = json.loads(data.get("details", "{}"))
                for issue in details.get("issues", []):
                    issues.append({
                        "severity": issue.get("severity", "UNKNOWN"),
                        "expert": issue.get("expert", "Unknown"),
                        "description": issue.get("description", ""),
                        "approved": details.get("approved", False)
                    })

        return issues
    except Exception as e:
        return [{"error": str(e)}]


def get_recent_ao_panel_issues(limit: int = 5) -> list[dict]:
    """Get most recent AO Panel issues from Redis."""
    try:
        import redis
        from dotenv import load_dotenv
        load_dotenv("/claude-workspace/.env")

        r = redis.Redis(
            host="redis",
            port=6379,
            password=os.environ.get("REDIS_PASSWORD", ""),
            decode_responses=True
        )

        all_issues = []
        for key in r.scan_iter("dev_team:saga_events:*"):
            events = r.xrange(key)
            for event_id, data in events:
                if "ao_panel_completed" in data.get("event_type", ""):
                    details = json.loads(data.get("details", "{}"))
                    if not details.get("approved", True):  # Only rejected
                        for issue in details.get("issues", []):
                            all_issues.append({
                                "severity": issue.get("severity", "UNKNOWN"),
                                "expert": issue.get("expert", "Unknown"),
                                "description": issue.get("description", ""),
                                "packet": key.split(":")[-1]
                            })

        return all_issues[:limit * 10]  # Return more for dedup
    except Exception as e:
        return [{"error": str(e)}]


def compare_results(ao_lens_output: dict, ao_panel_issues: list[dict]) -> dict:
    """Compare ao-lens and AO Panel findings."""

    # Extract ao-lens issues
    ao_lens_issues = []
    for file_result in ao_lens_output.get("files", []):
        for finding in file_result.get("findings", []):
            ao_lens_issues.append({
                "severity": finding.get("severity", "unknown").upper(),
                "code": finding.get("code", "UNKNOWN"),
                "message": finding.get("message", ""),
                "line": finding.get("line")
            })

    # Categorize AO Panel issues
    panel_high = [i for i in ao_panel_issues if i.get("severity") == "HIGH"]
    panel_medium = [i for i in ao_panel_issues if i.get("severity") == "MEDIUM"]
    panel_low = [i for i in ao_panel_issues if i.get("severity") in ("LOW", "INFO")]

    return {
        "ao_lens": {
            "total": len(ao_lens_issues),
            "pass": ao_lens_output.get("pass", False),
            "issues": ao_lens_issues
        },
        "ao_panel": {
            "total": len(ao_panel_issues),
            "high": len(panel_high),
            "medium": len(panel_medium),
            "low": len(panel_low),
            "issues": ao_panel_issues
        },
        "gaps": identify_gaps(ao_lens_issues, ao_panel_issues)
    }


def identify_gaps(ao_lens_issues: list, ao_panel_issues: list) -> list[str]:
    """Identify what AO Panel catches that ao-lens misses."""
    gaps = []

    ao_lens_codes = {i.get("code", "") for i in ao_lens_issues}

    # Known mappings from AO Panel descriptions to ao-lens codes
    mappings = {
        "Action tag validation": "MATCHER_MISSING_ACTION_TAG",
        "json.decode": "JSON_DECODE_NO_PCALL",
        "json.encode": "JSON_ENCODE_NO_PCALL",
        "authorization": "NO_AUTH_CHECK",
        "nil guard": "NIL_GUARD_REQUIRED",
        "frozen": "NO_FROZEN_CHECK",
    }

    for issue in ao_panel_issues:
        desc = issue.get("description", "").lower()
        severity = issue.get("severity", "UNKNOWN")

        # Check if ao-lens has a matching rule
        matched = False
        for keyword, code in mappings.items():
            if keyword.lower() in desc:
                if code in ao_lens_codes:
                    matched = True
                    break
                else:
                    gaps.append(f"[{severity}] {issue.get('description')} → needs ao-lens rule: {code}")
                    matched = True
                    break

        if not matched and severity in ("HIGH", "MEDIUM"):
            gaps.append(f"[{severity}] {issue.get('description')} → NEW RULE NEEDED")

    return gaps


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    if sys.argv[1] == "--from-redis":
        if len(sys.argv) < 3:
            print("Usage: python3 gap-finder.py --from-redis <packet-id>")
            sys.exit(1)

        packet_id = sys.argv[2]
        print(f"=== AO Panel Issues for {packet_id} ===\n")

        issues = get_ao_panel_from_redis(packet_id)
        for issue in issues:
            if "error" in issue:
                print(f"Error: {issue['error']}")
            else:
                approved = "✓" if issue.get("approved") else "✗"
                print(f"[{issue['severity']}] {issue['expert']}: {issue['description']}")

    elif sys.argv[1] == "--recent":
        print("=== Recent AO Panel Rejections ===\n")

        issues = get_recent_ao_panel_issues()
        seen = set()
        for issue in issues:
            if "error" in issue:
                print(f"Error: {issue['error']}")
                continue

            # Dedupe by description
            desc = issue.get("description", "")[:50]
            if desc in seen:
                continue
            seen.add(desc)

            print(f"[{issue['severity']}] {issue['description']}")

        print("\n=== Gap Analysis ===")
        print("Add these as ao-lens rules to catch issues earlier:")

        gaps = identify_gaps([], issues)
        for gap in gaps[:10]:
            print(f"  - {gap}")

    else:
        lua_file = sys.argv[1]
        if not os.path.exists(lua_file):
            print(f"Error: File not found: {lua_file}")
            sys.exit(1)

        print(f"=== Analyzing {lua_file} ===\n")

        # Run ao-lens
        print("Running ao-lens...")
        ao_lens_result = run_ao_lens(lua_file)

        if "error" in ao_lens_result:
            print(f"ao-lens error: {ao_lens_result['error']}")
            sys.exit(1)

        print(f"\nao-lens: {ao_lens_result.get('summary', {})}")
        print(f"Pass: {ao_lens_result.get('pass', False)}\n")

        for file_result in ao_lens_result.get("files", []):
            for finding in file_result.get("findings", []):
                sev = finding.get("severity", "?").upper()
                code = finding.get("code", "?")
                msg = finding.get("message", "?")
                line = finding.get("line", "?")
                print(f"  [{sev}] {code}: {msg} (line {line})")

        print("\n=== To compare with AO Panel ===")
        print("Run: python3 scripts/gap-finder.py --recent")
        print("Or:  python3 scripts/gap-finder.py --from-redis <packet-id>")


if __name__ == "__main__":
    main()
