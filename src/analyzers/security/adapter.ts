/**
 * Security Analyzer Adapter
 * Wraps the new modular SecurityAnalyzer with the old interface
 * for backward compatibility with CLI and existing code
 */

import { SecurityAnalyzer as ModularSecurityAnalyzer } from "./index";
import { Finding } from "./types";
import { ParseResult } from "../../types";
import { RuleLoader, DetectionRule, HandlerAnalysisDetection, RegexDetection } from "../../rules";

/**
 * Security finding format (compatible with old interface)
 */
export interface SecurityFinding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  code: string;
  message: string;
  suggestion: string;
  handler?: string;
  line?: number;
  cwe?: string;
}

/**
 * Security report format (compatible with old interface)
 */
export interface SecurityReport {
  file: string;
  findings: SecurityFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    total: number;
  };
}

export interface AnalyzeOptions {
  filterToHandlers?: string[];
}

/**
 * Adapter that wraps the new modular SecurityAnalyzer
 * with the old CLI-compatible interface
 */
export class SecurityAnalyzerAdapter {
  private modularAnalyzer: ModularSecurityAnalyzer;
  private ruleLoader: RuleLoader | null = null;

  constructor(ruleLoader?: RuleLoader) {
    this.modularAnalyzer = new ModularSecurityAnalyzer();
    this.ruleLoader = ruleLoader || null;
  }

  /**
   * Analyze a single ParseResult (old interface)
   */
  analyze(result: ParseResult, options?: AnalyzeOptions): SecurityReport {
    // Use source code from ParseResult
    const sourceCode = result.sourceCode || "";
    const filePath = result.file;

    // Run modular analyzer with context (includes isLibrary detection)
    const analysisResult = this.modularAnalyzer.analyzeWithContext(sourceCode, filePath);
    const findings = analysisResult.findings;
    const isLibrary = analysisResult.context.isLibrary;

    // Apply dynamic rules if loader is present (skip for library files)
    let dynamicFindings: Finding[] = [];
    if (this.ruleLoader && this.ruleLoader.isLoaded() && !isLibrary) {
      dynamicFindings = this.applyDynamicRules(result);
    }

    // Combine findings
    const allFindings = [...findings, ...dynamicFindings];

    // Filter to specific handlers if requested
    let filteredFindings = allFindings;
    if (options?.filterToHandlers && options.filterToHandlers.length > 0) {
      // For now, we don't have handler context in findings
      // The filtering would need to be done differently
      filteredFindings = allFindings;
    }

    // Convert to old format
    const securityFindings = filteredFindings.map((f) =>
      this.toSecurityFinding(f)
    );

    return this.createReport(filePath, securityFindings);
  }

  /**
   * Analyze multiple ParseResults (old interface)
   */
  analyzeMultiple(
    results: ParseResult[],
    options?: AnalyzeOptions
  ): {
    files: SecurityReport[];
    summary: SecurityReport["summary"];
    pass: boolean;
  } {
    const files = results.map((r) => this.analyze(r, options));

    const summary = {
      critical: files.reduce((sum, f) => sum + f.summary.critical, 0),
      high: files.reduce((sum, f) => sum + f.summary.high, 0),
      medium: files.reduce((sum, f) => sum + f.summary.medium, 0),
      low: files.reduce((sum, f) => sum + f.summary.low, 0),
      info: files.reduce((sum, f) => sum + f.summary.info, 0),
      total: files.reduce((sum, f) => sum + f.summary.total, 0),
    };

    // Pass if no critical or high severity issues
    const pass = summary.critical === 0 && summary.high === 0;

    return { files, summary, pass };
  }

  /**
   * Apply dynamic rules from skill YAML files
   * Only applies rules matching lua/ao tech_stack (filters out erlang/hyperbeam-only rules)
   */
  private applyDynamicRules(result: ParseResult): Finding[] {
    if (!this.ruleLoader) return [];

    const findings: Finding[] = [];
    // Filter to rules that apply to Lua/AO (our target language)
    const rules = this.ruleLoader.getRulesForTechStack(["lua", "ao"]);
    const sourceCode = result.sourceCode || "";

    for (const rule of rules) {
      const ruleFindings = this.applyRule(rule, sourceCode, result.file);
      findings.push(...ruleFindings);
    }

    return findings;
  }

  /**
   * Apply a single dynamic rule
   */
  private applyRule(
    rule: DetectionRule,
    sourceCode: string,
    _filePath: string
  ): Finding[] {
    const findings: Finding[] = [];
    const detection = rule.detection;

    if (!detection) return findings;

    // Handle handler_analysis detection type
    if (detection.type === "handler_analysis") {
      const handlerDetection = detection as HandlerAnalysisDetection;
      if (handlerDetection.body_matches) {
        const pattern = new RegExp(handlerDetection.body_matches, "g");
        const lines = sourceCode.split("\n");

        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            findings.push({
              code: rule.id,
              message: rule.description,
              severity: rule.severity as Finding["severity"],
              line: i + 1,
            });
          }
        }
      }
    }

    // Handle regex detection type
    if (detection.type === "regex") {
      const regexDetection = detection as RegexDetection;
      const pattern = new RegExp(regexDetection.pattern, "g");
      const lines = sourceCode.split("\n");

      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          let hasGuard = false;
          const linesToCheck = regexDetection.lines_to_check || 5;

          // Check for requires_context: same line + preceding lines (for inline nil guards)
          if (regexDetection.requires_context) {
            const contextPattern = new RegExp(regexDetection.requires_context);
            // Check current line first (most important for inline guards)
            if (contextPattern.test(lines[i])) {
              hasGuard = true;
            } else {
              // Check preceding lines
              const precedingLines = lines.slice(Math.max(0, i - linesToCheck), i).join("\n");
              if (contextPattern.test(precedingLines)) {
                hasGuard = true;
              }
            }
          }

          // Check for requires_following: following lines only
          if (!hasGuard && regexDetection.requires_following) {
            const followingLines = lines.slice(i + 1, i + 1 + linesToCheck).join("\n");
            const followPattern = new RegExp(regexDetection.requires_following);
            if (followPattern.test(followingLines)) {
              hasGuard = true;
            }
          }

          // Report finding if no guard found (when any requires_* is specified)
          if (regexDetection.requires_context || regexDetection.requires_following) {
            if (!hasGuard) {
              findings.push({
                code: rule.id,
                message: rule.description,
                severity: rule.severity as Finding["severity"],
                line: i + 1,
              });
            }
          } else {
            // No guard requirement - always report
            findings.push({
              code: rule.id,
              message: rule.description,
              severity: rule.severity as Finding["severity"],
              line: i + 1,
            });
          }
        }
      }
    }

    return findings;
  }

  /**
   * Convert Finding to SecurityFinding
   */
  private toSecurityFinding(finding: Finding): SecurityFinding {
    return {
      severity: finding.severity,
      code: finding.code,
      message: finding.message,
      suggestion: finding.fix || "",
      line: finding.line,
      cwe: finding.cwe,
    };
  }

  /**
   * Create SecurityReport from findings
   */
  private createReport(file: string, findings: SecurityFinding[]): SecurityReport {
    const summary = {
      critical: findings.filter((f) => f.severity === "critical").length,
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length,
      info: findings.filter((f) => f.severity === "info").length,
      total: findings.length,
    };

    return { file, findings, summary };
  }
}
