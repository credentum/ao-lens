/**
 * ProcessContextBuilder
 * Builds ProcessContext once per file for use by all security checks
 */

import Parser from "tree-sitter";
import Lua from "@tree-sitter-grammars/tree-sitter-lua";
import {
  ProcessContext,
  StateAnalysis,
  StateFieldInfo,
  HandlerContext,
  ProjectContext,
} from "./types";
import { HandlerAnalyzer, HandlerInfo } from "../handler-analyzer";
import { StateAnalyzer } from "../state-analyzer";

export class ProcessContextBuilder {
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
   * Build complete ProcessContext from source code
   */
  build(sourceCode: string, filePath: string): ProcessContext {
    const tree = this.parser.parse(sourceCode);
    const rootNode = tree.rootNode;

    // 0. Detect if this is a library file (not an AO process)
    const isLibrary = this.detectLibrary(sourceCode, filePath);

    // 0b. Detect if this is a test file (skip production rules)
    const isTestFile = this.detectTestFile(filePath);

    // 1. Analyze state initialization
    const state = this.analyzeStateInit(sourceCode, rootNode);

    // 2. Find handlers using existing HandlerAnalyzer
    const handlerInfos = this.handlerAnalyzer.findHandlers(rootNode);

    // 3. Build handler contexts with combined analysis
    const handlers = new Map<string, HandlerContext>();
    for (const handlerInfo of handlerInfos) {
      const handlerContext = this.buildHandlerContext(
        handlerInfo,
        rootNode,
        sourceCode
      );
      handlers.set(handlerInfo.name, handlerContext);
    }

    // 4. Compute project-level context
    const project = this.buildProjectContext(handlers, state);

    return {
      sourceCode,
      filePath,
      isLibrary,
      isTestFile,
      state,
      handlers,
      project,
    };
  }

  /**
   * Detect if a file is a library (module) rather than an AO process
   * Libraries export a module table and don't run as standalone processes
   */
  private detectLibrary(sourceCode: string, filePath: string): boolean {
    // Pattern 1: File path contains /lib/ directory
    if (/[\/\\]lib[\/\\]/.test(filePath)) {
      return true;
    }

    // Pattern 2: File ends with "return <ModuleName>" (Lua module pattern)
    // Must be at end of file, possibly with trailing whitespace/comments
    const moduleReturnPattern = /return\s+\w+\s*(?:--[^\n]*)?\s*$/;
    if (moduleReturnPattern.test(sourceCode)) {
      return true;
    }

    // Pattern 3: Explicit annotation "-- @ao-lens: library" or "-- @ao-lens-library"
    if (/--\s*@ao-lens[:\s-]library/.test(sourceCode)) {
      return true;
    }

    // Pattern 4: Creates and returns a local table (common library pattern)
    // local Safe = {} ... return Safe
    const localModulePattern = /^local\s+(\w+)\s*=\s*\{\s*\}[\s\S]*return\s+\1\s*$/m;
    if (localModulePattern.test(sourceCode)) {
      return true;
    }

    return false;
  }

  /**
   * Detect if a file is a test file
   * Test files don't need production security rules (Safe library, etc.)
   */
  private detectTestFile(filePath: string): boolean {
    // Pattern 1: File path contains /test/ directory
    if (/[\/\\]test[\/\\]/.test(filePath)) {
      return true;
    }

    // Pattern 2: File name starts with test_ or ends with _test.lua
    const fileName = filePath.split(/[\/\\]/).pop() || "";
    if (/^test_/.test(fileName) || /_test\.lua$/.test(fileName)) {
      return true;
    }

    // Pattern 3: File name is test.lua
    if (fileName === "test.lua") {
      return true;
    }

    return false;
  }

