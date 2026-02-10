/**
 * Security Analyzer
 * Context-aware security analysis for AO/Lua processes
 *
 * This module provides a refactored security analyzer that:
 * 1. Builds ProcessContext once per file
 * 2. Runs all checks against the shared context
 * 3. Deduplicates findings
 *
 * Usage:
 *   const analyzer = new SecurityAnalyzer();
 *   const findings = analyzer.analyze(sourceCode, filePath);
 */

import { ProcessContextBuilder } from "./context";
import { CheckRegistry } from "./registry";
import { Finding, ProcessContext, SecurityCheck } from "./types";

// Re-export types for consumers
export { Finding, ProcessContext, SecurityCheck } from "./types";
export { ProcessContextBuilder } from "./context";
export { CheckRegistry } from "./registry";
export {
  SecurityAnalyzerAdapter,
  SecurityFinding,
  SecurityReport,
  AnalyzeOptions,
} from "./adapter";

export interface SecurityAnalysisResult {
  findings: Finding[];
  context: ProcessContext;
  checkCount: number;
}

export class SecurityAnalyzer {
  private contextBuilder: ProcessContextBuilder;
  private registry: CheckRegistry;

  constructor() {
    this.contextBuilder = new ProcessContextBuilder();
    this.registry = new CheckRegistry();
  }

  /**
   * Analyze source code for security issues
   */
  analyze(sourceCode: string, filePath: string): Finding[] {
    // Build context ONCE
    const context = this.contextBuilder.build(sourceCode, filePath);

    // Run all registered checks
    const findings: Finding[] = [];
    for (const check of this.registry.getChecks()) {
      try {
        // Skip process-specific checks for library files
        // Library files don't run as AO processes, so auth/frozen/handler checks don't apply
        if (context.isLibrary && !check.appliesToLibrary) {
          continue;
        }
        // Skip production rules for test files
        // Test files don't need Safe library, auth checks, etc.
        if (context.isTestFile && check.appliesToTestFile === false) {
          continue;
        }
        const checkFindings = check.run(context);
        findings.push(...checkFindings);
      } catch (error) {
        // Log but don't fail on individual check errors
        console.error(`Check ${check.id} failed:`, error);
      }
    }

    // Deduplicate findings
    return this.deduplicate(findings);
  }

  /**
   * Analyze with full result including context
   */
  analyzeWithContext(
    sourceCode: string,
    filePath: string
  ): SecurityAnalysisResult {
    const context = this.contextBuilder.build(sourceCode, filePath);

    const findings: Finding[] = [];
    for (const check of this.registry.getChecks()) {
      try {
        // Skip process-specific checks for library files
        if (context.isLibrary && !check.appliesToLibrary) {
          continue;
        }
        // Skip production rules for test files
        if (context.isTestFile && check.appliesToTestFile === false) {
          continue;
        }
        findings.push(...check.run(context));
      } catch (error) {
        console.error(`Check ${check.id} failed:`, error);
      }
    }

    return {
      findings: this.deduplicate(findings),
      context,
      checkCount: this.registry.getCheckCount(),
    };
  }

  /**
   * Run specific checks only
   */
  runChecks(
    sourceCode: string,
    filePath: string,
    checkIds: string[]
  ): Finding[] {
    const context = this.contextBuilder.build(sourceCode, filePath);

    const findings: Finding[] = [];
    for (const id of checkIds) {
      const check = this.registry.getCheck(id);
      if (check) {
        try {
          findings.push(...check.run(context));
        } catch (error) {
          console.error(`Check ${id} failed:`, error);
        }
      }
    }

    return this.deduplicate(findings);
  }

  /**
   * Get list of available checks
   */
  getAvailableChecks(): { id: string; category: string; description: string }[] {
    return this.registry.getChecks().map((check) => ({
      id: check.id,
      category: check.category,
      description: check.description,
    }));
  }

  /**
   * Deduplicate findings by code+line
   */
  private deduplicate(findings: Finding[]): Finding[] {
    const seen = new Map<string, Finding>();

    for (const finding of findings) {
      const key = `${finding.code}:${finding.line}`;
      if (!seen.has(key)) {
        seen.set(key, finding);
      }
    }

    // Sort by severity, then line
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    return Array.from(seen.values()).sort((a, b) => {
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (severityDiff !== 0) return severityDiff;
      return a.line - b.line;
    });
  }
}
