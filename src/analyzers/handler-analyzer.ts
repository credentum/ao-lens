/**
 * Handler Analyzer
 * Detects and analyzes AO Handlers.add() patterns
 */

import Parser from "tree-sitter";

export interface HandlerTrigger {
  action_tag: string | null;
  required_tags: Record<string, string>;
  checks_from: boolean;
  checks_data: boolean;
  checks_frozen: boolean;
}

export interface MatcherAnalysis {
  type: "inline_function" | "hasMatchingTag" | "always_true" | "complex";
  strictness: "loose" | "moderate" | "strict";
  validates_schema: boolean;
  checks_authorization: boolean;
}

export interface SafeLibraryOptions {
  owner: boolean;    // Default: true for Safe.handler, false for Safe.query
  frozen: boolean;   // Default: true for Safe.handler, false for Safe.query
  public: boolean;   // Shorthand for owner=false, frozen=false
}

export interface HandlerInfo {
  name: string;
  line: number;
  end_line: number;
  signature_type: "function_matcher" | "hasMatchingTag" | "table" | "safe_handler" | "safe_query";
  trigger: HandlerTrigger;
  matcher_analysis: MatcherAnalysis;
  has_handler_body: boolean;
  // Safe library support
  is_safe_library: boolean;
  safe_options?: SafeLibraryOptions;
}

export class HandlerAnalyzer {
  /**
   * Find all Handlers.add() and Safe.handler()/Safe.query() calls in the AST
   */
  findHandlers(rootNode: Parser.SyntaxNode): HandlerInfo[] {
    const handlers: HandlerInfo[] = [];

    this.walkTree(rootNode, (node) => {
      if (node.type === "function_call") {
        // Try Handlers.add() first
        const handler = this.parseHandlerAdd(node);
        if (handler) {
          handlers.push(handler);
          return;
        }
        // Try Safe.handler() or Safe.query()
        const safeHandler = this.parseSafeHandler(node);
        if (safeHandler) {
          handlers.push(safeHandler);
        }
      }
    });

    return handlers;
  }

  /**
   * Parse Safe.handler() or Safe.query() calls
   * Safe library handlers have built-in security checks
   */
  private parseSafeHandler(node: Parser.SyntaxNode): HandlerInfo | null {
    const callExpr = this.findChild(node, "dot_index_expression");
    if (!callExpr) return null;

    const callText = callExpr.text;
    const isSafeHandler = callText === "Safe.handler";
    const isSafeQuery = callText === "Safe.query";

    if (!isSafeHandler && !isSafeQuery) return null;

    // Get arguments
    const argsNode = this.findChild(node, "arguments");
    if (!argsNode) return null;

    // Extract arguments
    const args: Parser.SyntaxNode[] = [];
    for (let i = 0; i < argsNode.childCount; i++) {
      const child = argsNode.child(i);
      if (
        child &&
        child.type !== "(" &&
        child.type !== ")" &&
        child.type !== "," &&
        child.type !== "comment"
      ) {
        args.push(child);
      }
    }

    // Safe.handler("Name", {options}, function) - needs at least name
    // Safe.query("Name", function) - needs at least name
    if (args.length < 1) return null;

    // First arg is handler name (string)
    const nameArg = args[0];
    if (nameArg.type !== "string") return null;

    const name = this.extractStringContent(nameArg);
    if (!name) return null;

    // Parse options for Safe.handler (second arg is table)
    let safeOptions: SafeLibraryOptions;
    if (isSafeHandler) {
      // Safe.handler defaults: owner=true, frozen=true
      safeOptions = { owner: true, frozen: true, public: false };

      // Check if second arg is options table
      if (args.length >= 2 && args[1].type === "table_constructor") {
        const optionsText = args[1].text;
        // Parse owner option
        if (/owner\s*=\s*false/.test(optionsText)) {
          safeOptions.owner = false;
        }
        // Parse frozen option
        if (/frozen\s*=\s*false/.test(optionsText)) {
          safeOptions.frozen = false;
        }
        // Parse public shorthand
        if (/public\s*=\s*true/.test(optionsText)) {
          safeOptions.public = true;
          safeOptions.owner = false;
          safeOptions.frozen = false;
        }
      }
    } else {
      // Safe.query defaults: owner=false, frozen=false (public)
      safeOptions = { owner: false, frozen: false, public: true };
    }

    // Build trigger - Safe library handles checks internally
    const trigger: HandlerTrigger = {
      action_tag: name,
      required_tags: {},
      checks_from: safeOptions.owner,  // Safe.handler checks From if owner=true
      checks_data: true,               // Safe library always parses data
      checks_frozen: safeOptions.frozen,
    };

    // Build matcher analysis - Safe library is always strict
    const matcherAnalysis: MatcherAnalysis = {
      type: "complex",  // Safe library uses internal matching
      strictness: "strict",
      validates_schema: true,  // Safe library validates JSON
      checks_authorization: safeOptions.owner,
    };

    return {
      name,
      line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      signature_type: isSafeHandler ? "safe_handler" : "safe_query",
      trigger,
      matcher_analysis: matcherAnalysis,
      has_handler_body: true,
      is_safe_library: true,
      safe_options: safeOptions,
    };
  }

