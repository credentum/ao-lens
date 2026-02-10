/**
 * ao-lens diff - Regression detection for audit results
 *
 * Compares baseline vs current audit results to detect:
 * - New issues introduced (regressions)
 * - Issues resolved (improvements)
 * - Moved issues (same code, different line)
 *
 * Used to detect when fix attempts make code worse.
 */

import { SecurityFinding, SecurityReport } from "./analyzers/security";

export interface DiffSummary {
  new_critical: number;
  new_high: number;
  new_medium: number;
  new_low: number;
  new_info: number;
  resolved_critical: number;
  resolved_high: number;
  resolved_medium: number;
  resolved_low: number;
  resolved_info: number;
}

export interface DiffResult {
  /** True if new critical or high issues were introduced */
  regression_detected: boolean;
  /** Findings in current but not in baseline (new issues) */
  new_findings: FindingWithFile[];
  /** Findings in baseline but not in current (resolved) */
  resolved_findings: FindingWithFile[];
  /** Findings that moved line numbers but are essentially the same */
  moved_findings: MovedFinding[];
  /** Counts by severity */
  summary: DiffSummary;
  /** Overall pass/fail status */
  baseline_passed: boolean;
  current_passed: boolean;
}

export interface FindingWithFile extends SecurityFinding {
  file: string;
}

export interface MovedFinding {
  finding: FindingWithFile;
  from_line: number;
  to_line: number;
}

/**
 * Audit result structure (as output by ao-lens audit command)
 */
export interface AuditResult {
  schema_version: string;
  timestamp: string;
  files: SecurityReport[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    total: number;
  };
  pass: boolean;
}

/**
 * Create a unique key for a finding (ignoring line number for fuzzy matching)
 * Used to detect if an issue is "the same" even if it moved
 */
function createFindingKey(file: string, finding: SecurityFinding): string {
  // Include handler if present, as same code in different handlers is different issue
  const handler = finding.handler || "";
  return `${file}|${finding.code}|${finding.severity}|${handler}`;
}

/**
 * Create a strict key including line number for exact matching
 */
function createStrictFindingKey(file: string, finding: SecurityFinding): string {
  const handler = finding.handler || "";
  const line = finding.line || 0;
  return `${file}|${finding.code}|${finding.severity}|${handler}|${line}`;
}

/**
 * Extract all findings from an audit result with file info attached
 */
function extractFindings(audit: AuditResult): FindingWithFile[] {
  const findings: FindingWithFile[] = [];
  for (const fileReport of audit.files) {
    for (const finding of fileReport.findings) {
      findings.push({
        ...finding,
        file: fileReport.file,
      });
    }
  }
  return findings;
}

/**
 * Compare two audit results and detect regressions
 */
export function diffAuditResults(
  baseline: AuditResult,
  current: AuditResult
): DiffResult {
  const baselineFindings = extractFindings(baseline);
  const currentFindings = extractFindings(current);

  // Build maps for comparison
  // Strict map: exact match including line number
  const baselineStrict = new Map<string, FindingWithFile>();
  for (const f of baselineFindings) {
    baselineStrict.set(createStrictFindingKey(f.file, f), f);
  }

  // Fuzzy map: match without line number (to detect moves)
  const baselineFuzzy = new Map<string, FindingWithFile[]>();
  for (const f of baselineFindings) {
    const key = createFindingKey(f.file, f);
    if (!baselineFuzzy.has(key)) {
      baselineFuzzy.set(key, []);
    }
    baselineFuzzy.get(key)!.push(f);
  }

  const currentStrict = new Map<string, FindingWithFile>();
  for (const f of currentFindings) {
    currentStrict.set(createStrictFindingKey(f.file, f), f);
  }

  const currentFuzzy = new Map<string, FindingWithFile[]>();
  for (const f of currentFindings) {
    const key = createFindingKey(f.file, f);
    if (!currentFuzzy.has(key)) {
      currentFuzzy.set(key, []);
    }
    currentFuzzy.get(key)!.push(f);
  }

  // Find new findings (in current but not baseline)
  const newFindings: FindingWithFile[] = [];
  const movedFindings: MovedFinding[] = [];
  const matchedBaseline = new Set<string>();

  for (const f of currentFindings) {
    const strictKey = createStrictFindingKey(f.file, f);
    const fuzzyKey = createFindingKey(f.file, f);

    if (baselineStrict.has(strictKey)) {
      // Exact match - not new
      matchedBaseline.add(strictKey);
    } else if (baselineFuzzy.has(fuzzyKey)) {
      // Fuzzy match - might be moved
      const baseMatches = baselineFuzzy.get(fuzzyKey)!;
      const unmatchedBase = baseMatches.find(
        (b) => !matchedBaseline.has(createStrictFindingKey(b.file, b))
      );
      if (unmatchedBase) {
        // This is a moved finding
        matchedBaseline.add(createStrictFindingKey(unmatchedBase.file, unmatchedBase));
        if (unmatchedBase.line !== f.line) {
          movedFindings.push({
            finding: f,
            from_line: unmatchedBase.line || 0,
            to_line: f.line || 0,
          });
        }
      } else {
        // No unmatched baseline - this is genuinely new (same type of issue, new occurrence)
        newFindings.push(f);
      }
    } else {
      // No match at all - genuinely new
      newFindings.push(f);
    }
  }

  // Find resolved findings (in baseline but not current)
  const resolvedFindings: FindingWithFile[] = [];
  for (const f of baselineFindings) {
    const strictKey = createStrictFindingKey(f.file, f);
    const fuzzyKey = createFindingKey(f.file, f);

    // If this finding wasn't matched during new finding detection
    if (!matchedBaseline.has(strictKey)) {
      // Check if there's any matching finding in current (by fuzzy key)
      const currentMatches = currentFuzzy.get(fuzzyKey);
      if (!currentMatches || currentMatches.length === 0) {
        // No match - this issue was resolved
        resolvedFindings.push(f);
      }
      // If there are fuzzy matches, some were already accounted for as moved
    }
  }

  // Calculate summary
  const summary: DiffSummary = {
    new_critical: newFindings.filter((f) => f.severity === "critical").length,
    new_high: newFindings.filter((f) => f.severity === "high").length,
    new_medium: newFindings.filter((f) => f.severity === "medium").length,
    new_low: newFindings.filter((f) => f.severity === "low").length,
    new_info: newFindings.filter((f) => f.severity === "info").length,
    resolved_critical: resolvedFindings.filter((f) => f.severity === "critical").length,
    resolved_high: resolvedFindings.filter((f) => f.severity === "high").length,
    resolved_medium: resolvedFindings.filter((f) => f.severity === "medium").length,
    resolved_low: resolvedFindings.filter((f) => f.severity === "low").length,
    resolved_info: resolvedFindings.filter((f) => f.severity === "info").length,
  };

  // Regression is detected if new critical or high issues were introduced
  const regression_detected =
    summary.new_critical > 0 || summary.new_high > 0;

  return {
    regression_detected,
    new_findings: newFindings,
    resolved_findings: resolvedFindings,
    moved_findings: movedFindings,
    summary,
    baseline_passed: baseline.pass,
    current_passed: current.pass,
  };
}

