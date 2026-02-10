/**
 * Determinism Checks
 * Verifies replay safety and determinism in handlers
 */

import { SecurityCheck, ProcessContext, Finding } from "../types";

/**
 * Helper to strip comments from a Lua line
 */
function stripLuaComments(line: string): string {
  // Remove -- comments (but preserve string literals)
  // Simple approach: find -- that's not inside quotes
  const commentIndex = line.indexOf("--");
  if (commentIndex === -1) return line;

  // Check if -- is inside a string (simplified check)
  const beforeComment = line.substring(0, commentIndex);
  const singleQuotes = (beforeComment.match(/'/g) || []).length;
  const doubleQuotes = (beforeComment.match(/"/g) || []).length;

  // If odd number of quotes, we're inside a string
  if (singleQuotes % 2 === 1 || doubleQuotes % 2 === 1) {
    return line;
  }

  return beforeComment;
}

export const determinismChecks: SecurityCheck[] = [
  {
    id: "OS_TIME_USAGE",
    category: "determinism",
    description: "os.time() breaks determinism - use msg.Timestamp instead",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Strip comments before checking - avoid matching os.time() in comments
        const codeOnly = stripLuaComments(line);
        if (/os\.time\s*\(/.test(codeOnly)) {
          findings.push({
            code: "OS_TIME_USAGE",
            message: "os.time() breaks determinism on replay",
            severity: "high",
            line: i + 1,
            fix: "Use msg.Timestamp instead of os.time()",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "MATH_RANDOM_UNSEEDED",
    category: "determinism",
    description:
      "math.random() without deterministic seed breaks replay safety",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      // Check for randomseed in actual code (not comments)
      const hasRandomSeed = lines.some(
        (line) => /math\.randomseed/.test(stripLuaComments(line))
      );

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Strip comments before checking
        const codeOnly = stripLuaComments(line);
        if (/math\.random\s*\(/.test(codeOnly)) {
          if (!hasRandomSeed) {
            findings.push({
              code: "MATH_RANDOM_UNSEEDED",
              message: "math.random() without deterministic seed",
              severity: "high",
              line: i + 1,
              fix: "Seed with msg.Id hash: math.randomseed(tonumber(string.sub(msg.Id, 1, 8), 16))",
            });
          }
        }
      }

      return findings;
    },
  },

  {
    id: "IO_OPERATION",
    category: "determinism",
    description: "IO operations are not available in AO processes",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/io\.\w+\s*\(/.test(line)) {
          findings.push({
            code: "IO_OPERATION",
            message: "IO operations are not available in AO",
            severity: "high",
            line: i + 1,
            fix: "Remove IO operations - use ao.send() for external communication",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "GLOBAL_STATE_MUTATION",
    category: "determinism",
    description:
      "State mutation outside handler may affect replay determinism",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");

      // Track nesting depth to properly handle function scope
      // We use a stack-based approach: each function/handler increases depth
      let functionDepth = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Track function/handler starts (includes Safe.handler and Safe.query)
        // These patterns introduce a function scope with callback
        if (
          /Handlers\.add\s*\(/.test(line) ||
          /Safe\.handler\s*\(/.test(line) ||
          /Safe\.query\s*\(/.test(line)
        ) {
          functionDepth++;
        }
        // Also track standalone function definitions
        if (/function\s*\(/.test(line) || /function\s+\w+\s*\(/.test(line)) {
          functionDepth++;
        }

        // Track end of functions - only standalone 'end' or 'end)' at line end
        // Skip inline if-then-return-end patterns
        if (
          /^\s*end\s*\)?\s*$/.test(line) || // end or end) on its own line
          /^\s*end\s*\)\s*$/.test(line) // end) closing a callback
        ) {
          if (functionDepth > 0) {
            functionDepth--;
          }
        }

        // Check for State mutation outside handlers/functions
        if (
          functionDepth === 0 &&
          /State\.[A-Za-z_]+\s*=/.test(line) &&
          !/State\s*=\s*State\s+or/.test(line) && // Skip State = State or { ... }
          !/==/.test(line) && // Skip comparisons
          i > 10
        ) {
          // Skip initialization at top of file
          findings.push({
            code: "GLOBAL_STATE_MUTATION",
            message: "State mutation outside handler affects replay safety",
            severity: "info",
            line: i + 1,
            fix: "Move state mutations inside handlers to ensure replay determinism",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "MODULE_LEVEL_MUTABLE_STATE",
    category: "determinism",
    description:
      "Module-level variable mutated inside handler creates shared state between message invocations",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];
      const lines = ctx.sourceCode.split("\n");

      // Step 1: Parse the file to find module-level locals and handler boundaries
      const moduleLocals: Map<string, number> = new Map();
      const handlerRanges: Array<{ start: number; end: number }> = [];

      let handlerStart = -1;
      let handlerDepth = 0;
      let inHandler = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const codeOnly = stripLuaComments(line);

        // Detect handler start
        if (/Handlers\.add\s*\(/.test(codeOnly)) {
          handlerStart = i;
          inHandler = true;
          handlerDepth = 0;
        }

        // Track function depth inside handlers
        if (inHandler) {
          if (/\bfunction\s*\(/.test(codeOnly)) {
            handlerDepth++;
          }
          if (/\bend\b/.test(codeOnly)) {
            handlerDepth--;
          }
          // Handlers.add() ends with closing paren, not 'end'
          if (/^\s*\)\s*$/.test(codeOnly) && handlerDepth <= 0) {
            handlerRanges.push({ start: handlerStart, end: i });
            inHandler = false;
            handlerDepth = 0;
          }
        } else {
          // Outside handlers - check for module-level locals
          const localMatch = codeOnly.match(
            /^\s*local\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/,
          );
          if (localMatch) {
            const varName = localMatch[1];
            // Skip common safe patterns (json, require results, constants)
            if (
              varName !== "json" &&
              !line.includes("require(") &&
              !varName.match(/^[A-Z_]+$/) // Skip CONSTANTS
            ) {
              moduleLocals.set(varName, i + 1);
            }
          }
        }
      }

      if (moduleLocals.size === 0 || handlerRanges.length === 0) {
        return findings;
      }

      // Step 2: Check if any module-level local is assigned inside handlers
      for (const range of handlerRanges) {
        for (let i = range.start; i <= range.end; i++) {
          const line = lines[i];
          const codeOnly = stripLuaComments(line);

          for (const [varName, declLine] of moduleLocals) {
            // Match: varName = ... (but not local varName = or == comparisons)
            const assignPattern = new RegExp(
              `(?<!local\\s)\\b${varName}\\s*=(?!=)`,
            );
            if (assignPattern.test(codeOnly)) {
              findings.push({
                code: "MODULE_LEVEL_MUTABLE_STATE",
                message: `Module-level variable "${varName}" (line ${declLine}) mutated inside handler - creates shared state between messages`,
                severity: "high",
                line: i + 1,
                fix: `Move "${varName}" inside handler function or pass via msg.Tags to avoid race conditions`,
              });
              // Remove from map to avoid duplicate findings for same var
              moduleLocals.delete(varName);
              break;
            }
          }
        }
      }

      return findings;
    },
  },
];
