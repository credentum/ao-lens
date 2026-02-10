/**
 * Frozen State Checks
 * Verifies proper frozen state handling in handlers
 */

import { SecurityCheck, ProcessContext, Finding } from "../types";

export const frozenChecks: SecurityCheck[] = [
  {
    id: "NO_FROZEN_CHECK",
    category: "frozen",
    description: "Mutating handler does not check Frozen state",
    appliesToTestFile: false, // Test files don't need production frozen checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Patterns that indicate a mutating handler (even if it doesn't write State yet)
      const mutatingPatterns = [
        /^Update/i, /^Set/i, /^Delete/i, /^Remove/i, /^Add/i, /^Create/i,
        /^Modify/i, /^Change/i, /^Edit/i, /^Write/i, /^Save/i, /^Store/i,
        /^Transfer/i, /^Mint/i, /^Burn/i, /^Freeze/i, /^Unfreeze/i,
        /^Register/i, /^Deregister/i, /^Subscribe/i, /^Unsubscribe/i,
      ];

      for (const [name, handler] of ctx.handlers) {
        // Check if handler is mutating by name pattern OR by actual state writes
        const isMutatingByName = mutatingPatterns.some(p => p.test(name));
        const isMutatingByState = handler.mutatesState;

        // Skip if clearly non-mutating (read-only patterns)
        const readOnlyPatterns = [/^Get/i, /^Query/i, /^List/i, /^Info/i, /^Status/i, /^Read/i];
        const isReadOnly = readOnlyPatterns.some(p => p.test(name));

        if (!isMutatingByName && !isMutatingByState) continue;
        if (isReadOnly && !isMutatingByState) continue;

        // Check if handler checks frozen (in matcher, body, or internal via Safe library)
        // "internal" means Safe library handles it automatically
        if (handler.frozen.location === "none") {
          const reason = isMutatingByName
            ? `name pattern "${name}" suggests mutation`
            : "writes to State";
          findings.push({
            code: "NO_FROZEN_CHECK",
            message: `Handler "${name}" does not check Frozen state (${reason})`,
            severity: "high",
            line: handler.startLine,
            fix: "Use Safe.handler() which handles frozen checks automatically, or add: if State.Frozen then return false end",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "STATE_FROZEN_NOT_INITIALIZED",
    category: "frozen",
    description: "Project uses Frozen checks but Frozen is not initialized",
    appliesToTestFile: false, // Test files don't need production frozen checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Check if any handler checks frozen but Frozen isn't initialized
      const anyHandlerChecksFrozen = Array.from(ctx.handlers.values()).some(
        (h) => h.frozen.location !== "none"
      );

      if (anyHandlerChecksFrozen && !ctx.state.frozenInitialized) {
        findings.push({
          code: "STATE_FROZEN_NOT_INITIALIZED",
          message:
            "State.Frozen is checked but never initialized - will be nil on first message",
          severity: "high",
          line: 1,
          fix: "Initialize Frozen: State = State or { Frozen = false }",
        });
      }

      return findings;
    },
  },

  {
    id: "ASSERT_NOT_FROZEN_NIL_BYPASS",
    category: "frozen",
    description:
      "assert(not State.Frozen) can be bypassed if Frozen is nil (nil is falsy, so not nil = true)",
    appliesToTestFile: false, // Test files don't need production frozen checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Skip if Frozen is properly initialized
      if (ctx.state.frozenInitialized) {
        return findings;
      }

      // Check for assert(not State.Frozen) pattern
      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/assert\s*\(\s*not\s+State\.Frozen/.test(line)) {
          findings.push({
            code: "ASSERT_NOT_FROZEN_NIL_BYPASS",
            message:
              "assert(not State.Frozen) bypassed when Frozen is nil (not nil = true)",
            severity: "high",
            line: i + 1,
            fix: "Use: assert(State.Frozen == false, 'Process is frozen') or initialize Frozen = false",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "FROZEN_CHECK_NOT_IN_MATCHER",
    category: "frozen",
    description:
      "Frozen check is only in body, not in matcher (wasted compute if frozen)",
    appliesToTestFile: false, // Test files don't need production frozen checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        const info = handler.handlerInfo;

        // Skip table matchers - can't add frozen check to a table
        if (info.signature_type === "table") continue;

        // Skip hasMatchingTag - can't add frozen check
        if (info.signature_type === "hasMatchingTag") continue;

        // Only flag inline function matchers that have frozen in body but not matcher
        if (handler.frozen.location === "body" && info.signature_type === "function_matcher") {
          findings.push({
            code: "FROZEN_CHECK_NOT_IN_MATCHER",
            message: `Handler "${name}" checks Frozen in body but not matcher (wastes compute)`,
            severity: "medium",
            line: handler.startLine,
            fix: "Add frozen check to matcher: if State.Frozen then return false end",
          });
        }
      }

      return findings;
    },
  },
];
