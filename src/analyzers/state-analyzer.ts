/**
 * State Analyzer - Sprint 3
 * Tracks state access, side effects, and replay safety
 */

import Parser from "tree-sitter";

export interface StateAccess {
  field: string;
  type: "read" | "write";
  line: number;
}

export interface MessageSend {
  target: string;
  target_type: "static" | "dynamic";
  action: string | null;
  line: number;
}

export interface MsgFieldUsage {
  field: string;
  line: number;
}

export interface DeterminismViolation {
  type: "os_time" | "math_random" | "io_call";
  line: number;
  code: string;
  suggestion: string;
}

export interface HandlerStateAnalysis {
  handler_name: string;
  line: number;
  state_access: {
    reads: StateAccess[];
    writes: StateAccess[];
  };
  messages: {
    sends: MessageSend[];
    spawns: number;
  };
  msg_fields: MsgFieldUsage[];
  determinism: {
    is_replay_safe: boolean;
    violations: DeterminismViolation[];
  };
}

export class StateAnalyzer {
  /**
   * Analyze a handler's state access and side effects
   */
  analyzeHandler(
    handlerNode: Parser.SyntaxNode,
    handlerName: string
  ): HandlerStateAnalysis {
    const reads: StateAccess[] = [];
    const writes: StateAccess[] = [];
    const sends: MessageSend[] = [];
    const msgFields: MsgFieldUsage[] = [];
    const violations: DeterminismViolation[] = [];
    let spawnCount = 0;

    this.walkTree(handlerNode, (node) => {
      // Track State.* access
      if (node.type === "dot_index_expression") {
        const stateAccess = this.parseStateAccess(node);
        if (stateAccess) {
          if (this.isWriteContext(node)) {
            writes.push({ ...stateAccess, type: "write" });
          } else {
            reads.push({ ...stateAccess, type: "read" });
          }
        }

        // Track msg.* usage
        const msgField = this.parseMsgField(node);
        if (msgField) {
          msgFields.push(msgField);
        }
      }

      // Track ao.send() calls
      if (node.type === "function_call") {
        const send = this.parseAoSend(node);
        if (send) {
          sends.push(send);
        }

        // Track ao.spawn() calls
        if (this.isAoSpawn(node)) {
          spawnCount++;
        }

        // Check for determinism violations
        const violation = this.checkDeterminism(node);
        if (violation) {
          violations.push(violation);
        }
      }
    });

    // Deduplicate
    const uniqueReads = this.deduplicateAccess(reads);
    const uniqueWrites = this.deduplicateAccess(writes);
    const uniqueMsgFields = this.deduplicateMsgFields(msgFields);

    return {
      handler_name: handlerName,
      line: handlerNode.startPosition.row + 1,
      state_access: {
        reads: uniqueReads,
        writes: uniqueWrites,
      },
      messages: {
        sends,
        spawns: spawnCount,
      },
      msg_fields: uniqueMsgFields,
      determinism: {
        is_replay_safe: violations.length === 0,
        violations,
      },
    };
  }

  /**
   * Analyze entire file for state patterns
   */
  analyzeFile(rootNode: Parser.SyntaxNode): {
    global_state: StateAccess[];
    ao_sends: MessageSend[];
    determinism_issues: DeterminismViolation[];
  } {
    const globalState: StateAccess[] = [];
    const aoSends: MessageSend[] = [];
    const issues: DeterminismViolation[] = [];

    this.walkTree(rootNode, (node) => {
      if (node.type === "dot_index_expression") {
        const stateAccess = this.parseStateAccess(node);
        if (stateAccess) {
          const type = this.isWriteContext(node) ? "write" : "read";
          globalState.push({ ...stateAccess, type });
        }
      }

      if (node.type === "function_call") {
        const send = this.parseAoSend(node);
        if (send) {
          aoSends.push(send);
        }

        const violation = this.checkDeterminism(node);
        if (violation) {
          issues.push(violation);
        }
      }
    });

    return {
      global_state: this.deduplicateAccess(globalState),
      ao_sends: aoSends,
      determinism_issues: issues,
    };
  }

