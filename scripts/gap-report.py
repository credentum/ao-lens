#!/usr/bin/env python3
"""
gap-report.py - Compare ao-lens findings with AO Panel verdict

Parses Claude output for AO Panel expert verdicts and compares against
ao-lens static analysis results to identify detection gaps.

Usage:
    python3 gap-report.py --ao-lens-dir <dir> --claude-outputs <dir> --workspace <dir> --output <file>
"""

import argparse
import json
import re
import sys
from pathlib import Path


def parse_ao_lens_findings(ao_lens_dir: Path) -> list[dict]:
    """Extract findings from all ao-lens JSON files in directory."""
    findings = []

    for json_file in ao_lens_dir.glob("ao-lens-*.json"):
        try:
            with open(json_file) as f:
                data = json.load(f)

            # Handle both single file and multi-file output formats
            if "files" in data:
                for file_result in data.get("files", []):
                    for finding in file_result.get("findings", []):
                        findings.append({
                            "severity": finding.get("severity", "unknown").upper(),
                            "code": finding.get("code", "UNKNOWN"),
                            "message": finding.get("message", ""),
                            "line": finding.get("line"),
                            "file": file_result.get("file", json_file.stem),
                            "source": "ao-lens"
                        })
            elif "findings" in data:
                for finding in data.get("findings", []):
                    findings.append({
                        "severity": finding.get("severity", "unknown").upper(),
                        "code": finding.get("code", "UNKNOWN"),
                        "message": finding.get("message", ""),
                        "line": finding.get("line"),
                        "file": json_file.stem.replace("ao-lens-", ""),
                        "source": "ao-lens"
                    })
        except (json.JSONDecodeError, FileNotFoundError) as e:
            print(f"  Warning: Could not parse {json_file}: {e}", file=sys.stderr)

    return findings


