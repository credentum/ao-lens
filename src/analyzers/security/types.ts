/**
 * Security Module Types
 * Defines ProcessContext and SecurityCheck interfaces for context-aware security analysis
 */

import { HandlerInfo, HandlerBodyResult } from "../../types";

// Re-export Finding type for use by check modules
export interface Finding {
  code: string;
  message: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  line: number;
  column?: number;
  fix?: string;
  cwe?: string;
}

/**
 * State initialization analysis
 * Captures what state fields are defined and their initial values
 */
export interface StateAnalysis {
  /** Map of state field names to their initialization info */
  fields: Map<string, StateFieldInfo>;
  /** Whether State.Frozen is explicitly initialized */
  frozenInitialized: boolean;
  /** Value of Frozen if initialized (null if not initialized) */
  frozenValue: boolean | null;
  /** Whether State.Owner is explicitly initialized */
  ownerInitialized: boolean;
  /** Source of owner initialization if present */
  ownerSource: string | null;
}

export interface StateFieldInfo {
  initialized: boolean;
  value?: unknown;
  line: number;
}

/**
 * Handler-level context combining matcher and body analysis
 */
export interface HandlerContext {
  name: string;
  startLine: number;
  endLine: number;

  /** Original HandlerInfo from handler-analyzer */
  handlerInfo: HandlerInfo;
  /** Body analysis if available */
  bodyAnalysis: HandlerBodyResult["body_analysis"] | null;

  /** Combined auth location (matcher, body, both, internal for Safe library, or none) */
  auth: {
    location: "matcher" | "body" | "both" | "internal" | "none";
    pattern: "assert" | "conditional" | "mixed" | "safe_library" | "none";
  };

  /** Combined frozen check location */
  frozen: {
    location: "matcher" | "body" | "both" | "internal" | "none";
  };

  /** Whether this handler uses Safe library (handles security internally) */
  isSafeLibrary: boolean;

  /** Behavior analysis */
  mutatesState: boolean;
  stateFieldsWritten: string[];
  sendsResponse: boolean;
  responseTargets: string[];
}

/**
 * Project-level context derived from analyzing all handlers
 */
export interface ProjectContext {
  /** Whether any handler checks State.Frozen */
  usesFrozen: boolean;
  /** Whether any handler checks authorization */
  usesAuth: boolean;
  /** Number of handlers in the project */
  handlerCount: number;
  /** Whether project has State initialization */
  hasStateInit: boolean;
}

/**
 * Complete ProcessContext built once and passed to all checks
 */
export interface ProcessContext {
  /** Raw source code for pattern matching fallback */
  sourceCode: string;
  /** File path being analyzed */
  filePath: string;

  /** Whether this is a library file (not an AO process) */
  isLibrary: boolean;

  /** Whether this is a test file (skip production rules) */
  isTestFile: boolean;

  /** State initialization analysis */
  state: StateAnalysis;

  /** Handler-level context by handler name */
  handlers: Map<string, HandlerContext>;

  /** Project-level aggregated context */
  project: ProjectContext;
}

/**
 * Security check interface
 * Each check receives the full ProcessContext and returns findings
 */
/** Valid check categories */
export type CheckCategoryType = "auth" | "frozen" | "determinism" | "json" | "response" | "style";

export interface SecurityCheck {
  /** Unique check identifier (e.g., NO_FROZEN_CHECK) */
  id: string;
  /** Check category for grouping */
  category: CheckCategoryType;
  /** Human-readable description */
  description: string;
  /** Whether this check applies to library files (default: false) */
  appliesToLibrary?: boolean;
  /** Whether this check applies to test files (default: true) */
  appliesToTestFile?: boolean;
  /** Run the check against the ProcessContext */
  run(context: ProcessContext): Finding[];
}

/**
 * Check category metadata
 */
export interface CheckCategory {
  id: string;
  name: string;
  description: string;
  checks: SecurityCheck[];
}

/**
 * Find which handler a source line belongs to.
 * Returns the HandlerContext if the line is inside a handler, null otherwise.
 */
export function findHandlerAtLine(ctx: ProcessContext, line: number): HandlerContext | null {
  for (const [, handler] of ctx.handlers) {
    if (line >= handler.startLine && line <= handler.endLine) {
      return handler;
    }
  }
  return null;
}

/**
 * Strip Lua line comments (--) while respecting string literals.
 * Shared utility for checks that need to avoid false positives from comments.
 */
export function stripLuaComments(line: string): string {
  const commentIndex = line.indexOf("--");
  if (commentIndex === -1) return line;

  const beforeComment = line.substring(0, commentIndex);
  const singleQuotes = (beforeComment.match(/'/g) || []).length;
  const doubleQuotes = (beforeComment.match(/"/g) || []).length;

  // If odd number of quotes, we're inside a string
  if (singleQuotes % 2 === 1 || doubleQuotes % 2 === 1) {
    return line;
  }

  return beforeComment;
}
