#!/usr/bin/env node
/**
 * ao-lens MCP Server
 * Exposes semantic analysis tools via Model Context Protocol
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import { LuaParser } from "./parser/lua-parser";
import { IPCAnalyzer } from "./analyzers/ipc-analyzer";
import { SecurityAnalyzerAdapter as SecurityAnalyzer } from "./analyzers/security";
import { ParseResult, SCHEMA_VERSION } from "./types";

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "analyze_file",
    description: "Parse a Lua file and extract handlers, functions, globals, state access, and determinism issues",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the Lua file to analyze",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "analyze_handler",
    description: "Get detailed analysis of a specific handler by name, including trigger conditions, matcher strictness, and state access",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the Lua file containing the handler",
        },
        handler_name: {
          type: "string",
          description: "Name of the handler to analyze",
        },
      },
      required: ["file_path", "handler_name"],
    },
  },
  {
    name: "map_architecture",
    description: "Generate IPC topology graph from multiple Lua files showing process communication patterns",
    inputSchema: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Directory containing Lua files to analyze",
        },
        output_format: {
          type: "string",
          enum: ["json", "mermaid", "summary"],
          description: "Output format (default: json)",
        },
      },
      required: ["directory"],
    },
  },
  {
    name: "find_state_mutations",
    description: "Find all State.* field mutations in a file or directory",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to file or directory to search",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "check_determinism",
    description: "Check for replay-safety violations (os.time, math.random, io operations)",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to file or directory to check",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_handlers",
    description: "List all handlers in a file with their Action tags and strictness levels",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the Lua file",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "security_audit",
    description: "Run security audit on Lua files and return severity-ranked findings",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to file or directory to audit",
        },
      },
      required: ["path"],
    },
  },
  // Sprint 7: Agent-Driven Semantic Exploration Tools
  {
    name: "get_function_details",
    description: "Get comprehensive details about a specific function by name, including parameters, line range, and body analysis",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the Lua file containing the function",
        },
        function_name: {
          type: "string",
          description: "Name of the function (exact match)",
        },
      },
      required: ["file_path", "function_name"],
    },
  },
  {
    name: "get_handler_body",
    description: "Get handler source code and detailed body analysis including auth patterns, state access, and local function calls",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the Lua file containing the handler",
        },
        handler_name: {
          type: "string",
          description: "Name of the handler",
        },
      },
      required: ["file_path", "handler_name"],
    },
  },
  {
    name: "find_state_usage",
    description: "Find all reads and writes to a specific state field across files, with handler context",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File or directory to search",
        },
        state_field: {
          type: "string",
          description: "State field to find (e.g., 'State.Params.Kp' or 'Params')",
        },
      },
      required: ["path", "state_field"],
    },
  },
  {
    name: "query_handlers",
    description: "Query handlers with semantic filters: action pattern, auth presence, frozen check, state mutation, strictness",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File or directory to search",
        },
        filters: {
          type: "object",
          description: "Semantic filters to apply",
          properties: {
            action_pattern: {
              type: "string",
              description: "Regex pattern for action tag (e.g., 'Set.*' or 'Update')",
            },
            name_pattern: {
              type: "string",
              description: "Regex pattern for handler name",
            },
            has_auth: {
              type: "boolean",
              description: "Filter by authorization check presence",
            },
            has_frozen_check: {
              type: "boolean",
              description: "Filter by frozen check presence",
            },
            mutates_state: {
              type: "boolean",
              description: "Filter by state mutation",
            },
            strictness: {
              type: "string",
              enum: ["loose", "moderate", "strict"],
              description: "Filter by matcher strictness",
            },
          },
        },
      },
      required: ["path"],
    },
  },
];

class AoLensMcpServer {
  private server: Server;
  private parser: LuaParser;
  private ipcAnalyzer: IPCAnalyzer;
  private securityAnalyzer: SecurityAnalyzer;
  private cache: Map<string, { result: ParseResult; mtime: number }>;

  constructor() {
    this.server = new Server(
      {
        name: "ao-lens",
        version: SCHEMA_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.parser = new LuaParser();
    this.ipcAnalyzer = new IPCAnalyzer();
    this.securityAnalyzer = new SecurityAnalyzer();
    this.cache = new Map();

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "analyze_file":
            return this.analyzeFile(args as { file_path: string });

          case "analyze_handler":
            return this.analyzeHandler(args as { file_path: string; handler_name: string });

          case "map_architecture":
            return this.mapArchitecture(args as { directory: string; output_format?: string });

          case "find_state_mutations":
            return this.findStateMutations(args as { path: string });

          case "check_determinism":
            return this.checkDeterminism(args as { path: string });

          case "list_handlers":
            return this.listHandlers(args as { file_path: string });

          case "security_audit":
            return this.securityAudit(args as { path: string });

          // Sprint 7: Agent-Driven Semantic Exploration
          case "get_function_details":
            return this.getFunctionDetails(args as { file_path: string; function_name: string });

          case "get_handler_body":
            return this.getHandlerBody(args as { file_path: string; handler_name: string });

          case "find_state_usage":
            return this.findStateUsage(args as { path: string; state_field: string });

          case "query_handlers":
            return this.queryHandlers(args as { path: string; filters?: Record<string, unknown> });

          default:
            return {
              content: [{ type: "text", text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private parseFile(filePath: string): ParseResult {
    // Check cache
    const stat = fs.statSync(filePath);
    const cached = this.cache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.result;
    }

    // Parse and cache
    const sourceCode = fs.readFileSync(filePath, "utf-8");
    const result = this.parser.parse(sourceCode, filePath);
    this.cache.set(filePath, { result, mtime: stat.mtimeMs });
    return result;
  }

  private collectLuaFiles(inputPath: string): string[] {
    const stat = fs.statSync(inputPath);

    if (stat.isFile()) {
      return inputPath.endsWith(".lua") ? [inputPath] : [];
    }

    if (stat.isDirectory()) {
      const files: string[] = [];
      const entries = fs.readdirSync(inputPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(inputPath, entry.name);
        if (entry.isFile() && entry.name.endsWith(".lua")) {
          files.push(fullPath);
        } else if (entry.isDirectory()) {
          files.push(...this.collectLuaFiles(fullPath));
        }
      }
      return files;
    }

    return [];
  }

  private analyzeFile(args: { file_path: string }) {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: "text", text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const result = this.parseFile(args.file_path);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }

  private analyzeHandler(args: { file_path: string; handler_name: string }) {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: "text", text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const result = this.parseFile(args.file_path);
    const handler = result.handlers.find((h) => h.name === args.handler_name);

    if (!handler) {
      return {
        content: [
          {
            type: "text",
            text: `Handler "${args.handler_name}" not found. Available handlers: ${result.handlers.map((h) => h.name).join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    // Build detailed handler analysis
    const analysis = {
      handler_name: handler.name,
      line_range: `${handler.line}-${handler.end_line}`,
      signature_type: handler.signature_type,
      trigger: handler.trigger,
      matcher_analysis: handler.matcher_analysis,
      security_summary: {
        checks_authorization: handler.matcher_analysis.checks_authorization,
        validates_schema: handler.matcher_analysis.validates_schema,
        checks_frozen: handler.trigger.checks_frozen,
        strictness: handler.matcher_analysis.strictness,
      },
      // Find state access within handler's line range
      state_access: {
        mutations: result.state_analysis.state_mutations.filter(
          (m) => m.line >= handler.line && m.line <= handler.end_line
        ),
        ao_sends: result.state_analysis.ao_sends.filter(
          (s) => s.line >= handler.line && s.line <= handler.end_line
        ),
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }],
    };
  }

  private mapArchitecture(args: { directory: string; output_format?: string }) {
    if (!fs.existsSync(args.directory)) {
      return {
        content: [{ type: "text", text: `Directory not found: ${args.directory}` }],
        isError: true,
      };
    }

    const luaFiles = this.collectLuaFiles(args.directory);
    if (luaFiles.length === 0) {
      return {
        content: [{ type: "text", text: `No Lua files found in: ${args.directory}` }],
        isError: true,
      };
    }

    const results = luaFiles.map((f) => this.parseFile(f));
    const graph = this.ipcAnalyzer.buildGraph(results);
    const summary = this.ipcAnalyzer.generateSummary(graph);

    const format = args.output_format || "json";

    if (format === "mermaid") {
      return {
        content: [{ type: "text", text: this.ipcAnalyzer.generateMermaid(graph) }],
      };
    }

    if (format === "summary") {
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    }

    // Full JSON
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              processes: graph.processes,
              message_flows: graph.message_flows,
              spawn_relationships: graph.spawn_relationships,
              summary,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private findStateMutations(args: { path: string }) {
    if (!fs.existsSync(args.path)) {
      return {
        content: [{ type: "text", text: `Path not found: ${args.path}` }],
        isError: true,
      };
    }

    const luaFiles = this.collectLuaFiles(args.path);
    const allMutations: Array<{
      file: string;
      field: string;
      line: number;
    }> = [];

    for (const file of luaFiles) {
      const result = this.parseFile(file);
      for (const mutation of result.state_analysis.state_mutations) {
        allMutations.push({
          file,
          field: mutation.field,
          line: mutation.line,
        });
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total_mutations: allMutations.length,
              mutations: allMutations,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private checkDeterminism(args: { path: string }) {
    if (!fs.existsSync(args.path)) {
      return {
        content: [{ type: "text", text: `Path not found: ${args.path}` }],
        isError: true,
      };
    }

    const luaFiles = this.collectLuaFiles(args.path);
    const allIssues: Array<{
      file: string;
      type: string;
      line: number;
      code: string;
      suggestion: string;
    }> = [];

    for (const file of luaFiles) {
      const result = this.parseFile(file);
      for (const issue of result.state_analysis.determinism_issues) {
        allIssues.push({
          file,
          type: issue.type,
          line: issue.line,
          code: issue.code,
          suggestion: issue.suggestion,
        });
      }
    }

    const isReplaySafe = allIssues.length === 0;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              is_replay_safe: isReplaySafe,
              issue_count: allIssues.length,
              issues: allIssues,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private listHandlers(args: { file_path: string }) {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: "text", text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const result = this.parseFile(args.file_path);

    const handlers = result.handlers.map((h) => ({
      name: h.name,
      action: h.trigger.action_tag,
      strictness: h.matcher_analysis.strictness,
      signature_type: h.signature_type,
      checks_auth: h.matcher_analysis.checks_authorization,
      validates_schema: h.matcher_analysis.validates_schema,
      checks_frozen: h.trigger.checks_frozen,
      lines: `${h.line}-${h.end_line}`,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              file: args.file_path,
              handler_count: handlers.length,
              handlers,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private securityAudit(args: { path: string }) {
    if (!fs.existsSync(args.path)) {
      return {
        content: [{ type: "text", text: `Path not found: ${args.path}` }],
        isError: true,
      };
    }

    const luaFiles = this.collectLuaFiles(args.path);
    const results = luaFiles.map((f) => this.parseFile(f));
    const auditResult = this.securityAnalyzer.analyzeMultiple(results);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pass: auditResult.pass,
              summary: auditResult.summary,
              files: auditResult.files.map((f) => ({
                file: f.file,
                finding_count: f.findings.length,
                findings: f.findings,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Sprint 7: Agent-Driven Semantic Exploration Tools

  private getFunctionDetails(args: { file_path: string; function_name: string }) {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: "text", text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const result = this.parseFile(args.file_path);
    const func = result.functions.find((f) => f.name === args.function_name);

    if (!func) {
      return {
        content: [
          {
            type: "text",
            text: `Function "${args.function_name}" not found. Available functions: ${result.functions.map((f) => f.name).join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    // Extract source snippet
    const sourceCode = result.sourceCode || fs.readFileSync(args.file_path, "utf-8");
    const sourceSnippet = this.parser.extractSourceByLineRange(sourceCode, func.line, func.end_line);

    // Find function calls within the function body
    const localCalls = this.parser.findFunctionCallsInRange(sourceCode, func.line, func.end_line);

    // Analyze state access within function
    const stateReads = result.state_analysis.state_mutations.filter(
      (s) => s.line >= func.line && s.line <= func.end_line && s.type === "read"
    );
    const stateWrites = result.state_analysis.state_mutations.filter(
      (s) => s.line >= func.line && s.line <= func.end_line
    );
    const aoSends = result.state_analysis.ao_sends.filter(
      (s) => s.line >= func.line && s.line <= func.end_line
    );

    const details = {
      name: func.name,
      line: func.line,
      end_line: func.end_line,
      params: func.params,
      is_local: func.is_local,
      source_snippet: sourceSnippet,
      body_analysis: {
        calls: localCalls,
        reads_state: stateReads.length > 0,
        writes_state: stateWrites.length > 0,
        ao_sends: aoSends.map((s) => s.action || s.target),
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    };
  }

  private getHandlerBody(args: { file_path: string; handler_name: string }) {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: "text", text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const result = this.parseFile(args.file_path);
    const handler = result.handlers.find((h) => h.name === args.handler_name);

    if (!handler) {
      return {
        content: [
          {
            type: "text",
            text: `Handler "${args.handler_name}" not found. Available handlers: ${result.handlers.map((h) => h.name).join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    const sourceCode = result.sourceCode || fs.readFileSync(args.file_path, "utf-8");
    const fullSource = this.parser.extractSourceByLineRange(sourceCode, handler.line, handler.end_line);

    // Find local function calls within handler
    const localCalls = this.parser.findFunctionCallsInRange(sourceCode, handler.line, handler.end_line);

    // Filter to only calls that match defined functions in the file
    const definedFunctions = new Set(result.functions.map((f) => f.name));
    const localFunctionsCalled = localCalls.filter((call) => definedFunctions.has(call));

    // Get state access within handler
    const stateReads = result.state_analysis.state_mutations
      .filter((s) => s.line >= handler.line && s.line <= handler.end_line && s.type === "read")
      .map((s) => s.field);
    const stateWrites = result.state_analysis.state_mutations
      .filter((s) => s.line >= handler.line && s.line <= handler.end_line)
      .map((s) => s.field);
    const aoSends = result.state_analysis.ao_sends
      .filter((s) => s.line >= handler.line && s.line <= handler.end_line)
      .map((s) => ({ target: s.target, action: s.action }));

    // Check for auth pattern and JSON parsing in the source
    const hasAssertAuth = fullSource.includes("assert") &&
      (fullSource.includes("msg.From") || fullSource.includes("State.Owner"));
    const hasConditionalAuth = fullSource.includes("if") &&
      fullSource.includes("msg.From") && fullSource.includes("State.Owner");
    const authPattern = hasAssertAuth ? "assert" : hasConditionalAuth ? "conditional" : "none";

    const parsesJson = fullSource.includes("json.decode");
    const jsonIsPcalled = fullSource.includes("pcall") && parsesJson;

    const bodyResult = {
      handler_name: handler.name,
      line: handler.line,
      end_line: handler.end_line,
      matcher_source: fullSource.split("\n").slice(0, 10).join("\n") + (fullSource.split("\n").length > 10 ? "\n..." : ""),
      body_source: fullSource,
      body_analysis: {
        validates_auth: hasAssertAuth || hasConditionalAuth,
        auth_pattern: authPattern,
        checks_frozen: handler.trigger.checks_frozen,
        parses_json: parsesJson,
        json_is_pcalled: jsonIsPcalled,
        state_reads: [...new Set(stateReads)],
        state_writes: [...new Set(stateWrites)],
        ao_sends: aoSends,
        local_functions_called: localFunctionsCalled,
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(bodyResult, null, 2) }],
    };
  }

  private findStateUsage(args: { path: string; state_field: string }) {
    if (!fs.existsSync(args.path)) {
      return {
        content: [{ type: "text", text: `Path not found: ${args.path}` }],
        isError: true,
      };
    }

    const luaFiles = this.collectLuaFiles(args.path);
    const reads: Array<{ file: string; line: number; handler: string | null; code_snippet: string }> = [];
    const writes: Array<{ file: string; line: number; handler: string | null; code_snippet: string }> = [];
    const handlersReading = new Set<string>();
    const handlersWriting = new Set<string>();

    for (const file of luaFiles) {
      const result = this.parseFile(file);
      const sourceCode = result.sourceCode || fs.readFileSync(file, "utf-8");
      const lines = sourceCode.split("\n");

      // Find all state accesses matching the field pattern
      for (const mutation of result.state_analysis.state_mutations) {
        // Match if field contains the search pattern
        if (!mutation.field.includes(args.state_field) && !args.state_field.includes(mutation.field)) {
          continue;
        }

        // Find which handler this belongs to
        let handlerName: string | null = null;
        for (const handler of result.handlers) {
          if (mutation.line >= handler.line && mutation.line <= handler.end_line) {
            handlerName = handler.name;
            break;
          }
        }

        const entry = {
          file,
          line: mutation.line,
          handler: handlerName,
          code_snippet: lines[mutation.line - 1]?.trim() || "",
        };

        if (mutation.type === "read") {
          reads.push(entry);
          if (handlerName) handlersReading.add(handlerName);
        } else {
          writes.push(entry);
          if (handlerName) handlersWriting.add(handlerName);
        }
      }
    }

    const usageResult = {
      state_field: args.state_field,
      reads,
      writes,
      summary: {
        total_reads: reads.length,
        total_writes: writes.length,
        handlers_reading: Array.from(handlersReading),
        handlers_writing: Array.from(handlersWriting),
      },
    };

    return {
      content: [{ type: "text", text: JSON.stringify(usageResult, null, 2) }],
    };
  }

  private queryHandlers(args: { path: string; filters?: Record<string, unknown> }) {
    if (!fs.existsSync(args.path)) {
      return {
        content: [{ type: "text", text: `Path not found: ${args.path}` }],
        isError: true,
      };
    }

    const filters = args.filters || {};
    const luaFiles = this.collectLuaFiles(args.path);
    const matchingHandlers: Array<{
      file: string;
      name: string;
      line: number;
      action: string | null;
      strictness: string;
      has_auth: boolean;
      has_frozen_check: boolean;
      mutates_state: boolean;
    }> = [];

    for (const file of luaFiles) {
      const result = this.parseFile(file);

      for (const handler of result.handlers) {
        // Check if handler has state mutations
        const mutatesState = result.state_analysis.state_mutations.some(
          (m) => m.line >= handler.line && m.line <= handler.end_line
        );

        // Apply filters
        if (filters.action_pattern !== undefined) {
          const pattern = new RegExp(filters.action_pattern as string);
          if (!handler.trigger.action_tag || !pattern.test(handler.trigger.action_tag)) {
            continue;
          }
        }

        if (filters.name_pattern !== undefined) {
          const pattern = new RegExp(filters.name_pattern as string);
          if (!pattern.test(handler.name)) {
            continue;
          }
        }

        if (filters.has_auth !== undefined) {
          if (handler.matcher_analysis.checks_authorization !== filters.has_auth) {
            continue;
          }
        }

        if (filters.has_frozen_check !== undefined) {
          if (handler.trigger.checks_frozen !== filters.has_frozen_check) {
            continue;
          }
        }

        if (filters.mutates_state !== undefined) {
          if (mutatesState !== filters.mutates_state) {
            continue;
          }
        }

        if (filters.strictness !== undefined) {
          if (handler.matcher_analysis.strictness !== filters.strictness) {
            continue;
          }
        }

        matchingHandlers.push({
          file,
          name: handler.name,
          line: handler.line,
          action: handler.trigger.action_tag,
          strictness: handler.matcher_analysis.strictness,
          has_auth: handler.matcher_analysis.checks_authorization,
          has_frozen_check: handler.trigger.checks_frozen,
          mutates_state: mutatesState,
        });
      }
    }

    const queryResult = {
      filters,
      handlers: matchingHandlers,
      total: matchingHandlers.length,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(queryResult, null, 2) }],
    };
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("ao-lens MCP server running on stdio");
  }
}

// Start server
const server = new AoLensMcpServer();
server.run().catch(console.error);