def parse_ao_panel_verdicts(claude_output_dir: Path) -> list[dict]:
    """Extract AO Panel verdicts from Claude output files."""
    issues = []

    # The 6 Tenders experts
    experts = ["Trace", "Rook", "Patch", "Sprocket", "Nova", "Ledger"]

    # Check both work packet outputs and dedicated AO Panel review file
    output_files = list(claude_output_dir.glob("claude-wp-*.txt"))
    ao_panel_review = claude_output_dir / "ao-panel-review.txt"
    if ao_panel_review.exists():
        output_files.append(ao_panel_review)

    for output_file in output_files:
        try:
            with open(output_file) as f:
                content = f.read()

            # Check if AO Panel was invoked (more flexible matching)
            # The dedicated ao-panel-review.txt may not have this marker
            is_panel_review = output_file.name == "ao-panel-review.txt"
            has_panel_marker = "[AO PANEL CONVENED]" in content or "AO PANEL" in content.upper()
            has_expert_names = any(expert in content for expert in experts)

            if not is_panel_review and not has_panel_marker and not has_expert_names:
                continue

            # Extract expert verdicts - multiple format patterns
            for expert in experts:
                # Pattern 1: Header format "### N. Expert —", "### **Expert** —", or "### **Expert —"
                # Find sections for each expert
                section_pattern = rf"###\s*(?:\d+\.\s*)?(?:\*\*)?{expert}(?:\*\*)?\s*[—-].*?(?=###\s*(?:\d+\.|\*\*)|## Panel|## Security|## AO-Specific|## Overall|$)"
                section_match = re.search(section_pattern, content, re.DOTALL | re.IGNORECASE)

                if section_match:
                    section = section_match.group(0)
                    # Look for verdict in this section - use \S* to skip any emoji prefix
                    # Match any of: "Issue Found", "SECURITY ISSUE", with optional emoji and trailing text
                    # Handle both "Issue Found" and "**Issue Found**" (bold markdown)
                    # Also handle "CRITICAL SECURITY ISSUE", "Minor Issue", etc.
                    verdict_pattern = r"\*\*Verdict:\*\*\s*\S*\s*(?:\*\*)?(?:CRITICAL\s+)?(Issue Found|Issue|SECURITY ISSUE|SECURITY ISSUE FOUND|Minor Issue|Looks Good|Need More Info)(?:\*\*)?"
                    verdict_match = re.search(verdict_pattern, section, re.IGNORECASE)

                    if verdict_match:
                        verdict = verdict_match.group(1)
                        if "issue" in verdict.lower() or "security" in verdict.lower():
                            # Extract description: everything after verdict on the same line
                            # Handle bold markdown: **Issue Found** or Issue Found
                            # Also handle "Minor Issue", "CRITICAL SECURITY ISSUE", etc.
                            desc_pattern = r"\*\*Verdict:\*\*.*?(?:\*\*)?(?:CRITICAL\s+)?(?:Issue Found|Minor Issue|SECURITY ISSUE|SECURITY ISSUE FOUND)(?:\*\*)?\s*[-—:]*\s*([^\n]+)"
                            desc_match = re.search(desc_pattern, section, re.IGNORECASE)
                            description = desc_match.group(1).strip() if desc_match else ""

                            # Clean up description - remove trailing parentheticals like "(minor...)"
                            if description.startswith("("):
                                # Try to get diagnosis instead
                                description = ""

                            # Try to get the diagnosis if no description
                            if not description:
                                diag_pattern = r'\*\*Diagnosis:\*\*\s*"([^"]+)"'
                                diag_match = re.search(diag_pattern, section)
                                if diag_match:
                                    description = diag_match.group(1)[:100]

                            # Look for "Missing" patterns which indicate specific issues
                            missing_pattern = r'\*\*Missing[^:]*:\*\*\s*([^\n]+)'
                            missing_match = re.search(missing_pattern, section)
                            if missing_match:
                                missing_text = missing_match.group(1).strip()
                                if description:
                                    description = f"{description}. Missing: {missing_text[:50]}"
                                else:
                                    description = f"Missing: {missing_text}"

                            issues.append({
                                "severity": "CRITICAL" if "SECURITY" in verdict.upper() else "HIGH",
                                "expert": expert,
                                "verdict": verdict,
                                "description": description[:100] if description else f"{expert} found issue",
                                "file": output_file.name,
                                "source": "ao-panel"
                            })
                    continue

                # Pattern 2: Legacy format "**Expert:** ... Verdict: X"
                pattern = rf"\*\*{expert}[:\*].*?(?:Verdict:\s*)(Issue Found|SECURITY ISSUE|Looks Good|Need More Info)"
                matches = re.findall(pattern, content, re.DOTALL | re.IGNORECASE)

                for verdict in matches:
                    if "issue" in verdict.lower() or "security" in verdict.lower():
                        # Try to extract the description
                        desc_pattern = rf"\*\*{expert}[:\*]\*\*\s*\"?([^\"*\n]+)"
                        desc_match = re.search(desc_pattern, content)
                        description = desc_match.group(1).strip() if desc_match else ""

                        issues.append({
                            "severity": "CRITICAL" if "SECURITY" in verdict.upper() else "HIGH",
                            "expert": expert,
                            "verdict": verdict,
                            "description": description[:100],
                            "file": output_file.name,
                            "source": "ao-panel"
                        })

            # Also check for Security Check result
            security_pattern = r"\*\*Security Check:\*\*\s*(?:🔴\s*)?(FAIL|PASS)"
            security_match = re.search(security_pattern, content)
            if security_match and security_match.group(1) == "FAIL":
                issues.append({
                    "severity": "CRITICAL",
                    "expert": "Panel",
                    "verdict": "FAIL",
                    "description": "Security Check Failed",
                    "file": output_file.name,
                    "source": "ao-panel"
                })

            # Check for overall assessment from dedicated review
            # Pattern: ### **NEEDS_WORK** or "Overall Security Assessment" section
            assessment_pattern = r"(?:###\s*\*\*|Overall\s+Security\s+Assessment[:\s]*\n+###\s*\*\*)(PASS|NEEDS_WORK|CRITICAL_ISSUES)\*\*"
            assessment_match = re.search(assessment_pattern, content, re.IGNORECASE)
            if assessment_match:
                verdict = assessment_match.group(1).upper()
                if verdict in ["NEEDS_WORK", "CRITICAL_ISSUES"]:
                    issues.append({
                        "severity": "CRITICAL" if "CRITICAL" in verdict else "HIGH",
                        "expert": "Panel",
                        "verdict": verdict,
                        "description": f"Overall Assessment: {verdict}",
                        "file": output_file.name,
                        "source": "ao-panel"
                    })

            # Parse Security Check Summary table for specific missing items
            # Format: | Category | ❌ MISSING | Line |
            missing_pattern = r"\|\s*([^|]+)\s*\|\s*❌\s*MISSING\s*\|"
            missing_matches = re.findall(missing_pattern, content)
            for category in missing_matches:
                category = category.strip()
                if category and category not in ["Category", "Status"]:
                    issues.append({
                        "severity": "HIGH",
                        "expert": "SecurityTable",
                        "verdict": "MISSING",
                        "description": f"Missing: {category}",
                        "file": output_file.name,
                        "source": "ao-panel"
                    })

        except FileNotFoundError as e:
            print(f"  Warning: Could not read {output_file}: {e}", file=sys.stderr)

    return issues