  /**
   * Parse a Handlers.add() call
   */
  private parseHandlerAdd(node: Parser.SyntaxNode): HandlerInfo | null {
    // Check if this is Handlers.add()
    const callExpr = this.findChild(node, "dot_index_expression");
    if (!callExpr) return null;

    const callText = callExpr.text;
    if (callText !== "Handlers.add") return null;

    // Get arguments
    const argsNode = this.findChild(node, "arguments");
    if (!argsNode) return null;

    // Extract arguments (skip parentheses, commas, and comments)
    const args: Parser.SyntaxNode[] = [];
    for (let i = 0; i < argsNode.childCount; i++) {
      const child = argsNode.child(i);
      if (
        child &&
        child.type !== "(" &&
        child.type !== ")" &&
        child.type !== "," &&
        child.type !== "comment"
      ) {
        args.push(child);
      }
    }

    if (args.length < 2) return null;

    // First arg is handler name (string)
    const nameArg = args[0];
    if (nameArg.type !== "string") return null;

    const name = this.extractStringContent(nameArg);
    if (!name) return null;

    // Determine signature type based on second argument
    const matcherArg = args[1];
    const handlerArg = args.length > 2 ? args[2] : null;

    let signatureType: HandlerInfo["signature_type"];
    let matcherAnalysis: MatcherAnalysis;
    let trigger: HandlerTrigger;

    if (matcherArg.type === "function_call") {
      // Pattern 2: hasMatchingTag
      signatureType = "hasMatchingTag";
      const { analysis, trig } = this.analyzeHasMatchingTag(matcherArg);
      matcherAnalysis = analysis;
      trigger = trig;
    } else if (matcherArg.type === "function_definition") {
      // Pattern 1: inline matcher function
      signatureType = "function_matcher";
      const { analysis, trig } = this.analyzeInlineMatcher(matcherArg);
      matcherAnalysis = analysis;
      trigger = trig;
    } else if (matcherArg.type === "table_constructor") {
      // Pattern 3: table syntax (rare)
      signatureType = "table";
      matcherAnalysis = {
        type: "complex",
        strictness: "moderate",
        validates_schema: false,
        checks_authorization: false,
      };
      trigger = this.emptyTrigger();
    } else {
      return null;
    }

    return {
      name,
      line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      signature_type: signatureType,
      trigger,
      matcher_analysis: matcherAnalysis,
      has_handler_body: handlerArg !== null && handlerArg.type === "function_definition",
      is_safe_library: false,
    };
  }

  /**
   * Analyze Handlers.utils.hasMatchingTag() call
   */
  private analyzeHasMatchingTag(node: Parser.SyntaxNode): { analysis: MatcherAnalysis; trig: HandlerTrigger } {
    const trigger = this.emptyTrigger();

    // Extract tag key and value from hasMatchingTag arguments
    const argsNode = this.findChild(node, "arguments");
    if (argsNode) {
      const args: Parser.SyntaxNode[] = [];
      for (let i = 0; i < argsNode.childCount; i++) {
        const child = argsNode.child(i);
        if (child && child.type === "string") {
          args.push(child);
        }
      }

      if (args.length >= 2) {
        const tagKey = this.extractStringContent(args[0]);
        const tagValue = this.extractStringContent(args[1]);

        if (tagKey && tagValue) {
          trigger.required_tags[tagKey] = tagValue;
          if (tagKey === "Action") {
            trigger.action_tag = tagValue;
          }
        }
      }
    }

    // hasMatchingTag alone is "loose" - only checks one tag
    const analysis: MatcherAnalysis = {
      type: "hasMatchingTag",
      strictness: "loose",
      validates_schema: false,
      checks_authorization: false,
    };

    return { analysis, trig: trigger };
  }

  /**
   * Analyze inline matcher function
   */
  private analyzeInlineMatcher(node: Parser.SyntaxNode): { analysis: MatcherAnalysis; trig: HandlerTrigger } {
    const trigger = this.emptyTrigger();
    const funcBody = this.findChild(node, "block");

    if (!funcBody) {
      return {
        analysis: {
          type: "inline_function",
          strictness: "loose",
          validates_schema: false,
          checks_authorization: false,
        },
        trig: trigger,
      };
    }

    const bodyText = funcBody.text;

    // Check what the matcher validates
    const checksAction = bodyText.includes("msg.Tags.Action") || bodyText.includes('Action"');
    const checksFrom = bodyText.includes("msg.From");
    const checksFrozen = bodyText.includes("State.Frozen") || bodyText.includes("Frozen");
    const checksData = bodyText.includes("msg.Data");
    const usesPcall = bodyText.includes("pcall");
    const checksType = bodyText.includes("type(");

    trigger.checks_from = checksFrom;
    trigger.checks_data = checksData;
    trigger.checks_frozen = checksFrozen;

    // Extract Action tag if present
    const actionMatch = bodyText.match(/msg\.Tags\.Action\s*[=~]=\s*["']([^"']+)["']/);
    if (actionMatch) {
      trigger.action_tag = actionMatch[1];
      trigger.required_tags["Action"] = actionMatch[1];
    }

    // Determine strictness
    let strictness: MatcherAnalysis["strictness"] = "loose";
    const validatesSchema = usesPcall || checksType;

    if (checksFrom && validatesSchema) {
      strictness = "strict";
    } else if (checksFrom || validatesSchema || checksFrozen) {
      strictness = "moderate";
    }

    // Check if it's always true (just returns true)
    const isAlwaysTrue = /^\s*return\s+true\s*$/.test(bodyText.trim());

    const analysis: MatcherAnalysis = {
      type: isAlwaysTrue ? "always_true" : "inline_function",
      strictness: isAlwaysTrue ? "loose" : strictness,
      validates_schema: validatesSchema,
      checks_authorization: checksFrom,
    };

    return { analysis, trig: trigger };
  }

  /**
   * Extract string content from a string node
   */
  private extractStringContent(node: Parser.SyntaxNode): string | null {
    const contentNode = this.findChild(node, "string_content");
    return contentNode ? contentNode.text : null;
  }

  /**
   * Create empty trigger
   */
  private emptyTrigger(): HandlerTrigger {
    return {
      action_tag: null,
      required_tags: {},
      checks_from: false,
      checks_data: false,
      checks_frozen: false,
    };
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
}
