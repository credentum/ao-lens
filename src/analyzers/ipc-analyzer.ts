/**
 * IPC Analyzer - Sprint 4
 * Cross-file analysis and message flow graph generation
 */

import Parser from "tree-sitter";
import { ParseResult } from "../types";

export interface ProcessInfo {
  name: string;
  file: string;
  handlers: string[];
  spawns: SpawnInfo[];
  sends: SendInfo[];
}

export interface SpawnInfo {
  line: number;
  module?: string;
  assigned_to?: string;
}

export interface SendInfo {
  target: string;
  target_type: "static" | "dynamic" | "spawn_ref";
  action: string | null;
  line: number;
}

export interface MessageFlow {
  from: string;
  to: string;
  action: string;
  line: number;
  file: string;
}

export interface IPCGraph {
  processes: ProcessInfo[];
  message_flows: MessageFlow[];
  spawn_relationships: Array<{
    parent: string;
    child: string;
    line: number;
    file: string;
  }>;
}

export class IPCAnalyzer {
  /**
   * Build IPC graph from multiple parse results
   */
  buildGraph(parseResults: ParseResult[]): IPCGraph {
    const processes: ProcessInfo[] = [];
    const messageFlows: MessageFlow[] = [];
    const spawnRelationships: Array<{
      parent: string;
      child: string;
      line: number;
      file: string;
    }> = [];

    for (const result of parseResults) {
      if (!result.success) continue;

      // Extract process name from file path
      const processName = this.extractProcessName(result.file);

      // Get handler names
      const handlerNames = result.handlers.map(h => h.name);

      // Convert ao_sends to SendInfo format
      const sends: SendInfo[] = result.state_analysis.ao_sends.map(s => ({
        target: s.target,
        target_type: s.target_type,
        action: s.action,
        line: s.line,
      }));

      // Build message flows from sends
      for (const send of sends) {
        if (send.action) {
          messageFlows.push({
            from: processName,
            to: this.normalizeTarget(send.target),
            action: send.action,
            line: send.line,
            file: result.file,
          });
        }
      }

      processes.push({
        name: processName,
        file: result.file,
        handlers: handlerNames,
        spawns: [], // Will be populated if we detect ao.spawn()
        sends,
      });
    }

    return {
      processes,
      message_flows: this.deduplicateFlows(messageFlows),
      spawn_relationships: spawnRelationships,
    };
  }

  /**
   * Analyze spawn calls in AST
   */
  analyzeSpawns(rootNode: Parser.SyntaxNode): SpawnInfo[] {
    const spawns: SpawnInfo[] = [];

    this.walkTree(rootNode, (node) => {
      if (node.type === "function_call") {
        const spawn = this.parseAoSpawn(node);
        if (spawn) {
          spawns.push(spawn);
        }
      }
    });

    return spawns;
  }

  /**
   * Parse ao.spawn() call
   */
  private parseAoSpawn(node: Parser.SyntaxNode): SpawnInfo | null {
    const callExpr = this.findChild(node, "dot_index_expression");
    if (!callExpr || callExpr.text !== "ao.spawn") return null;

    const spawn: SpawnInfo = {
      line: node.startPosition.row + 1,
    };

    // Try to extract module name from arguments
    const argsNode = this.findChild(node, "arguments");
    if (argsNode) {
      const firstArg = argsNode.child(1); // Skip opening paren
      if (firstArg?.type === "string") {
        spawn.module = this.extractStringContent(firstArg);
      }
    }

    // Check if assigned to a variable
    const parent = node.parent;
    if (parent?.type === "assignment_statement") {
      const varList = this.findChild(parent, "variable_list");
      if (varList?.firstChild) {
        spawn.assigned_to = varList.firstChild.text;
      }
    }

    return spawn;
  }

  /**
   * Generate mermaid diagram from IPC graph
   */
  generateMermaid(graph: IPCGraph): string {
    const lines: string[] = [];
    lines.push("graph LR");

    // Add process nodes
    const processSet = new Set<string>();
    for (const process of graph.processes) {
      processSet.add(process.name);
      const handlerCount = process.handlers.length;
      lines.push(`    ${this.sanitizeId(process.name)}[${process.name}<br/>${handlerCount} handlers]`);
    }

    // Add message flow edges
    for (const flow of graph.message_flows) {
      const fromId = this.sanitizeId(flow.from);
      const toId = this.sanitizeId(flow.to);

      // Add target process if not already defined
      if (!processSet.has(flow.to)) {
        processSet.add(flow.to);
        lines.push(`    ${toId}[${flow.to}]`);
      }

      lines.push(`    ${fromId} -->|${flow.action}| ${toId}`);
    }

    // Add spawn relationships
    for (const spawn of graph.spawn_relationships) {
      const parentId = this.sanitizeId(spawn.parent);
      const childId = this.sanitizeId(spawn.child);
      lines.push(`    ${parentId} -.->|spawns| ${childId}`);
    }

    return lines.join("\n");
  }

  /**
   * Generate JSON summary of IPC topology
   */
  generateSummary(graph: IPCGraph): {
    process_count: number;
    handler_count: number;
    message_flow_count: number;
    spawn_count: number;
    action_types: string[];
    targets: string[];
  } {
    const allActions = new Set<string>();
    const allTargets = new Set<string>();

    for (const flow of graph.message_flows) {
      allActions.add(flow.action);
      allTargets.add(flow.to);
    }

    return {
      process_count: graph.processes.length,
      handler_count: graph.processes.reduce((sum, p) => sum + p.handlers.length, 0),
      message_flow_count: graph.message_flows.length,
      spawn_count: graph.spawn_relationships.length,
      action_types: Array.from(allActions).sort(),
      targets: Array.from(allTargets).sort(),
    };
  }

  /**
   * Extract process name from file path
   */
  private extractProcessName(filePath: string): string {
    const parts = filePath.split("/");
    const fileName = parts[parts.length - 1];
    return fileName.replace(".lua", "");
  }

  /**
   * Normalize target reference
   */
  private normalizeTarget(target: string): string {
    // Handle common patterns
    if (target.startsWith("msg.")) {
      return target; // Keep as-is for dynamic targets
    }
    if (target.includes("ao.id")) {
      return "self";
    }
    // Remove quotes from static strings
    return target.replace(/^["']|["']$/g, "");
  }

  /**
   * Sanitize ID for mermaid diagram
   */
  private sanitizeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  /**
   * Deduplicate message flows (same from/to/action)
   */
  private deduplicateFlows(flows: MessageFlow[]): MessageFlow[] {
    const seen = new Map<string, MessageFlow>();
    for (const flow of flows) {
      const key = `${flow.from}:${flow.to}:${flow.action}`;
      if (!seen.has(key)) {
        seen.set(key, flow);
      }
    }
    return Array.from(seen.values());
  }

  /**
   * Extract string content from string node
   */
  private extractStringContent(node: Parser.SyntaxNode): string | undefined {
    const contentNode = this.findChild(node, "string_content");
    return contentNode?.text;
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