# Known mappings from AO Panel issues to ao-lens rule codes
ISSUE_TO_RULE_MAPPING = {
    "authorization": ["NO_AUTH_CHECK", "MISSING_OWNER_CHECK"],
    "nil guard": ["NIL_GUARD_REQUIRED", "UNSAFE_NIL_COMPARISON", "OWNER_EXPLICIT_NIL", "AO_SEND_TARGET_NO_NIL_GUARD"],
    "nil == nil": ["NIL_GUARD_REQUIRED", "OWNER_EXPLICIT_NIL"],
    "nil==nil": ["OWNER_EXPLICIT_NIL", "NIL_GUARD_REQUIRED"],
    "missing nil": ["OWNER_EXPLICIT_NIL", "AO_SEND_TARGET_NO_NIL_GUARD", "NIL_GUARD_REQUIRED"],
    "explicit nil": ["OWNER_EXPLICIT_NIL"],
    "owner": ["NO_AUTH_CHECK", "UNSAFE_OWNER_OR_PATTERN", "OWNER_NEVER_INITIALIZED", "OWNER_EXPLICIT_NIL", "FIRST_CALLER_WINS_OWNER"],
    "owner = nil": ["OWNER_EXPLICIT_NIL"],
    "first-caller": ["FIRST_CALLER_WINS_OWNER"],
    "first caller": ["FIRST_CALLER_WINS_OWNER"],
    "race condition": ["FIRST_CALLER_WINS_OWNER"],
    "claim ownership": ["FIRST_CALLER_WINS_OWNER"],
    "msg.from": ["AO_SEND_TARGET_NO_NIL_GUARD"],
    "target = msg": ["AO_SEND_TARGET_NO_NIL_GUARD"],
    "json.decode": ["JSON_DECODE_NO_PCALL", "MSG_DATA_NO_JSON_DECODE"],
    "json.encode": ["JSON_ENCODE_NO_PCALL"],
    "nil values in json": ["JSON_ENCODE_NO_PCALL"],
    "could be nil": ["JSON_ENCODE_NO_PCALL"],
    "pcall": ["JSON_DECODE_NO_PCALL", "JSON_ENCODE_NO_PCALL", "MSG_DATA_NO_JSON_DECODE"],
    "json protection": ["JSON_DECODE_NO_PCALL", "MSG_DATA_NO_JSON_DECODE"],
    "frozen": ["NO_FROZEN_CHECK"],
    "frozen check": ["NO_FROZEN_CHECK"],
    "hasMatchingTag": ["HASMATCHING_TAG_NO_HANDLER_AUTH", "LOOSE_MATCHER_MUTATION"],
    "determinism": ["DETERMINISM_VIOLATION", "OS_TIME_USAGE", "MATH_RANDOM_UNSEEDED"],
    "os.time": ["DETERMINISM_VIOLATION", "OS_TIME_USAGE"],
    "non-determinism": ["DETERMINISM_VIOLATION", "OS_TIME_USAGE", "MATH_RANDOM_UNSEEDED"],
    "math.random": ["DETERMINISM_VIOLATION", "MATH_RANDOM_UNSEEDED"],
    "schema": ["NO_SCHEMA_VALIDATION"],
    "schema validation": ["NO_SCHEMA_VALIDATION"],
    "missing schema": ["NO_SCHEMA_VALIDATION"],
    "validation": ["NO_SCHEMA_VALIDATION"],
    "type validation": ["NO_SCHEMA_VALIDATION"],
    "not validated": ["NO_SCHEMA_VALIDATION"],
    "accepts any": ["NO_SCHEMA_VALIDATION"],
    "required keys": ["NO_SCHEMA_VALIDATION"],
    "matcher accepts": ["NO_SCHEMA_VALIDATION"],
    "state mutation": ["HANDLER_NO_STATE_MUTATION"],
    "no-op": ["HANDLER_NO_STATE_MUTATION"],
    "doesn't mutate": ["HANDLER_NO_STATE_MUTATION"],
    "skeleton": ["HANDLER_NO_STATE_MUTATION"],
    "no actual": ["HANDLER_NO_STATE_MUTATION"],
    "msg.data": ["MSG_DATA_NO_JSON_DECODE"],
    "state overwrite": ["ARBITRARY_STATE_OVERWRITE"],
    "arbitrary": ["ARBITRARY_STATE_OVERWRITE"],
    "overwrite owner": ["ARBITRARY_STATE_OVERWRITE"],
    "corrupt": ["ARBITRARY_STATE_OVERWRITE"],
    "bounds": ["BOUNDS_DEFINED_NOT_ENFORCED", "NO_BOUNDS_DEFINED"],
    "bounds not enforced": ["BOUNDS_DEFINED_NOT_ENFORCED"],
    "no parameter bounds": ["NO_BOUNDS_DEFINED"],
    "unbounded": ["NO_BOUNDS_DEFINED"],
    "exceed": ["BOUNDS_DEFINED_NOT_ENFORCED"],
    "timestamp": ["NO_TIMESTAMP_TRACKING"],
    "audit trail": ["NO_TIMESTAMP_TRACKING"],
    "temporal": ["NO_TIMESTAMP_TRACKING"],
    "replay": ["NO_TIMESTAMP_TRACKING"],
    # Domain-specific PID controller checks (Nova - controls researcher)
    "learning infrastructure": ["DOMAIN_SPECIFIC_PID"],
    "missing bounds": ["DOMAIN_SPECIFIC_PID", "BOUNDS_DEFINED_NOT_ENFORCED"],
    "score tracking": ["DOMAIN_SPECIFIC_PID"],
    "history tracking": ["DOMAIN_SPECIFIC_PID"],
    "no learning": ["DOMAIN_SPECIFIC_PID"],
}