  /**
   * Analyze state initialization patterns
   */
  private analyzeStateInit(
    sourceCode: string,
    _rootNode: Parser.SyntaxNode
  ): StateAnalysis {
    const fields = new Map<string, StateFieldInfo>();
    let frozenInitialized = false;
    let frozenValue: boolean | null = null;
    let ownerInitialized = false;
    let ownerSource: string | null = null;

    // Check for Safe.initState() - Safe library handles Owner and Frozen automatically
    const safeInitMatch = sourceCode.match(/Safe\.initState\s*\(/);
    if (safeInitMatch) {
      // Safe.initState() sets Owner from ao.env.Process.Owner automatically
      ownerInitialized = true;
      ownerSource = "Safe.initState";
      fields.set("Owner", {
        initialized: true,
        value: "Safe.initState",
        line: 1,  // Will be overwritten if we find the actual line
      });

      // Safe.initState() initializes Frozen = false by default
      frozenInitialized = true;
      frozenValue = false;
      fields.set("Frozen", {
        initialized: true,
        value: false,
        line: 1,
      });

      // Find actual line number for Safe.initState
      const lines = sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (/Safe\.initState\s*\(/.test(lines[i])) {
          fields.get("Owner")!.line = i + 1;
          fields.get("Frozen")!.line = i + 1;
          break;
        }
      }
    }

    const lines = sourceCode.split("\n");

    // Look for State = State or { ... } or State = { ... } pattern
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Match State initialization line
      if (/^State\s*=/.test(line) || /^\s*State\s*=/.test(line)) {
        // Extract the table initialization
        // May span multiple lines, so we'll check for common fields

        // Check for Frozen initialization
        const frozenMatch = line.match(/Frozen\s*=\s*(true|false)/);
        if (frozenMatch) {
          frozenInitialized = true;
          frozenValue = frozenMatch[1] === "true";
          fields.set("Frozen", {
            initialized: true,
            value: frozenValue,
            line: lineNumber,
          });
        }

        // Check for Owner initialization
        const ownerNilMatch = line.match(/Owner\s*=\s*nil/);
        const ownerValueMatch = line.match(
          /Owner\s*=\s*(ao\.env\.Process\.Owner|["'][^"']+["'])/
        );
        if (ownerValueMatch) {
          ownerInitialized = true;
          ownerSource = ownerValueMatch[1];
          fields.set("Owner", {
            initialized: true,
            value: ownerSource,
            line: lineNumber,
          });
        } else if (ownerNilMatch) {
          // Owner = nil - check for conditional initialization in next few lines
          // Pattern: if not State.Owner then State.Owner = ao.env.Process.Owner end
          const nextLines = lines.slice(i, i + 5).join("\n");
          const hasConditionalInit = /if\s+not\s+State\.Owner\s+then\s+State\.Owner\s*=\s*(ao\.env\.Process\.Owner|["'][^"']+["'])/.test(nextLines);

          if (hasConditionalInit) {
            ownerInitialized = true;
            ownerSource = "conditional";
            fields.set("Owner", {
              initialized: true,
              value: "conditional",
              line: lineNumber,
            });
          } else {
            // Owner = nil without conditional init is NOT properly initialized
            fields.set("Owner", {
              initialized: false,
              value: null,
              line: lineNumber,
            });
          }
        }

        // Check for other common fields
        const dataMatch = line.match(/Data\s*=\s*\{/);
        if (dataMatch) {
          fields.set("Data", {
            initialized: true,
            value: {},
            line: lineNumber,
          });
        }
      }

      // Also check subsequent lines for multi-line State init
      if (i > 0 && /^\s*(Frozen|Owner|Data)\s*=/.test(line)) {
        // Continuation of State table
        const frozenMatch = line.match(/Frozen\s*=\s*(true|false)/);
        if (frozenMatch) {
          frozenInitialized = true;
          frozenValue = frozenMatch[1] === "true";
          fields.set("Frozen", {
            initialized: true,
            value: frozenValue,
            line: lineNumber,
          });
        }

        const ownerValueMatch = line.match(
          /Owner\s*=\s*(ao\.env\.Process\.Owner|["'][^"']+["'])/
        );
        if (ownerValueMatch) {
          ownerInitialized = true;
          ownerSource = ownerValueMatch[1];
          fields.set("Owner", {
            initialized: true,
            value: ownerSource,
            line: lineNumber,
          });
        }
      }

      // Check for State.Owner = State.Owner or ao.env.Process.Owner pattern
      // This is valid if followed by an assert
      if (/State\.Owner\s*=\s*State\.Owner\s+or\s+ao\.env\.Process\.Owner/.test(line)) {
        // Check for assert in next few lines
        const nextLines = lines.slice(i, i + 5).join("\n");
        const hasAssert = /assert\s*\(\s*State\.Owner\s*~=\s*nil/.test(nextLines);
        if (hasAssert) {
          ownerInitialized = true;
          ownerSource = "or_with_assert";
          fields.set("Owner", {
            initialized: true,
            value: "or_with_assert",
            line: lineNumber,
          });
        }
      }
    }

    return {
      fields,
      frozenInitialized,
      frozenValue,
      ownerInitialized,
      ownerSource,
    };
  }

  /**
   * Build HandlerContext from HandlerInfo and body analysis
   */
  private buildHandlerContext(
    handlerInfo: HandlerInfo,
    rootNode: Parser.SyntaxNode,
    sourceCode: string
  ): HandlerContext {
    const { line: startLine, end_line: endLine } = handlerInfo;

    // Check if this is a Safe library handler
    const isSafeLibrary = handlerInfo.is_safe_library === true;

    // Use StateAnalyzer to get auth and json patterns
    const authResult = this.stateAnalyzer.checkAuthPattern(
      rootNode,
      startLine,
      endLine
    );
    const stateAccess = this.stateAnalyzer.findStateAccessInRange(
      rootNode,
      startLine,
      endLine
    );
    const aoSends = this.stateAnalyzer.findAoSendsInRange(
      rootNode,
      startLine,
      endLine
    );

    // Check for msg.reply() or Safe.reply() in source
    const handlerSource = this.extractLines(sourceCode, startLine, endLine);
    const hasMsgReply = /msg\.reply\s*\(/.test(handlerSource);
    const hasSafeReply = /Safe\.reply\s*\(/.test(handlerSource);
    const hasAoSend = aoSends.length > 0;

    // Determine auth location
    let authLocation: "matcher" | "body" | "both" | "internal" | "none";
    let authPattern: "assert" | "conditional" | "mixed" | "safe_library" | "none";

    if (isSafeLibrary) {
      // Safe library handlers: auth is handled internally if owner=true
      const safeOpts = handlerInfo.safe_options;
      if (safeOpts?.owner) {
        authLocation = "internal";
        authPattern = "safe_library";
      } else {
        // Safe.query or Safe.handler with owner=false - no auth needed (public)
        authLocation = "none";
        authPattern = "none";
      }
    } else {
      // Regular Handlers.add - check matcher and body
      const matcherHasAuth = handlerInfo.matcher_analysis.checks_authorization;
      const bodyHasAuth = authResult.validates;
      if (matcherHasAuth && bodyHasAuth) {
        authLocation = "both";
      } else if (matcherHasAuth) {
        authLocation = "matcher";
      } else if (bodyHasAuth) {
        authLocation = "body";
      } else {
        authLocation = "none";
      }
      authPattern = authResult.pattern;
    }

    // Determine frozen location
    let frozenLocation: "matcher" | "body" | "both" | "internal" | "none";

    if (isSafeLibrary) {
      // Safe library handlers: frozen is handled internally if frozen=true
      const safeOpts = handlerInfo.safe_options;
      if (safeOpts?.frozen) {
        frozenLocation = "internal";
      } else {
        // Safe.query or Safe.handler with frozen=false - no frozen check needed
        frozenLocation = "none";
      }
    } else {
      // Regular Handlers.add - check matcher and body
      const matcherHasFrozen = handlerInfo.trigger.checks_frozen;
      const bodyHasFrozen = /State\.Frozen/.test(handlerSource);
      if (matcherHasFrozen && bodyHasFrozen) {
        frozenLocation = "both";
      } else if (matcherHasFrozen) {
        frozenLocation = "matcher";
      } else if (bodyHasFrozen) {
        frozenLocation = "body";
      } else {
        frozenLocation = "none";
      }
    }

    // Build body analysis in expected format
    const bodyHasFrozenCheck = /State\.Frozen/.test(handlerSource);
    const bodyAnalysis = {
      validates_auth: isSafeLibrary ? (handlerInfo.safe_options?.owner ?? false) : authResult.validates,
      auth_pattern: authPattern,
      checks_frozen: isSafeLibrary ? (handlerInfo.safe_options?.frozen ?? false) : bodyHasFrozenCheck,
      parses_json: isSafeLibrary || /json\.decode/.test(handlerSource),  // Safe library always parses JSON
      json_is_pcalled:
        isSafeLibrary ||  // Safe library uses pcall internally
        /pcall\s*\(\s*json\.decode/.test(handlerSource) ||
        /pcall\s*\(\s*function.*json\.decode/.test(handlerSource),
      state_reads: stateAccess.reads.map((r) => r.field),
      state_writes: stateAccess.writes.map((w) => w.field),
      ao_sends: aoSends.map((s) => ({ target: s.target, action: s.action })),
      local_functions_called: [],
    };

    return {
      name: handlerInfo.name,
      startLine,
      endLine,
      handlerInfo,
      bodyAnalysis,
      auth: {
        location: authLocation,
        pattern: authPattern,
      },
      frozen: {
        location: frozenLocation,
      },
      isSafeLibrary,
      mutatesState: stateAccess.writes.length > 0,
      stateFieldsWritten: stateAccess.writes.map((w) => w.field),
      sendsResponse: hasAoSend || hasMsgReply || hasSafeReply,
      responseTargets: aoSends.map((s) => s.target),
    };
  }

  /**
   * Build project-level context from handlers
   */
  private buildProjectContext(
    handlers: Map<string, HandlerContext>,
    state: StateAnalysis
  ): ProjectContext {
    let usesFrozen = state.frozenInitialized;
    let usesAuth = false;

    for (const handler of handlers.values()) {
      if (handler.frozen.location !== "none") {
        usesFrozen = true;
      }
      if (handler.auth.location !== "none") {
        usesAuth = true;
      }
    }

    return {
      usesFrozen,
      usesAuth,
      handlerCount: handlers.size,
      hasStateInit: state.fields.size > 0,
    };
  }

  /**
   * Extract source lines from code
   */
  private extractLines(
    sourceCode: string,
    startLine: number,
    endLine: number
  ): string {
    const lines = sourceCode.split("\n");
    return lines.slice(startLine - 1, endLine).join("\n");
  }
}
