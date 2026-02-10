/**
 * Style and Best Practice Checks
 * Lower severity checks for code quality and AO patterns
 */

import { SecurityCheck, ProcessContext, Finding } from "../types";

export const styleChecks: SecurityCheck[] = [
  {
    id: "MATCHER_NO_ACTION_CHECK",
    category: "style",
    description: "Matcher doesn't check Action tag on mutating handler",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        const info = handler.handlerInfo;

        // Skip if handler has action tag from any pattern
        if (info.trigger.action_tag) continue;

        // Skip hasMatchingTag pattern (explicitly checks action)
        if (info.matcher_analysis.type === "hasMatchingTag") continue;

        // Skip table matchers like { Action = "Update" } - these check action
        if (info.signature_type === "table") continue;

        // Only flag mutating handlers with inline function matchers that don't check action
        if (handler.mutatesState && info.signature_type === "function_matcher") {
          findings.push({
            code: "MATCHER_NO_ACTION_CHECK",
            message: `Handler "${name}" doesn't verify msg.Tags.Action`,
            severity: "medium",
            line: handler.startLine,
            fix: "Add action check: if msg.Tags.Action ~= 'ExpectedAction' then return false end",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "NO_SCHEMA_VALIDATION",
    category: "style",
    description: "Handler reads msg.Data but doesn't validate schema",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        const info = handler.handlerInfo;

        // Method 1: Check via handlerInfo triggers
        if (
          info.trigger.checks_data &&
          !info.matcher_analysis.validates_schema
        ) {
          findings.push({
            code: "NO_SCHEMA_VALIDATION",
            message: `Handler "${name}" reads msg.Data without schema validation`,
            severity: "medium",
            line: handler.startLine,
            fix: "Validate data structure: if type(data.field) ~= 'expected' then return false end",
          });
          continue;
        }

        // Method 2: Direct source check - look for json.decode without type() checks
        // This catches cases where msg.Data is parsed but field types aren't validated
        const lines = ctx.sourceCode.split("\n");
        const handlerLines = lines.slice(
          handler.startLine - 1,
          handler.endLine,
        );
        const handlerSource = handlerLines.join("\n");

        // Check if handler parses JSON (pcall json.decode or direct json.decode)
        const parsesJson = /json\.decode/.test(handlerSource);
        if (!parsesJson) continue;

        // Check if there are type validations after parsing
        const hasTypeCheck = /type\s*\([^)]+\)\s*[~=]=\s*["'](?:number|string|table|boolean)["']/.test(handlerSource);
        const hasAssertType = /assert\s*\(\s*type\s*\(/.test(handlerSource);

        // Only flag mutating handlers that parse JSON but don't validate types
        if (handler.mutatesState && !hasTypeCheck && !hasAssertType) {
          findings.push({
            code: "NO_SCHEMA_VALIDATION",
            message: `Handler "${name}" parses JSON but doesn't validate field types`,
            severity: "medium",
            line: handler.startLine,
            fix: "Add type validation: if type(data.field) ~= 'number' then return end",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "ALWAYS_TRUE_MATCHER",
    category: "style",
    description: "Handler matcher always returns true (catches all messages)",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        if (handler.handlerInfo.matcher_analysis.type === "always_true") {
          findings.push({
            code: "ALWAYS_TRUE_MATCHER",
            message: `Handler "${name}" has always-true matcher`,
            severity: "low",
            line: handler.startLine,
            fix: "Add specific action check to prevent catching unrelated messages",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "MSG_TAGS_NO_NIL_GUARD",
    category: "style",
    description: "msg.Tags accessed without nil guard",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for direct msg.Tags.X access
        if (/msg\.Tags\.[A-Za-z_]/.test(line)) {
          // Check if there's a guard on this or previous lines
          const context = lines.slice(Math.max(0, i - 2), i + 1).join("\n");
          const hasGuard =
            /msg\.Tags\s*and\s*msg\.Tags\./.test(context) ||
            /if\s+not\s+msg\.Tags/.test(context) ||
            /msg\.Tags\s*~=\s*nil/.test(context);

          if (!hasGuard) {
            findings.push({
              code: "MSG_TAGS_NO_NIL_GUARD",
              message: "msg.Tags accessed without nil guard",
              severity: "low",
              line: i + 1,
              fix: "Add guard: if not msg.Tags then return false end",
            });
          }
        }
      }

      return findings;
    },
  },

  {
    id: "MSG_ACTION_DIRECT_ACCESS",
    category: "style",
    description: "Use msg.Tags.Action instead of msg.Action",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/msg\.Action\b/.test(line) && !/msg\.Tags\.Action/.test(line)) {
          findings.push({
            code: "MSG_ACTION_DIRECT_ACCESS",
            message: "Use msg.Tags.Action instead of msg.Action",
            severity: "high",
            line: i + 1,
            fix: "Change to msg.Tags.Action",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "MSG_UNKNOWN_PROPERTY",
    category: "style",
    description: "Accessing non-standard msg property",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const knownProps = [
        "From",
        "Owner",
        "Id",
        "Data",
        "Tags",
        "Timestamp",
        "Target",
        "Cron",
        "Epoch",
        "Nonce",
        "Block-Height",
        "Hash-Chain",
        "reply",
      ];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/msg\.([A-Za-z_][A-Za-z0-9_-]*)/g);
        if (match) {
          for (const m of match) {
            const prop = m.replace("msg.", "");
            if (prop === "Tags") continue; // Tags is valid
            if (!knownProps.includes(prop)) {
              findings.push({
                code: "MSG_UNKNOWN_PROPERTY",
                message: `Unknown msg property: ${prop}`,
                severity: "high",
                line: i + 1,
                fix: `Use standard msg properties: ${knownProps.slice(0, 5).join(", ")}...`,
              });
            }
          }
        }
      }

      return findings;
    },
  },

  {
    id: "TONUMBER_NO_NIL_CHECK",
    category: "style",
    description: "tonumber() result not checked for nil",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/tonumber\s*\(/.test(line)) {
          const context = lines.slice(i, i + 3).join("\n");
          const hasNilCheck =
            /if\s+not\s+\w+\s+then/.test(context) ||
            /~=\s*nil/.test(context) ||
            /or\s+\d+/.test(line); // Default value pattern

          if (!hasNilCheck) {
            findings.push({
              code: "TONUMBER_NO_NIL_CHECK",
              message: "tonumber() result not checked for nil",
              severity: "high",
              line: i + 1,
              fix: "Add nil check: local num = tonumber(x); if not num then return end",
            });
          }
        }
      }

      return findings;
    },
  },

  {
    id: "NO_NAN_INFINITY_CHECK",
    category: "style",
    description: "Numeric calculations without NaN/Infinity checks",
    appliesToTestFile: false, // Test files may have intentional edge case divisions
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Only flag if there are division operations
      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // Strip Lua comments before checking (avoid false positives on file paths in comments)
        const commentIndex = line.indexOf("--");
        if (commentIndex !== -1) {
          line = line.substring(0, commentIndex);
        }

        // Check for division that could produce NaN/Inf
        // More specific regex: requires expression context (word/number before and after /)
        // This avoids matching / in strings or other non-division contexts
        if (/\w+\s*\/\s*\w+/.test(line) && !/\w+\s*\/\s*\d+/.test(line)) {
          const context = lines.slice(i, i + 5).join("\n");
          const hasCheck =
            /math\.huge/.test(context) ||
            /~=\s*math\.huge/.test(context) ||
            /isnan/.test(context) ||
            /==\s*0/.test(context); // Division by zero check

          if (!hasCheck) {
            findings.push({
              code: "NO_NAN_INFINITY_CHECK",
              message: "Division result not checked for NaN/Infinity",
              severity: "low",
              line: i + 1,
              fix: "Add check: if result ~= result then ... end (NaN check)",
            });
          }
        }
      }

      return findings;
    },
  },

  {
    id: "INFO_LEAK_SENDER_ADDRESS",
    category: "style",
    description: "Sender address may be leaked in error messages",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for msg.From in string concatenation or format
        if (
          /["'].*msg\.From/.test(line) ||
          /tostring\s*\(\s*msg\.From/.test(line) ||
          /\.\..*msg\.From/.test(line)
        ) {
          findings.push({
            code: "INFO_LEAK_SENDER_ADDRESS",
            message: "Sender address may be leaked in output",
            severity: "low",
            line: i + 1,
            fix: "Avoid including msg.From in error messages",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "INFO_LEAK_INPUT_DATA",
    category: "style",
    description: "Input data may be leaked in error messages",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for msg.Data in string output
        if (
          /tostring\s*\(\s*msg\.Data/.test(line) ||
          /\.\..*msg\.Data/.test(line) ||
          /json\.encode.*msg\.Data/.test(line)
        ) {
          findings.push({
            code: "INFO_LEAK_INPUT_DATA",
            message: "Input data may be leaked in output",
            severity: "low",
            line: i + 1,
            fix: "Avoid including raw msg.Data in error messages",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "HANDLER_NO_STATE_MUTATION",
    category: "style",
    description: "Handler name suggests mutation but body doesn't modify State",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Patterns that strongly indicate the handler should mutate state
      const mutatingPatterns = [
        /^Update/i, /^Set/i, /^Delete/i, /^Remove/i, /^Add/i, /^Create/i,
        /^Modify/i, /^Change/i, /^Edit/i, /^Write/i, /^Save/i, /^Store/i,
        /^Transfer/i, /^Mint/i, /^Burn/i, /^Register/i, /^Deregister/i,
      ];

      for (const [name, handler] of ctx.handlers) {
        // Check if handler name suggests mutation
        const isMutatingName = mutatingPatterns.some(p => p.test(name));
        if (!isMutatingName) continue;

        // Check if handler actually mutates state
        if (handler.mutatesState) continue;

        // Get handler source to check for ao.send (at least confirms it's not empty)
        const lines = ctx.sourceCode.split("\n");
        const handlerLines = lines.slice(
          handler.startLine - 1,
          handler.endLine,
        );
        const handlerSource = handlerLines.join("\n");

        // Check if handler has any State. assignments
        const hasStateWrite = /State\s*\.\s*\w+\s*=/.test(handlerSource) ||
                              /State\s*\[\s*["']?\w+/.test(handlerSource);

        if (!hasStateWrite) {
          findings.push({
            code: "HANDLER_NO_STATE_MUTATION",
            message: `Handler "${name}" suggests mutation but doesn't modify State`,
            severity: "medium",
            line: handler.startLine,
            fix: "Handler body should update State (e.g., State.Value = data.value)",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "NO_TIMESTAMP_TRACKING",
    category: "style",
    description: "Mutating handler doesn't record msg.Timestamp for audit trail",
    appliesToTestFile: false, // Test files don't need production audit trails
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Patterns that indicate a handler that modifies state
      const mutatingPatterns = [
        /^Update/i, /^Set/i, /^Delete/i, /^Remove/i, /^Add/i, /^Create/i,
        /^Modify/i, /^Change/i, /^Transfer/i, /^Mint/i, /^Burn/i,
      ];

      for (const [name, handler] of ctx.handlers) {
        // Check if handler is mutating by name or by actual state writes
        const isMutatingByName = mutatingPatterns.some(p => p.test(name));
        if (!isMutatingByName && !handler.mutatesState) continue;

        // Get handler source
        const lines = ctx.sourceCode.split("\n");
        const handlerLines = lines.slice(
          handler.startLine - 1,
          handler.endLine,
        );
        const handlerSource = handlerLines.join("\n");

        // Check if handler records timestamp
        // Safe.audit() internally records msg.Timestamp, so recognize it as well
        const recordsTimestamp = /msg\.Timestamp/.test(handlerSource) ||
                                  /Timestamp\s*=/.test(handlerSource) ||
                                  /UpdatedAt\s*=/.test(handlerSource) ||
                                  /LastModified\s*=/.test(handlerSource) ||
                                  /Safe\.audit\s*\(/.test(handlerSource);

        if (!recordsTimestamp) {
          findings.push({
            code: "NO_TIMESTAMP_TRACKING",
            message: `Handler "${name}" doesn't record msg.Timestamp for replay audit trail`,
            severity: "low",
            line: handler.startLine,
            fix: "Add: State.LastUpdated = msg.Timestamp",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "NO_BOUNDS_DEFINED",
    category: "style",
    description: "Handler updates parameters without any bounds defined",
    appliesToTestFile: false, // Test files don't need production bounds validation
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Check if bounds are defined or validated anywhere (case-insensitive for local vars)
      const hasBounds = /State\s*\.?\s*Bounds\s*=/i.test(ctx.sourceCode) ||
                        /Bounds\s*=\s*\{/i.test(ctx.sourceCode) ||
                        /PARAM_BOUNDS\s*=/i.test(ctx.sourceCode) ||
                        /local\s+bounds\s*=/i.test(ctx.sourceCode) ||
                        /Safe\.validateBounds\s*\(/i.test(ctx.sourceCode);  // Inline bounds validation

      if (hasBounds) return findings; // Bounds exist or validated inline

      // Look for handlers that update numeric parameters
      for (const [name, handler] of ctx.handlers) {
        // Check handlers that might update params
        const mutatingPatterns = [/^Update/i, /^Set/i, /^Modify/i, /^Configure/i];
        const isMutating = mutatingPatterns.some(p => p.test(name));
        if (!isMutating) continue;

        // Get handler source
        const lines = ctx.sourceCode.split("\n");
        const handlerLines = lines.slice(
          handler.startLine - 1,
          handler.endLine,
        );
        const handlerSource = handlerLines.join("\n");

        // Check if handler updates State.Params or similar
        const updatesParams = /State\s*\.\s*Params\s*=/.test(handlerSource) ||
                             /State\s*\[\s*["']Params["']\s*\]/.test(handlerSource) ||
                             /Kp\s*=.*data/.test(handlerSource) ||
                             /Ki\s*=.*data/.test(handlerSource) ||
                             /Kd\s*=.*data/.test(handlerSource);

        if (updatesParams) {
          findings.push({
            code: "NO_BOUNDS_DEFINED",
            message: `Handler "${name}" updates parameters but no bounds are defined`,
            severity: "medium",
            line: handler.startLine,
            fix: "Define bounds: local BOUNDS = { Kp = {min=0, max=100}, ... } and validate",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "BOUNDS_DEFINED_NOT_ENFORCED",
    category: "style",
    description: "State.Bounds is defined but not checked when updating values",
    appliesToTestFile: false, // Test files don't need production bounds enforcement
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Check if State.Bounds is defined
      const hasBounds = /State\s*\.?\s*Bounds\s*=/.test(ctx.sourceCode) ||
                        /Bounds\s*=\s*\{/.test(ctx.sourceCode);

      if (!hasBounds) return findings;

      // Check for mutating handlers
      for (const [name, handler] of ctx.handlers) {
        // Only check handlers that might update params
        const mutatingPatterns = [/^Update/i, /^Set/i, /^Modify/i];
        const isMutating = mutatingPatterns.some(p => p.test(name));
        if (!isMutating) continue;

        // Get handler source
        const lines = ctx.sourceCode.split("\n");
        const handlerLines = lines.slice(
          handler.startLine - 1,
          handler.endLine,
        );
        const handlerSource = handlerLines.join("\n");

        // Check if handler references Bounds for validation
        const checksBounds = /Bounds/.test(handlerSource) &&
                            (/min/.test(handlerSource) || /max/.test(handlerSource));

        if (!checksBounds) {
          findings.push({
            code: "BOUNDS_DEFINED_NOT_ENFORCED",
            message: `Handler "${name}" doesn't check State.Bounds - values can exceed limits`,
            severity: "medium",
            line: handler.startLine,
            fix: "Add bounds check: assert(value >= Bounds.min and value <= Bounds.max)",
          });
        }
      }

      return findings;
    },
  },
];
