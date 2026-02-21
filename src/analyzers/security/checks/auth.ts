/**
 * Authorization Checks
 * Verifies proper authorization patterns in handlers
 */

import { SecurityCheck, ProcessContext, Finding, findHandlerAtLine } from "../types";

export const authChecks: SecurityCheck[] = [
  {
    id: "NO_AUTH_CHECK",
    category: "auth",
    description: "Handler has no authorization check",
    appliesToTestFile: false, // Test files don't need production auth checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        // Skip if handler doesn't mutate state
        if (!handler.mutatesState) continue;

        // Check if handler has any auth (matcher or body)
        if (handler.auth.location === "none") {
          findings.push({
            code: "NO_AUTH_CHECK",
            message: `Mutating handler "${name}" has no authorization check`,
            severity: "critical",
            line: handler.startLine,
            fix: "Add auth check: if msg.From ~= State.Owner then return false end",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "HASMATCHING_TAG_NO_HANDLER_AUTH",
    category: "auth",
    description: "hasMatchingTag pattern without body authorization",
    appliesToTestFile: false, // Test files don't need production auth checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        const info = handler.handlerInfo;

        // Only applies to hasMatchingTag signature with no body auth
        if (
          info.signature_type === "hasMatchingTag" &&
          handler.auth.location === "none" &&
          handler.mutatesState
        ) {
          findings.push({
            code: "HASMATCHING_TAG_NO_HANDLER_AUTH",
            message: `Handler "${name}" uses hasMatchingTag but has no handler body auth`,
            severity: "critical",
            line: handler.startLine,
            fix: "Add assert(msg.From == State.Owner, 'Unauthorized') in handler body",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "LOOSE_MATCHER_WITH_BODY_AUTH",
    category: "auth",
    description:
      "Handler has auth in body but uses loose matcher (informational)",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        const info = handler.handlerInfo;

        // Has body auth but loose matcher
        if (
          info.matcher_analysis.strictness === "loose" &&
          handler.auth.location === "body"
        ) {
          findings.push({
            code: "LOOSE_MATCHER_WITH_BODY_AUTH",
            message: `Handler "${name}" has body auth but loose matcher`,
            severity: "low",
            line: handler.startLine,
            fix: "Consider adding auth check to matcher for defense-in-depth",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "MISSING_BELT_AND_SUSPENDERS",
    category: "auth",
    description: "Auth in matcher but not in body (missing defense-in-depth)",
    appliesToTestFile: false, // Test files don't need production auth checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        // Has matcher auth but no body auth
        if (handler.auth.location === "matcher" && handler.mutatesState) {
          findings.push({
            code: "MISSING_BELT_AND_SUSPENDERS",
            message: `Handler "${name}" has auth in matcher but not in body`,
            severity: "medium",
            line: handler.startLine,
            fix: "Add assert(msg.From == State.Owner, 'Unauthorized') in handler body too",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "OWNER_NEVER_INITIALIZED",
    category: "auth",
    description: "State.Owner is never properly initialized",
    appliesToTestFile: false, // Test files don't need production auth checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Check if any handler uses auth but Owner isn't initialized
      if (ctx.project.usesAuth && !ctx.state.ownerInitialized) {
        // Skip if project uses alternative auth patterns (not State.Owner based)
        const hasAclModule = /require\s*\(\s*['"][^'"]*acl[^'"]*['"]\s*\)/.test(ctx.sourceCode);
        const hasDirectOwnerAuth = /ao\.env\.Process\.Owner/.test(ctx.sourceCode);
        if (hasAclModule || hasDirectOwnerAuth) return findings;

        // Skip if AOS-style code uses bare Owner global (not State.Owner)
        // AOS provides Owner automatically from ao.env.Process.Owner
        if (ctx.isAosStyle && !/State\.Owner/.test(ctx.sourceCode)) return findings;

        // Find the first handler that uses auth to report the error
        for (const [_name, handler] of ctx.handlers) {
          if (handler.auth.location !== "none") {
            findings.push({
              code: "OWNER_NEVER_INITIALIZED",
              message:
                "State.Owner is referenced but never properly initialized",
              severity: "critical",
              line: 1, // Top of file
              fix: "Initialize Owner: State = State or { Owner = ao.env.Process.Owner }",
            });
            break;
          }
        }
      }

      return findings;
    },
  },

  {
    id: "LOCAL_STATE_SHADOW",
    category: "auth",
    description:
      "local State = shadows global state, state won't persist across messages",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Check for local State = pattern in source
      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*local\s+State\s*=/.test(line)) {
          findings.push({
            code: "LOCAL_STATE_SHADOW",
            message:
              "local State = shadows global state - state won't persist across messages",
            severity: "critical",
            line: i + 1,
            fix: "Remove 'local' keyword: use 'State = State or {...}' for global holographic state",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "UNSAFE_OWNER_OR_PATTERN",
    category: "auth",
    description:
      "Owner set with 'or' pattern without subsequent assert verification",
    appliesToTestFile: false, // Test files don't need production auth checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Pattern: Owner = Owner or something (not Owner = ao.env.Process.Owner)
        if (
          /Owner\s*=\s*[^,}]*\s+or\s+/.test(line) &&
          !/ao\.env\.Process\.Owner/.test(line)
        ) {
          // Check if there's an assert in the next few lines
          const nextLines = lines.slice(i, i + 6).join("\n");
          const hasAssert =
            /assert\s*\(\s*State\.Owner\s*~=\s*nil/.test(nextLines) ||
            /assert\s*\(\s*[^,)]+Owner[^,)]*~=\s*nil/.test(nextLines);

          if (!hasAssert) {
            findings.push({
              code: "UNSAFE_OWNER_OR_PATTERN",
              message:
                "Owner set with 'or' pattern without assert - could remain nil",
              severity: "critical",
              line: i + 1,
              fix: "Add assert(State.Owner ~= nil, 'Owner not initialized') after assignment",
            });
          }
        }
      }

      return findings;
    },
  },

  {
    id: "MATCHER_MISSING_ACTION_TAG",
    category: "auth",
    description:
      "Handler matcher does not validate msg.Tags.Action - may trigger on unintended messages",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        const info = handler.handlerInfo;

        // Only check function matchers (hasMatchingTag already validates a tag)
        if (info.signature_type !== "function_matcher") continue;

        // Skip if action_tag was detected (matcher validates Action)
        if (info.trigger.action_tag !== null) continue;

        // Severity depends on whether handler mutates state
        const severity = handler.mutatesState ? "high" : "medium";

        findings.push({
          code: "MATCHER_MISSING_ACTION_TAG",
          message: `Handler "${name}" matcher does not validate msg.Tags.Action - may trigger on unintended messages`,
          severity,
          line: handler.startLine,
          fix: `Add in matcher: if msg.Tags.Action ~= "${name}" then return false end`,
        });
      }

      return findings;
    },
  },

  {
    id: "OWNER_EXPLICIT_NIL",
    category: "auth",
    description: "State.Owner explicitly set to nil creates nil==nil bypass vulnerability",
    appliesToTestFile: false, // Test files don't need production auth checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for Owner = nil patterns
        // Only match standalone Owner or State.Owner, not fields like contractOwner/processOwner
        if (/(?<![A-Za-z_])Owner\s*=\s*nil/.test(line)) {
          findings.push({
            code: "OWNER_EXPLICIT_NIL",
            message: "Owner = nil creates nil==nil bypass vulnerability for all auth checks",
            severity: "critical",
            line: i + 1,
            fix: "Initialize Owner from spawn: Owner = ao.env.Process.Owner",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "FIRST_CALLER_WINS_OWNER",
    category: "auth",
    description: "First message sender becomes owner - race condition vulnerability",
    appliesToTestFile: false, // Test files don't need production auth checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Pattern: State.Owner = State.Owner or msg.From
        // or: Owner = Owner or msg.From
        // This allows first caller to claim ownership
        if (/(?:State\.)?Owner\s*=\s*(?:State\.)?Owner\s+or\s+msg\.From/.test(line)) {
          findings.push({
            code: "FIRST_CALLER_WINS_OWNER",
            message: "First-caller-wins owner pattern: any caller can claim ownership before legitimate owner",
            severity: "critical",
            line: i + 1,
            fix: "Use spawn parameter: State.Owner = ao.env.Process.Owner or require explicit Init handler",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "AO_SEND_TARGET_NO_NIL_GUARD",
    category: "auth",
    description: "ao.send() with Target = msg.From without nil check",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for ao.send with Target = msg.From
        if (/ao\.send\s*\(\s*\{/.test(line) || /Target\s*=\s*msg\.From/.test(line)) {
          // Look for Target = msg.From in nearby lines
          const context = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 5)).join("\n");

          if (/Target\s*=\s*msg\.From/.test(context)) {
            // Check if there's a nil guard for msg.From in the handler
            const handlerContext = lines.slice(Math.max(0, i - 15), i + 1).join("\n");
            const hasNilGuard = /if\s+not\s+msg\.From/.test(handlerContext) ||
                               /msg\.From\s+and\s+/.test(handlerContext) ||
                               /assert\s*\(\s*msg\.From/.test(handlerContext);

            if (!hasNilGuard && /Target\s*=\s*msg\.From/.test(line)) {
              // Skip if inside a hasMatchingTag handler — msg.From is guaranteed for external messages
              const handler = findHandlerAtLine(ctx, i + 1);
              if (handler?.handlerInfo.signature_type === "hasMatchingTag") continue;

              findings.push({
                code: "AO_SEND_TARGET_NO_NIL_GUARD",
                message: "Target = msg.From without nil guard - may fail if msg.From is nil",
                severity: "medium",
                line: i + 1,
                fix: "Add guard: if not msg.From then return end before ao.send()",
              });
            }
          }
        }
      }

      return findings;
    },
  },

  {
    id: "ARBITRARY_STATE_OVERWRITE",
    category: "auth",
    description: "Dynamic key assignment to State allows overwriting critical fields like Owner",
    appliesToTestFile: false, // Test files don't need production auth checks
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Pattern: State[k] = v or State[key] = value (dynamic key from variable)
        // This allows attackers to overwrite State.Owner, State.Frozen, etc.
        if (/State\s*\[\s*\w+\s*\]\s*=/.test(line)) {
          // Check if it's a literal string key (safe) vs variable (dangerous)
          if (!/State\s*\[\s*["']/.test(line)) {
            // SAFE PATTERN 1: Nil guard - "if State[key] == nil then State[key] = value"
            // This can't overwrite existing values (Owner/Frozen set before loop)
            const prevLine = i > 0 ? lines[i - 1] : "";
            const combinedContext = prevLine + " " + line;
            if (/if\s+State\s*\[\s*\w+\s*\]\s*==\s*nil\s+then/.test(combinedContext)) {
              continue; // Safe: nil guard prevents overwriting existing Owner/Frozen
            }

            findings.push({
              code: "ARBITRARY_STATE_OVERWRITE",
              message: "Dynamic State[key] = value allows overwriting Owner/Frozen",
              severity: "critical",
              line: i + 1,
              fix: "Whitelist allowed keys: if key == 'Params' then State.Params = value end",
            });
          }
        }

        // Also catch for k,v in pairs pattern writing to State
        if (/for\s+\w+\s*,\s*\w+\s+in\s+pairs/.test(line)) {
          // Look ahead for State[k] = v pattern
          const context = lines.slice(i, Math.min(lines.length, i + 8)).join("\n");
          if (/State\s*\[\s*\w+\s*\]\s*=\s*\w+/.test(context)) {
            // SAFE PATTERN 1: Nil guard in loop body
            // "for k,v in pairs(x) do if State[k] == nil then State[k] = v end"
            if (/if\s+State\s*\[\s*\w+\s*\]\s*==\s*nil\s+then[\s\S]*?State\s*\[\s*\w+\s*\]\s*=/.test(context)) {
              continue; // Safe: nil guard prevents overwriting existing values
            }

            // SAFE PATTERN 2: Iterating over trusted source (function parameter)
            // "for k,v in pairs(defaults)" where defaults is a param, not msg.Data
            const pairsMatch = line.match(/pairs\s*\(\s*(\w+)\s*\)/);
            if (pairsMatch) {
              const iterSource = pairsMatch[1];
              // Trusted sources: function parameters like 'defaults', 'schema', 'opts'
              // Dangerous sources: 'data', 'parsed', variables from json.decode
              const trustedSources = ["defaults", "schema", "opts", "options", "config", "keys"];
              if (trustedSources.includes(iterSource)) {
                continue; // Safe: iterating over developer-provided data, not user input
              }
            }

            // SAFE PATTERN 3: Writing to result, not State
            // "for k,v in pairs(State) do result[k] = v end" - reading FROM State
            if (!/State\s*\[\s*\w+\s*\]\s*=/.test(context) ||
                /result\s*\[\s*\w+\s*\]\s*=\s*\w+/.test(context)) {
              // Check if it's actually writing to State vs reading from State
              const stateWriteMatch = context.match(/(\w+)\s*\[\s*\w+\s*\]\s*=\s*(\w+)/);
              if (stateWriteMatch && stateWriteMatch[1] !== "State") {
                continue; // Safe: writing to result/other, not State
              }
            }

            findings.push({
              code: "ARBITRARY_STATE_OVERWRITE",
              message: "Loop writes user input keys to State - can overwrite Owner/Frozen",
              severity: "critical",
              line: i + 1,
              fix: "Whitelist allowed keys instead of blindly copying all",
            });
          }
        }
      }

      return findings;
    },
  },
];
