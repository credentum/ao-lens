/**
 * Lua Parser using tree-sitter
 * Sprint 1: AST Foundation + Sprint 2: Handler Mapper + Sprint 3: State Tracking
 */

import Parser from "tree-sitter";
import Lua from "@tree-sitter-grammars/tree-sitter-lua";
import {
  ParseResult,
  FunctionDefinition,
  GlobalAssignment,
  FileStateAnalysis,
  SCHEMA_VERSION,
} from "../types";
import { HandlerAnalyzer } from "../analyzers/handler-analyzer";
import { StateAnalyzer } from "../analyzers/state-analyzer";

export class LuaParser {
  private parser: Parser;
  private handlerAnalyzer: HandlerAnalyzer;
  private stateAnalyzer: StateAnalyzer;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Lua);
    this.handlerAnalyzer = new HandlerAnalyzer();
    this.stateAnalyzer = new StateAnalyzer();
  }

  /**
   * Parse a Lua file and extract structure
   */
  parse(sourceCode: string, filePath: string): ParseResult {
    const startTime = Date.now();

    try {
      const tree = this.parser.parse(sourceCode);
      const rootNode = tree.rootNode;

      // Check for parse errors (hasError is a property in newer tree-sitter)
      if (rootNode.hasError) {
        const errorNode = this.findFirstError(rootNode);
        return this.createErrorResult(filePath, {
          message: "Syntax error in Lua file",
          line: errorNode?.startPosition.row,
          column: errorNode?.startPosition.column,
        }, startTime);
      }

      // Extract functions, globals, and handlers
      const functions = this.extractFunctions(rootNode, sourceCode);
      const globals = this.extractGlobals(rootNode, sourceCode);
      const handlers = this.handlerAnalyzer.findHandlers(rootNode);

      // Sprint 3: Analyze state access and side effects
      const fileAnalysis = this.stateAnalyzer.analyzeFile(rootNode);

      const parseTimeMs = Date.now() - startTime;
      const lines = sourceCode.split("\n");

      return {
        schema_version: SCHEMA_VERSION,
        timestamp: new Date().toISOString(),
        file: filePath,
        success: true,
        functions,
        globals,
        handlers,
        state_analysis: {
          state_mutations: fileAnalysis.global_state.filter(s => s.type === "write"),
          ao_sends: fileAnalysis.ao_sends,
          determinism_issues: fileAnalysis.determinism_issues,
        },
        sourceCode,
        stats: {
          total_lines: lines.length,
          function_count: functions.length,
          global_count: globals.length,
          handler_count: handlers.length,
          state_write_count: fileAnalysis.global_state.filter(s => s.type === "write").length,
          ao_send_count: fileAnalysis.ao_sends.length,
          determinism_issue_count: fileAnalysis.determinism_issues.length,
          parse_time_ms: parseTimeMs,
        },
      };
    } catch (error) {
      return this.createErrorResult(filePath, {
        message: error instanceof Error ? error.message : "Unknown parse error",
      }, startTime);
    }
  }

  /**
   * Extract all function definitions
   */
  private extractFunctions(rootNode: Parser.SyntaxNode, source: string): FunctionDefinition[] {
    const functions: FunctionDefinition[] = [];
    const seenLines = new Set<number>(); // Prevent duplicates

    // Query for function definitions
    // Handles: function name(), local function name(), name = function()
    this.walkTree(rootNode, (node) => {
      let func: FunctionDefinition | null = null;

      if (node.type === "function_declaration") {
        // Check for local keyword
        const hasLocal = this.hasChildOfType(node, "local");
        func = this.parseFunctionDeclaration(node, hasLocal);
      } else if (node.type === "variable_declaration") {
        // Check for: local name = function() - process before assignment_statement
        func = this.parseVariableDeclarationFunction(node);
      } else if (node.type === "assignment_statement") {
        // Check for: name = function()
        // Skip if parent is variable_declaration (already handled)
        if (node.parent?.type !== "variable_declaration") {
          func = this.parseAssignmentFunction(node);
        }
      }

      // Add if valid and not a duplicate
      if (func && !seenLines.has(func.line)) {
        functions.push(func);
        seenLines.add(func.line);
      }
    });

    return functions;
  }

  /**
   * Check if node has a child of specific type
   */
  private hasChildOfType(node: Parser.SyntaxNode, type: string): boolean {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i)?.type === type) return true;
    }
    return false;
  }

  /**
   * Parse function foo() or local function foo()
   */
  private parseFunctionDeclaration(node: Parser.SyntaxNode, isLocal: boolean): FunctionDefinition | null {
    // Find function name
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;

    // Get function name (could be simple or method: obj:method)
    const name = this.getNodeText(nameNode);

    // Find parameters
    const paramsNode = node.childForFieldName("parameters");
    const params = this.extractParameters(paramsNode);

    return {
      name,
      line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      params,
      is_local: isLocal,
    };
  }

  /**
   * Parse: name = function()
   */
  private parseAssignmentFunction(node: Parser.SyntaxNode): FunctionDefinition | null {
    // Assignment structure: variable_list, =, expression_list
    // Find variable_list and expression_list by type
    let variableList: Parser.SyntaxNode | null = null;
    let expressionList: Parser.SyntaxNode | null = null;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === "variable_list") variableList = child;
      if (child?.type === "expression_list") expressionList = child;
    }

    if (!variableList || !expressionList) return null;

    // Check if expression_list contains a function_definition (first child)
    const funcExpr = expressionList.firstChild;
    if (!funcExpr || funcExpr.type !== "function_definition") return null;

    // Get variable name (only simple identifier, not dot_index_expression)
    const varNode = variableList.firstChild;
    if (!varNode || varNode.type !== "identifier") return null;
    const name = this.getNodeText(varNode);

    // Get parameters
    const paramsNode = this.findChild(funcExpr, "parameters");
    const params = this.extractParameters(paramsNode);

    return {
      name,
      line: node.startPosition.row + 1,
      end_line: funcExpr.endPosition.row + 1,
      params,
      is_local: false,
    };
  }

  /**
   * Parse: local name = function() (variable_declaration node)
   */
  private parseVariableDeclarationFunction(node: Parser.SyntaxNode): FunctionDefinition | null {
    // variable_declaration contains an assignment_statement as child
    const assignment = this.findChild(node, "assignment_statement");
    if (!assignment) return null;

    const func = this.parseAssignmentFunction(assignment);
    if (func) {
      func.is_local = true;
    }
    return func;
  }

  /**
   * Extract parameter names from function parameters node
   */
  private extractParameters(paramsNode: Parser.SyntaxNode | null): string[] {
    if (!paramsNode) return [];

    const params: string[] = [];
    this.walkTree(paramsNode, (node) => {
      if (node.type === "identifier") {
        params.push(this.getNodeText(node));
      } else if (node.type === "vararg_expression") {
        params.push("...");
      }
    });

    return params;
  }

  /**
   * Extract global variable assignments
   */
  private extractGlobals(rootNode: Parser.SyntaxNode, source: string): GlobalAssignment[] {
    const globals: GlobalAssignment[] = [];
    const seenNames = new Set<string>();

    // Only look at top-level assignments (direct children of root)
    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i);
      if (!node) continue;

      if (node.type === "assignment_statement") {
        const global = this.parseGlobalAssignment(node);
        if (global && !seenNames.has(global.name)) {
          // Skip if it's a function (already captured)
          if (global.value_type !== "function") {
            globals.push(global);
            seenNames.add(global.name);
          }
        }
      }
    }

    return globals;
  }

  /**
   * Parse a global assignment statement
   */
  private parseGlobalAssignment(node: Parser.SyntaxNode): GlobalAssignment | null {
    // Find variable_list and expression_list by type
    let variableList: Parser.SyntaxNode | null = null;
    let expressionList: Parser.SyntaxNode | null = null;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === "variable_list") variableList = child;
      if (child?.type === "expression_list") expressionList = child;
    }

    if (!variableList || !expressionList) return null;

    // Get first variable (simple identifier only)
    const varNode = variableList.firstChild;
    if (!varNode || varNode.type !== "identifier") return null;

    const name = this.getNodeText(varNode);

    // Determine value type
    const valueNode = expressionList.firstChild;
    const valueType = this.inferValueType(valueNode);

    return {
      name,
      line: node.startPosition.row + 1,
      value_type: valueType,
      initial_value: valueNode ? this.getNodeText(valueNode).slice(0, 50) : undefined,
    };
  }

  /**
   * Infer the type of a value node
   */
  private inferValueType(node: Parser.SyntaxNode | null): GlobalAssignment["value_type"] {
    if (!node) return "nil";

    switch (node.type) {
      case "table_constructor":
        return "table";
      case "function_definition":
        return "function";
      case "string":
        return "string";
      case "number":
        return "number";
      case "true":
      case "false":
        return "boolean";
      case "nil":
        return "nil";
      default:
        return "unknown";
    }
  }

  /**
   * Find first error node in tree
   */
  private findFirstError(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (node.type === "ERROR") return node;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        const error = this.findFirstError(child);
        if (error) return error;
      }
    }
    return null;
  }

  /**
   * Find child node of specific type
   */
  private findChild(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === type) return child;
    }
    return null;
  }

  /**
   * Walk tree and call callback on each node
   */
  private walkTree(node: Parser.SyntaxNode, callback: (node: Parser.SyntaxNode) => void): void {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) this.walkTree(child, callback);
    }
  }

  /**
   * Get text content of a node
   */
  private getNodeText(node: Parser.SyntaxNode): string {
    return node.text;
  }

  /**
   * Extract source code by line range (1-indexed, inclusive)
   */
  extractSourceByLineRange(sourceCode: string, startLine: number, endLine: number): string {
    const lines = sourceCode.split("\n");
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    return lines.slice(start, end).join("\n");
  }

  /**
   * Find function calls within a specific line range
   */
  findFunctionCallsInRange(sourceCode: string, startLine: number, endLine: number): string[] {
    const tree = this.parser.parse(sourceCode);
    const calls: Set<string> = new Set();

    this.walkTree(tree.rootNode, (node) => {
      const line = node.startPosition.row + 1;
      if (line >= startLine && line <= endLine && node.type === "function_call") {
        // Get the function name being called
        const callExpr = node.firstChild;
        if (callExpr) {
          const callText = callExpr.text;
          // Skip ao.send, ao.spawn, json.decode, etc. - only get local function calls
          if (!callText.includes(".") && callText !== "assert" && callText !== "pcall" &&
              callText !== "tonumber" && callText !== "tostring" && callText !== "type" &&
              callText !== "pairs" && callText !== "ipairs" && callText !== "next" &&
              callText !== "print" && callText !== "error" && callText !== "require") {
            calls.add(callText);
          }
        }
      }
    });

    return Array.from(calls);
  }

  /**
   * Create error result
   */
  private createErrorResult(
    filePath: string,
    error: { message: string; line?: number; column?: number },
    startTime: number
  ): ParseResult {
    return {
      schema_version: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      file: filePath,
      success: false,
      error,
      functions: [],
      globals: [],
      handlers: [],
      state_analysis: {
        state_mutations: [],
        ao_sends: [],
        determinism_issues: [],
      },
      stats: {
        total_lines: 0,
        function_count: 0,
        global_count: 0,
        handler_count: 0,
        state_write_count: 0,
        ao_send_count: 0,
        determinism_issue_count: 0,
        parse_time_ms: Date.now() - startTime,
      },
    };
  }
}