def identify_gaps(ao_lens_findings: list, ao_panel_issues: list) -> list[dict]:
    """Identify issues AO Panel caught that ao-lens missed."""
    gaps = []

    # Collect ao-lens rule codes
    ao_lens_codes = {f["code"] for f in ao_lens_findings}

    for issue in ao_panel_issues:
        description = issue.get("description", "").lower()

        # Try to map to ao-lens rules
        matched_rules = []
        for keyword, rules in ISSUE_TO_RULE_MAPPING.items():
            if keyword in description:
                matched_rules.extend(rules)

        # Check if ao-lens caught any of the expected rules
        covered = any(rule in ao_lens_codes for rule in matched_rules)

        if not covered:
            gaps.append({
                "severity": issue["severity"],
                "expert": issue["expert"],
                "description": issue["description"],
                "expected_rules": matched_rules if matched_rules else ["NEW_RULE_NEEDED"],
                "covered_by_ao_lens": False
            })

    return gaps


def generate_report(
    ao_lens_findings: list,
    ao_panel_issues: list,
    gaps: list,
    workspace: Path,
    output_file: Path
) -> None:
    """Generate the gap report."""
    lines = []

    lines.append("=" * 60)
    lines.append("AO-LENS vs AO PANEL GAP ANALYSIS")
    lines.append("=" * 60)
    lines.append("")

    # ao-lens findings summary
    lines.append(f"ao-lens findings: {len(ao_lens_findings)}")
    if ao_lens_findings:
        by_severity = {}
        for f in ao_lens_findings:
            sev = f["severity"]
            by_severity[sev] = by_severity.get(sev, 0) + 1
        for sev in ["CRITICAL", "HIGH", "MEDIUM", "LOW"]:
            if sev in by_severity:
                lines.append(f"  {sev}: {by_severity[sev]}")

        lines.append("")
        lines.append("  Details:")
        for f in ao_lens_findings[:10]:  # Show first 10
            lines.append(f"    [{f['severity']}] {f['code']}: {f['message'][:50]}")
        if len(ao_lens_findings) > 10:
            lines.append(f"    ... and {len(ao_lens_findings) - 10} more")

    lines.append("")
    lines.append("-" * 60)
    lines.append("")

    # AO Panel issues summary
    lines.append(f"AO Panel issues: {len(ao_panel_issues)}")
    if ao_panel_issues:
        by_expert = {}
        for issue in ao_panel_issues:
            expert = issue["expert"]
            by_expert[expert] = by_expert.get(expert, 0) + 1
        for expert, count in sorted(by_expert.items()):
            lines.append(f"  {expert}: {count}")

        lines.append("")
        lines.append("  Details:")
        for issue in ao_panel_issues[:10]:
            lines.append(f"    [{issue['severity']}] {issue['expert']}: {issue['description'][:50]}")
        if len(ao_panel_issues) > 10:
            lines.append(f"    ... and {len(ao_panel_issues) - 10} more")

    lines.append("")
    lines.append("-" * 60)
    lines.append("")

    # Gaps analysis
    lines.append("GAPS (AO Panel caught, ao-lens missed):")
    lines.append("")

    if gaps:
        for gap in gaps:
            lines.append(f"  [{gap['severity']}] {gap['expert']}: {gap['description']}")
            if gap["expected_rules"]:
                if gap["expected_rules"] == ["NEW_RULE_NEEDED"]:
                    lines.append(f"    -> NEW RULE NEEDED (no mapping found)")
                else:
                    lines.append(f"    -> Expected rules: {', '.join(gap['expected_rules'])}")
            lines.append("")
    else:
        lines.append("  None! ao-lens caught everything AO Panel found.")
        lines.append("")

    lines.append("=" * 60)
    lines.append("")

    # Summary
    if gaps:
        lines.append("RECOMMENDED ACTIONS:")
        new_rules_needed = [g for g in gaps if g["expected_rules"] == ["NEW_RULE_NEEDED"]]
        missing_rules = set()
        for g in gaps:
            if g["expected_rules"] != ["NEW_RULE_NEEDED"]:
                missing_rules.update(g["expected_rules"])

        if missing_rules:
            lines.append(f"  1. Verify these rules are implemented: {', '.join(sorted(missing_rules))}")
        if new_rules_needed:
            lines.append(f"  2. Investigate {len(new_rules_needed)} issues that may need new rules")

    # Write report
    report_content = "\n".join(lines)
    output_file.write_text(report_content)

    # Also print to stdout
    print(report_content)


def main():
    parser = argparse.ArgumentParser(description="Compare ao-lens vs AO Panel findings")
    parser.add_argument("--ao-lens-dir", required=True, help="Directory with ao-lens JSON outputs")
    parser.add_argument("--claude-outputs", required=True, help="Directory with Claude output files")
    parser.add_argument("--workspace", required=True, help="Workspace directory")
    parser.add_argument("--output", required=True, help="Output report file")
    args = parser.parse_args()

    ao_lens_dir = Path(args.ao_lens_dir)
    claude_dir = Path(args.claude_outputs)
    workspace = Path(args.workspace)
    output_file = Path(args.output)

    # Parse findings
    ao_lens_findings = parse_ao_lens_findings(ao_lens_dir)
    ao_panel_issues = parse_ao_panel_verdicts(claude_dir)

    # Identify gaps
    gaps = identify_gaps(ao_lens_findings, ao_panel_issues)

    # Generate report
    generate_report(ao_lens_findings, ao_panel_issues, gaps, workspace, output_file)


if __name__ == "__main__":
    main()
