/**
 * Response Pattern Checks
 * Verifies proper response patterns in handlers
 */

import { SecurityCheck, ProcessContext, Finding } from "../types";

export const responseChecks: SecurityCheck[] = [
  {
    id: "MUTATING_HANDLER_NO_RESPONSE",
    category: "response",
    description: "Mutating handler doesn't send a response to the caller",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Handlers that don't need responses
      const noResponseNeeded = /^(Freeze|Unfreeze|Init|Initialize)$/i;

      for (const [name, handler] of ctx.handlers) {
        // Skip non-mutating handlers
        if (!handler.mutatesState) continue;

        // Skip handlers that don't need responses
        if (noResponseNeeded.test(name)) continue;

        // Check if handler sends response
        if (!handler.sendsResponse) {
          findings.push({
            code: "MUTATING_HANDLER_NO_RESPONSE",
            message: `Mutating handler "${name}" doesn't send a response`,
            severity: "low",
            line: handler.startLine,
            fix: "Add: ao.send({Target=msg.From, Data='OK'}) or msg.reply({Data='OK'})",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "MATCHER_SIDE_EFFECT_AO_SEND",
    category: "response",
    description:
      "Matcher function contains ao.send() - matchers should be pure",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        const info = handler.handlerInfo;

        // Only applies to inline function matchers
        if (info.signature_type !== "function_matcher") continue;

        // Get matcher source (between first function and handler body)
        const handlerLines = ctx.sourceCode
          .split("\n")
          .slice(handler.startLine - 1, handler.endLine);

        // Simple heuristic: check first function block
        let inMatcher = false;
        let matcherDepth = 0;

        for (let i = 0; i < handlerLines.length; i++) {
          const line = handlerLines[i];

          if (/function\s*\(/.test(line) && !inMatcher) {
            inMatcher = true;
            matcherDepth = 1;
            continue;
          }

          if (inMatcher) {
            if (/\bfunction\s*\(/.test(line)) matcherDepth++;
            if (/\bend\b/.test(line)) matcherDepth--;

            if (matcherDepth === 0) break; // End of matcher

            if (/ao\.send\s*\(/.test(line)) {
              findings.push({
                code: "MATCHER_SIDE_EFFECT_AO_SEND",
                message: `Handler "${name}" matcher contains ao.send() side effect`,
                severity: "high",
                line: handler.startLine + i,
                fix: "Move ao.send() to handler body - matchers should be pure",
              });
            }
          }
        }
      }

      return findings;
    },
  },

  {
    id: "MATCHER_SIDE_EFFECT_STATE_MUTATION",
    category: "response",
    description:
      "Matcher function mutates State - matchers should be pure",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        const info = handler.handlerInfo;

        // Only applies to inline function matchers
        if (info.signature_type !== "function_matcher") continue;

        // Get matcher source
        const handlerLines = ctx.sourceCode
          .split("\n")
          .slice(handler.startLine - 1, handler.endLine);

        let inMatcher = false;
        let matcherDepth = 0;

        for (let i = 0; i < handlerLines.length; i++) {
          const line = handlerLines[i];

          if (/function\s*\(/.test(line) && !inMatcher) {
            inMatcher = true;
            matcherDepth = 1;
            continue;
          }

          if (inMatcher) {
            if (/\bfunction\s*\(/.test(line)) matcherDepth++;
            if (/\bend\b/.test(line)) matcherDepth--;

            if (matcherDepth === 0) break;

            // State mutation (but not comparison)
            if (/State\.[A-Za-z_]+\s*=/.test(line) && !/==/.test(line)) {
              findings.push({
                code: "MATCHER_SIDE_EFFECT_STATE_MUTATION",
                message: `Handler "${name}" matcher mutates State`,
                severity: "high",
                line: handler.startLine + i,
                fix: "Move state mutation to handler body - matchers should be pure",
              });
            }
          }
        }
      }

      return findings;
    },
  },

  {
    id: "INCONSISTENT_ERROR_ACTIONS",
    category: "response",
    description:
      "Inconsistent Action tags for error responses (e.g., 'Error' vs 'Handler-Error')",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Collect all error Action tags from ao.send calls
      const errorActions: Map<string, number[]> = new Map();
      const lines = ctx.sourceCode.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Match ao.send with Action containing "Error"
        const match = line.match(
          /ao\.send\s*\(\s*\{[^}]*Action\s*=\s*["']([^"']*Error[^"']*)["']/,
        );
        if (match) {
          const action = match[1];
          if (!errorActions.has(action)) {
            errorActions.set(action, []);
          }
          errorActions.get(action)!.push(i + 1);
        }
      }

      // If more than one distinct error action pattern, flag inconsistency
      if (errorActions.size > 1) {
        const actions = [...errorActions.keys()];
        const firstAction = actions[0];
        const firstLines = errorActions.get(firstAction)!;

        findings.push({
          code: "INCONSISTENT_ERROR_ACTIONS",
          message: `Inconsistent error Action tags: ${actions.map((a) => `'${a}'`).join(", ")} - use consistent naming`,
          severity: "low",
          line: firstLines[0],
          fix: `Standardize error actions to '${firstAction}' or 'Handler-Error' pattern`,
        });
      }

      return findings;
    },
  },
];
