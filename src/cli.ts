#!/usr/bin/env node
/**
 * ao-lens CLI
 * Agent-native semantic analysis for AO/Lua
 */

import * as fs from "fs";
import * as path from "path";
import { LuaParser } from "./parser/lua-parser";
import { IPCAnalyzer } from "./analyzers/ipc-analyzer";
import { SecurityAnalyzerAdapter as SecurityAnalyzer, SecurityReport } from "./analyzers/security";
import { RuleLoader, findSkillsDir } from "./rules";
import { ParseResult, SCHEMA_VERSION } from "./types";
import { AuditResult, diffAuditResults, formatDiffPretty } from "./diff";

interface CLIArgs {
  command: "parse" | "graph" | "audit" | "rules" | "diff";
  files: string[];
  format: "json" | "pretty" | "mermaid";
  ci: boolean;
  help: boolean;
  version: boolean;
  skillsDir: string | null;
  handlers: string[] | null;  // Handler names to scope validation (issue #240)
}

function parseArgs(args: string[]): CLIArgs {
  const result: CLIArgs = {
    command: "audit",  // Default to audit (security analysis) - most useful for agents
    files: [],
    format: "json",
    ci: false,
    help: false,
    version: false,
    skillsDir: null,
    handlers: null,  // No handler filter by default (validate all)
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--pretty" || arg === "-p") {
      result.format = "pretty";
    } else if (arg === "--json" || arg === "-j") {
      result.format = "json";
    } else if (arg === "--mermaid" || arg === "-m") {
      result.format = "mermaid";
    } else if (arg === "--ci") {
      result.ci = true;
    } else if (arg === "--skills-dir" || arg === "-s") {
      // Next argument is the skills directory path
      if (i + 1 < args.length) {
        result.skillsDir = args[++i];
      }
    } else if (arg === "--handlers" || arg === "-H") {
      // Next argument is comma-separated handler names to scope validation
      if (i + 1 < args.length) {
        result.handlers = args[++i].split(",").map(h => h.trim()).filter(h => h.length > 0);
      }
    } else if (arg === "parse") {
      result.command = "parse";
    } else if (arg === "graph") {
      result.command = "graph";
    } else if (arg === "audit") {
      result.command = "audit";
    } else if (arg === "rules") {
      result.command = "rules";
    } else if (arg === "diff") {
      result.command = "diff";
    } else if (!arg.startsWith("-")) {
      result.files.push(arg);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
ao-lens v${SCHEMA_VERSION} - Agent-native semantic analysis for AO/Lua

USAGE:
  ao-lens parse <file.lua> [options]
  ao-lens graph <directory> [options]
  ao-lens audit <path> [options]
  ao-lens rules --skills-dir <path>
  ao-lens diff <baseline.json> <current.json> [options]

COMMANDS:
  audit     Security audit with severity levels (default)
  parse     Parse Lua files and extract structure only
  graph     Generate IPC message flow graph from multiple files
  rules     List loaded detection rules from skill YAML files
  diff      Compare two audit results to detect regressions

OPTIONS:
  -p, --pretty           Pretty print output
  -j, --json             JSON output (default)
  -m, --mermaid          Mermaid diagram output (graph command only)
  --ci                   CI mode: exit code 1 if critical/high issues found
  -s, --skills-dir PATH  Load dynamic rules from skill YAML files
  -H, --handlers NAMES   Comma-separated handler names to validate (default: all)
  -h, --help             Show this help
  -v, --version          Show version

EXAMPLES:
  ao-lens pid.lua              Run security audit (default)
  ao-lens pid.lua --pretty     Security audit with readable output
  ao-lens pid.lua --ci         Exit code 1 if critical/high issues
  ao-lens pid.lua -H Query     Validate only Query handler
  ao-lens pid.lua -H Query,Update  Validate Query and Update handlers
  ao-lens parse pid.lua        Extract structure only (no security)
  ao-lens graph ao/ --mermaid  Generate IPC message flow diagram
  ao-lens audit handler.lua --pretty
  ao-lens audit ao/ --skills-dir ./skills/ao/
  ao-lens rules --skills-dir ./skills/
  ao-lens diff baseline.json current.json --ci  # Exit 1 if regression
  ao-lens diff baseline.json current.json --pretty

SECURITY AUDIT:
  Built-in checks:
  - Missing msg.From authorization (CRITICAL)
  - Unsafe Owner 'or' pattern without assert (CRITICAL)
  - Loose matchers on mutating handlers (HIGH)
  - Determinism violations (HIGH)
  - Missing frozen checks (MEDIUM)
  - Missing schema validation (MEDIUM)

  Dynamic rules (with --skills-dir):
  - INIT_OWNER_FROM_MSG: Initialize handler hijacking
  - OWNER_CHANGEABLE_AFTER_SPAWN: Owner mutation after init
  - (and more from skill YAML anti_patterns with detection rules)

EXIT CODES (--ci mode):
  0  All checks passed (no critical/high issues)
  1  Security issues found (critical or high severity)
  2  Parse/runtime error

DIFF COMMAND:
  Compares two audit results (JSON files from 'ao-lens audit --json > file.json')
  Use with --ci to fail pipelines when fixes introduce new critical/high issues.

  Exit codes (diff --ci):
    0  No regression (no new critical/high issues)
    1  Regression detected (new critical or high issues introduced)
`);
}

function printVersion(): void {
  console.log(`ao-lens v${SCHEMA_VERSION}`);
}

function prettyPrint(result: ParseResult): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`FILE: ${result.file}`);
  console.log(`${"=".repeat(60)}`);

  if (!result.success) {
    console.log(`\nERROR: ${result.error?.message}`);
    if (result.error?.line) {
      console.log(`  Line: ${result.error.line}, Column: ${result.error.column}`);
    }
    return;
  }

  console.log(`\nSTATS:`);
  console.log(`  Lines: ${result.stats.total_lines}`);
  console.log(`  Functions: ${result.stats.function_count}`);
  console.log(`  Globals: ${result.stats.global_count}`);
  console.log(`  Handlers: ${result.stats.handler_count}`);
  console.log(`  State writes: ${result.stats.state_write_count}`);
  console.log(`  ao.send calls: ${result.stats.ao_send_count}`);
  console.log(`  Determinism issues: ${result.stats.determinism_issue_count}`);
  console.log(`  Parse time: ${result.stats.parse_time_ms}ms`);

  if (result.handlers.length > 0) {
    console.log(`\nHANDLERS (${result.handlers.length}):`);
    for (const handler of result.handlers) {
      const action = handler.trigger.action_tag || "?";
      const strictness = handler.matcher_analysis.strictness.toUpperCase();
      const auth = handler.matcher_analysis.checks_authorization ? " +auth" : "";
      const schema = handler.matcher_analysis.validates_schema ? " +schema" : "";
      console.log(`  "${handler.name}" (Action: ${action}) [${strictness}${auth}${schema}]`);
      console.log(`    Type: ${handler.signature_type}, Lines: ${handler.line}-${handler.end_line}`);
      if (handler.trigger.checks_frozen) {
        console.log(`    Checks: State.Frozen`);
      }
    }
  }

  if (result.functions.length > 0) {
    console.log(`\nFUNCTIONS (${result.functions.length}):`);
    for (const func of result.functions) {
      const locality = func.is_local ? "local " : "";
      const params = func.params.join(", ");
      console.log(`  ${locality}${func.name}(${params})  [line ${func.line}-${func.end_line}]`);
    }
  }

  if (result.globals.length > 0) {
    console.log(`\nGLOBALS (${result.globals.length}):`);
    for (const global of result.globals) {
      const value = global.initial_value ? ` = ${global.initial_value}` : "";
      console.log(`  ${global.name}: ${global.value_type}${value}  [line ${global.line}]`);
    }
  }

  // Sprint 3: State analysis display
  if (result.state_analysis.state_mutations.length > 0) {
    console.log(`\nSTATE MUTATIONS (${result.state_analysis.state_mutations.length}):`);
    for (const mutation of result.state_analysis.state_mutations) {
      console.log(`  ${mutation.field}  [line ${mutation.line}]`);
    }
  }

  if (result.state_analysis.ao_sends.length > 0) {
    console.log(`\nAO.SEND CALLS (${result.state_analysis.ao_sends.length}):`);
    for (const send of result.state_analysis.ao_sends) {
      const action = send.action || "?";
      const targetType = send.target_type === "dynamic" ? " (dynamic)" : "";
      console.log(`  Target: ${send.target}${targetType}, Action: ${action}  [line ${send.line}]`);
    }
  }

  if (result.state_analysis.determinism_issues.length > 0) {
    console.log(`\nDETERMINISM ISSUES (${result.state_analysis.determinism_issues.length}):`);
    for (const issue of result.state_analysis.determinism_issues) {
      console.log(`  [${issue.type.toUpperCase()}] ${issue.code}  [line ${issue.line}]`);
      console.log(`    Suggestion: ${issue.suggestion}`);
    }
  }
}

function collectLuaFiles(inputPath: string): string[] {
  const stat = fs.statSync(inputPath);

  if (stat.isFile()) {
    if (inputPath.endsWith(".lua")) {
      return [inputPath];
    }
    console.error(`Warning: ${inputPath} is not a .lua file, skipping`);
    return [];
  }

  if (stat.isDirectory()) {
    const files: string[] = [];
    const entries = fs.readdirSync(inputPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(inputPath, entry.name);
      if (entry.isFile() && entry.name.endsWith(".lua")) {
        files.push(fullPath);
      } else if (entry.isDirectory()) {
        files.push(...collectLuaFiles(fullPath));
      }
    }
    return files;
  }

  return [];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    printVersion();
    process.exit(0);
  }

  // Handle rules command first - doesn't require input files
  if (args.command === "rules") {
    if (!args.skillsDir) {
      console.error("Error: --skills-dir is required for rules command");
      console.error("Usage: ao-lens rules --skills-dir <path>");
      process.exit(1);
    }

    const ruleLoader = new RuleLoader();
    const count = await ruleLoader.loadFromSkillsDirectory(args.skillsDir);

    if (count === 0) {
      console.log("No detection rules found in skills directory.");
      console.log("Ensure skills have structured anti_patterns with detection rules.");
    } else {
      ruleLoader.printSummary();
    }
    process.exit(0);
  }

  // Handle diff command - compares two audit result JSON files
  if (args.command === "diff") {
    if (args.files.length !== 2) {
      console.error("Error: diff command requires exactly 2 files");
      console.error("Usage: ao-lens diff <baseline.json> <current.json>");
      process.exit(1);
    }

    const [baselinePath, currentPath] = args.files;

    if (!fs.existsSync(baselinePath)) {
      console.error(`Error: Baseline file not found: ${baselinePath}`);
      process.exit(2);
    }
    if (!fs.existsSync(currentPath)) {
      console.error(`Error: Current file not found: ${currentPath}`);
      process.exit(2);
    }

    try {
      const baselineJson = fs.readFileSync(baselinePath, "utf-8");
      const currentJson = fs.readFileSync(currentPath, "utf-8");

      const baseline: AuditResult = JSON.parse(baselineJson);
      const current: AuditResult = JSON.parse(currentJson);

      // Validate that these look like audit results
      if (!baseline.files || !baseline.summary) {
        console.error("Error: Baseline file is not a valid ao-lens audit result");
        process.exit(2);
      }
      if (!current.files || !current.summary) {
        console.error("Error: Current file is not a valid ao-lens audit result");
        process.exit(2);
      }

      const diff = diffAuditResults(baseline, current);

      if (args.format === "pretty") {
        console.log(formatDiffPretty(diff));
      } else {
        console.log(JSON.stringify({
          schema_version: SCHEMA_VERSION,
          timestamp: new Date().toISOString(),
          baseline_file: baselinePath,
          current_file: currentPath,
          ...diff,
        }, null, 2));
      }

      // CI mode: exit 1 if regression detected
      if (args.ci && diff.regression_detected) {
        process.exit(1);
      }
      process.exit(0);
    } catch (error) {
      console.error(`Error parsing audit files: ${(error as Error).message}`);
      process.exit(2);
    }
  }

  if (args.files.length === 0) {
    console.error("Error: No input files specified");
    console.error(`Usage: ao-lens ${args.command} <file.lua>`);
    process.exit(1);
  }

  const parser = new LuaParser();
  const results: ParseResult[] = [];

  for (const inputPath of args.files) {
    if (!fs.existsSync(inputPath)) {
      console.error(`Error: File not found: ${inputPath}`);
      process.exit(1);
    }

    const luaFiles = collectLuaFiles(inputPath);

    for (const luaFile of luaFiles) {
      const sourceCode = fs.readFileSync(luaFile, "utf-8");
      const result = parser.parse(sourceCode, luaFile);
      results.push(result);
    }
  }

  // Handle graph command
  if (args.command === "graph") {
    const ipcAnalyzer = new IPCAnalyzer();
    const graph = ipcAnalyzer.buildGraph(results);
    const summary = ipcAnalyzer.generateSummary(graph);

    if (args.format === "mermaid") {
      console.log(ipcAnalyzer.generateMermaid(graph));
    } else if (args.format === "pretty") {
      printGraphPretty(graph, summary);
    } else {
      console.log(JSON.stringify({
        schema_version: SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        processes: graph.processes,
        message_flows: graph.message_flows,
        spawn_relationships: graph.spawn_relationships,
        summary,
        mermaid: ipcAnalyzer.generateMermaid(graph),
      }, null, 2));
    }
    process.exit(0);
  }

  // Handle audit command
  if (args.command === "audit") {
    // Load dynamic rules - use specified dir or auto-detect from first file
    let ruleLoader: RuleLoader | undefined;
    let skillsDir = args.skillsDir;

    // Auto-detect skills directory if not specified
    if (!skillsDir && args.files.length > 0) {
      skillsDir = findSkillsDir(args.files[0]);
      if (skillsDir && args.format === "pretty") {
        console.log(`Auto-detected skills directory: ${skillsDir}`);
      }
    }

    if (skillsDir) {
      ruleLoader = new RuleLoader();
      const ruleCount = await ruleLoader.loadFromSkillsDirectory(skillsDir);
      if (args.format === "pretty") {
        console.log(`Loaded ${ruleCount} dynamic detection rules`);
      }
    }

    const securityAnalyzer = new SecurityAnalyzer(ruleLoader);
    const auditResult = securityAnalyzer.analyzeMultiple(results, {
      filterToHandlers: args.handlers || undefined,
    });

    if (args.format === "pretty") {
      printAuditPretty(auditResult, ruleLoader);
    } else {
      console.log(JSON.stringify({
        schema_version: SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        skills_dir: skillsDir || null,
        skills_auto_detected: !args.skillsDir && skillsDir !== null,
        dynamic_rules_loaded: ruleLoader?.getRuleCount() || 0,
        handlers_filter: args.handlers || null,
        ...auditResult,
      }, null, 2));
    }

    // CI mode: exit 1 if critical/high issues found
    if (args.ci && !auditResult.pass) {
      process.exit(1);
    }
    process.exit(0);
  }

  // Handle parse command (default)
  if (args.format === "pretty") {
    for (const result of results) {
      prettyPrint(result);
    }
  } else {
    // JSON output - single result or array
    if (results.length === 1) {
      console.log(JSON.stringify(results[0], null, 2));
    } else {
      console.log(JSON.stringify({
        schema_version: SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        files: results,
        summary: {
          total_files: results.length,
          successful: results.filter(r => r.success).length,
          failed: results.filter(r => !r.success).length,
          total_functions: results.reduce((sum, r) => sum + r.functions.length, 0),
          total_globals: results.reduce((sum, r) => sum + r.globals.length, 0),
        }
      }, null, 2));
    }
  }

  // Exit with error if any parse failed
  const hasErrors = results.some(r => !r.success);
  process.exit(hasErrors ? 1 : 0);
}

function printGraphPretty(
  graph: { processes: any[]; message_flows: any[]; spawn_relationships: any[] },
  summary: any
): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`IPC TOPOLOGY GRAPH`);
  console.log(`${"=".repeat(60)}`);

  console.log(`\nSUMMARY:`);
  console.log(`  Processes: ${summary.process_count}`);
  console.log(`  Handlers: ${summary.handler_count}`);
  console.log(`  Message flows: ${summary.message_flow_count}`);
  console.log(`  Spawns: ${summary.spawn_count}`);

  if (summary.action_types.length > 0) {
    console.log(`\nACTION TYPES:`);
    for (const action of summary.action_types) {
      console.log(`  - ${action}`);
    }
  }

  if (graph.processes.length > 0) {
    console.log(`\nPROCESSES:`);
    for (const proc of graph.processes) {
      console.log(`  ${proc.name} (${proc.handlers.length} handlers)`);
      console.log(`    File: ${proc.file}`);
      if (proc.handlers.length > 0) {
        console.log(`    Handlers: ${proc.handlers.join(", ")}`);
      }
    }
  }

  if (graph.message_flows.length > 0) {
    console.log(`\nMESSAGE FLOWS:`);
    for (const flow of graph.message_flows) {
      console.log(`  ${flow.from} --[${flow.action}]--> ${flow.to}`);
    }
  }
}

function printAuditPretty(
  auditResult: {
    files: SecurityReport[];
    summary: SecurityReport["summary"];
    pass: boolean;
  },
  ruleLoader?: RuleLoader
): void {
  const severityColors: Record<string, string> = {
    critical: "\x1b[31m", // Red
    high: "\x1b[33m",     // Yellow
    medium: "\x1b[36m",   // Cyan
    low: "\x1b[37m",      // White
    info: "\x1b[90m",     // Gray
  };
  const reset = "\x1b[0m";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SECURITY AUDIT REPORT`);
  console.log(`${"=".repeat(60)}`);

  // Summary
  const passText = auditResult.pass
    ? `${"\x1b[32m"}PASS${reset}`
    : `${"\x1b[31m"}FAIL${reset}`;

  console.log(`\nRESULT: ${passText}`);

  // Dynamic rules info
  if (ruleLoader && ruleLoader.isLoaded()) {
    console.log(`\nDYNAMIC RULES: ${ruleLoader.getRuleCount()} loaded from skills`);
  }

  console.log(`\nSUMMARY:`);
  console.log(`  ${severityColors.critical}Critical: ${auditResult.summary.critical}${reset}`);
  console.log(`  ${severityColors.high}High: ${auditResult.summary.high}${reset}`);
  console.log(`  ${severityColors.medium}Medium: ${auditResult.summary.medium}${reset}`);
  console.log(`  ${severityColors.low}Low: ${auditResult.summary.low}${reset}`);
  console.log(`  ${severityColors.info}Info: ${auditResult.summary.info}${reset}`);
  console.log(`  Total: ${auditResult.summary.total}`);

  // Per-file findings
  for (const file of auditResult.files) {
    if (file.findings.length === 0) continue;

    console.log(`\n${"-".repeat(60)}`);
    console.log(`FILE: ${file.file}`);

    for (const finding of file.findings) {
      const color = severityColors[finding.severity] || "";
      const severity = finding.severity.toUpperCase().padEnd(8);
      const handler = finding.handler ? ` (${finding.handler})` : "";
      const line = finding.line ? ` [line ${finding.line}]` : "";

      console.log(`  ${color}[${severity}]${reset} ${finding.code}${handler}${line}`);
      console.log(`             ${finding.message}`);
      console.log(`             Suggestion: ${finding.suggestion}`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(2);
});