/**
 * Format diff result for pretty printing
 */
export function formatDiffPretty(diff: DiffResult): string {
  const lines: string[] = [];
  const red = "\x1b[31m";
  const green = "\x1b[32m";
  const yellow = "\x1b[33m";
  const cyan = "\x1b[36m";
  const reset = "\x1b[0m";

  lines.push("");
  lines.push("=".repeat(60));
  lines.push("ao-lens DIFF REPORT");
  lines.push("=".repeat(60));

  // Overall status
  const statusText = diff.regression_detected
    ? `${red}REGRESSION DETECTED${reset}`
    : `${green}NO REGRESSION${reset}`;
  lines.push(`\nSTATUS: ${statusText}`);

  // Summary
  lines.push("\nSUMMARY:");
  lines.push(`  Baseline passed: ${diff.baseline_passed ? "yes" : "no"}`);
  lines.push(`  Current passed:  ${diff.current_passed ? "yes" : "no"}`);

  // New issues
  const totalNew =
    diff.summary.new_critical +
    diff.summary.new_high +
    diff.summary.new_medium +
    diff.summary.new_low +
    diff.summary.new_info;
  lines.push(`\n${red}NEW ISSUES: ${totalNew}${reset}`);
  if (diff.summary.new_critical > 0) {
    lines.push(`  Critical: ${diff.summary.new_critical}`);
  }
  if (diff.summary.new_high > 0) {
    lines.push(`  High: ${diff.summary.new_high}`);
  }
  if (diff.summary.new_medium > 0) {
    lines.push(`  Medium: ${diff.summary.new_medium}`);
  }
  if (diff.summary.new_low > 0) {
    lines.push(`  Low: ${diff.summary.new_low}`);
  }
  if (diff.summary.new_info > 0) {
    lines.push(`  Info: ${diff.summary.new_info}`);
  }

  // Resolved issues
  const totalResolved =
    diff.summary.resolved_critical +
    diff.summary.resolved_high +
    diff.summary.resolved_medium +
    diff.summary.resolved_low +
    diff.summary.resolved_info;
  lines.push(`\n${green}RESOLVED: ${totalResolved}${reset}`);
  if (diff.summary.resolved_critical > 0) {
    lines.push(`  Critical: ${diff.summary.resolved_critical}`);
  }
  if (diff.summary.resolved_high > 0) {
    lines.push(`  High: ${diff.summary.resolved_high}`);
  }
  if (diff.summary.resolved_medium > 0) {
    lines.push(`  Medium: ${diff.summary.resolved_medium}`);
  }
  if (diff.summary.resolved_low > 0) {
    lines.push(`  Low: ${diff.summary.resolved_low}`);
  }
  if (diff.summary.resolved_info > 0) {
    lines.push(`  Info: ${diff.summary.resolved_info}`);
  }

  // Moved issues
  if (diff.moved_findings.length > 0) {
    lines.push(`\n${cyan}MOVED: ${diff.moved_findings.length}${reset}`);
    for (const moved of diff.moved_findings) {
      lines.push(
        `  ${moved.finding.code} in ${moved.finding.file}: line ${moved.from_line} → ${moved.to_line}`
      );
    }
  }

  // Detail new issues
  if (diff.new_findings.length > 0) {
    lines.push("\n" + "-".repeat(60));
    lines.push("NEW ISSUES (details):");
    for (const f of diff.new_findings) {
      const handler = f.handler ? ` (${f.handler})` : "";
      const line = f.line ? ` [line ${f.line}]` : "";
      lines.push(`  [${f.severity.toUpperCase()}] ${f.code}${handler}${line}`);
      lines.push(`    ${f.file}: ${f.message}`);
    }
  }

  // Detail resolved issues
  if (diff.resolved_findings.length > 0) {
    lines.push("\n" + "-".repeat(60));
    lines.push("RESOLVED ISSUES (details):");
    for (const f of diff.resolved_findings) {
      const handler = f.handler ? ` (${f.handler})` : "";
      const line = f.line ? ` [line ${f.line}]` : "";
      lines.push(`  [${f.severity.toUpperCase()}] ${f.code}${handler}${line}`);
      lines.push(`    ${f.file}: ${f.message}`);
    }
  }

  lines.push("\n" + "=".repeat(60));

  return lines.join("\n");
}