  /**
   * Parse State.* access from dot_index_expression
   */
  private parseStateAccess(node: Parser.SyntaxNode): Omit<StateAccess, "type"> | null {
    const text = node.text;

    // Match State.Field or State.Field.SubField
    const match = text.match(/^State\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/);
    if (!match) return null;

    return {
      field: `State.${match[1]}`,
      line: node.startPosition.row + 1,
    };
  }

  /**
   * Parse msg.* field access
   */
  private parseMsgField(node: Parser.SyntaxNode): MsgFieldUsage | null {
    const text = node.text;

    // Match msg.Field or msg.Tags.Field
    const match = text.match(/^msg\.([A-Za-z_][A-Za-z0-9_.]*)/);
    if (!match) return null;

    return {
      field: match[1],
      line: node.startPosition.row + 1,
    };
  }

  /**
   * Check if node is in a write context (left side of assignment)
   */
  private isWriteContext(node: Parser.SyntaxNode): boolean {
    let current = node.parent;

    while (current) {
      if (current.type === "assignment_statement") {
        // Check if our node is on the left side
        const variableList = this.findChild(current, "variable_list");
        if (variableList && this.isDescendant(variableList, node)) {
          return true;
        }
        return false;
      }
      current = current.parent;
    }

    return false;
  }

  /**
   * Check if child is a descendant of parent
   */
  private isDescendant(parent: Parser.SyntaxNode, child: Parser.SyntaxNode): boolean {
    let current: Parser.SyntaxNode | null = child;
    while (current) {
      if (current === parent) return true;
      current = current.parent;
    }
    return false;
  }

  /**
   * Parse ao.send() call
   */
  private parseAoSend(node: Parser.SyntaxNode): MessageSend | null {
    const callExpr = this.findChild(node, "dot_index_expression");
    if (!callExpr || callExpr.text !== "ao.send") return null;

    const argsNode = this.findChild(node, "arguments");
    if (!argsNode) return null;

    // Find the table constructor argument
    const tableNode = this.findChild(argsNode, "table_constructor");
    if (!tableNode) return null;

    let target = "unknown";
    let targetType: "static" | "dynamic" = "static";
    let action: string | null = null;

    // Parse table fields
    this.walkTree(tableNode, (fieldNode) => {
      if (fieldNode.type === "field") {
        const nameNode = fieldNode.childForFieldName("name");
        const valueNode = fieldNode.childForFieldName("value");

        if (nameNode && valueNode) {
          const fieldName = nameNode.text;
          const fieldValue = valueNode.text;

          if (fieldName === "Target") {
            target = fieldValue;
            // Check if dynamic (references msg or variable)
            if (fieldValue.includes("msg.") || !fieldValue.startsWith('"')) {
              targetType = "dynamic";
            }
          } else if (fieldName === "Action") {
            // Extract string content
            const match = fieldValue.match(/^["'](.+)["']$/);
            action = match ? match[1] : fieldValue;
          }
        }
      }
    });

    return {
      target,
      target_type: targetType,
      action,
      line: node.startPosition.row + 1,
    };
  }

  /**
   * Check if node is ao.spawn() call
   */
  private isAoSpawn(node: Parser.SyntaxNode): boolean {
    const callExpr = this.findChild(node, "dot_index_expression");
    return callExpr?.text === "ao.spawn";
  }

  /**
   * Check for determinism violations
   */
  private checkDeterminism(node: Parser.SyntaxNode): DeterminismViolation | null {
    const callExpr = this.findChild(node, "dot_index_expression") ||
                     this.findChild(node, "identifier");

    if (!callExpr) return null;

    const callText = callExpr.text;

    // Check for os.time()
    if (callText === "os.time") {
      return {
        type: "os_time",
        line: node.startPosition.row + 1,
        code: node.text.slice(0, 30),
        suggestion: "Use msg.Timestamp instead of os.time()",
      };
    }

    // Check for math.random()
    if (callText === "math.random") {
      return {
        type: "math_random",
        line: node.startPosition.row + 1,
        code: node.text.slice(0, 30),
        suggestion: "Use msg.Id as seed for deterministic randomness",
      };
    }

    // Check for io operations
    if (callText.startsWith("io.")) {
      return {
        type: "io_call",
        line: node.startPosition.row + 1,
        code: node.text.slice(0, 30),
        suggestion: "IO operations are not available in AO processes",
      };
    }

    return null;
  }

  /**
   * Deduplicate state access entries
   */
  private deduplicateAccess(accesses: StateAccess[]): StateAccess[] {
    const seen = new Map<string, StateAccess>();
    for (const access of accesses) {
      const key = `${access.field}:${access.type}:${access.line}`;
      if (!seen.has(key)) {
        seen.set(key, access);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Deduplicate msg field entries
   */
  private deduplicateMsgFields(fields: MsgFieldUsage[]): MsgFieldUsage[] {
    const seen = new Map<string, MsgFieldUsage>();
    for (const field of fields) {
      const key = `${field.field}:${field.line}`;
      if (!seen.has(key)) {
        seen.set(key, field);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Find all state accesses within a line range
   */
  findStateAccessInRange(
    rootNode: Parser.SyntaxNode,
    startLine: number,
    endLine: number
  ): { reads: StateAccess[]; writes: StateAccess[] } {
    const reads: StateAccess[] = [];
    const writes: StateAccess[] = [];

    this.walkTree(rootNode, (node) => {
      const line = node.startPosition.row + 1;
      if (line >= startLine && line <= endLine && node.type === "dot_index_expression") {
        const stateAccess = this.parseStateAccess(node);
        if (stateAccess) {
          if (this.isWriteContext(node)) {
            writes.push({ ...stateAccess, type: "write" });
          } else {
            reads.push({ ...stateAccess, type: "read" });
          }
        }
      }
    });

    return {
      reads: this.deduplicateAccess(reads),
      writes: this.deduplicateAccess(writes),
    };
  }

  /**
   * Find ao.send calls within a line range
   */
  findAoSendsInRange(
    rootNode: Parser.SyntaxNode,
    startLine: number,
    endLine: number
  ): MessageSend[] {
    const sends: MessageSend[] = [];

    this.walkTree(rootNode, (node) => {
      const line = node.startPosition.row + 1;
      if (line >= startLine && line <= endLine && node.type === "function_call") {
        const send = this.parseAoSend(node);
        if (send) {
          sends.push(send);
        }
      }
    });

    return sends;
  }

  /**
   * Check if handler body validates auth (assert or conditional)
   */
  checkAuthPattern(
    rootNode: Parser.SyntaxNode,
    startLine: number,
    endLine: number
  ): { validates: boolean; pattern: "assert" | "conditional" | "none" } {
    let hasAssertAuth = false;
    let hasConditionalAuth = false;

    this.walkTree(rootNode, (node) => {
      const line = node.startPosition.row + 1;
      if (line >= startLine && line <= endLine) {
        const text = node.text;
        // Check for assert-based auth
        if (node.type === "function_call" && text.includes("assert") &&
            (text.includes("msg.From") || text.includes("State.Owner"))) {
          hasAssertAuth = true;
        }
        // Check for conditional auth
        if (node.type === "if_statement" &&
            (text.includes("msg.From") && text.includes("State.Owner"))) {
          hasConditionalAuth = true;
        }
      }
    });

    if (hasAssertAuth) return { validates: true, pattern: "assert" };
    if (hasConditionalAuth) return { validates: true, pattern: "conditional" };
    return { validates: false, pattern: "none" };
  }

  /**
   * Check if handler parses JSON and if it uses pcall
   */
  checkJsonParsing(
    rootNode: Parser.SyntaxNode,
    startLine: number,
    endLine: number
  ): { parses: boolean; isPcalled: boolean } {
    let parsesJson = false;
    let isPcalled = false;

    this.walkTree(rootNode, (node) => {
      const line = node.startPosition.row + 1;
      if (line >= startLine && line <= endLine) {
        const text = node.text;
        if (text.includes("json.decode")) {
          parsesJson = true;
          if (text.includes("pcall") && text.includes("json.decode")) {
            isPcalled = true;
          }
        }
      }
    });

    return { parses: parsesJson, isPcalled };
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
