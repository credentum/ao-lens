/**
 * JSON Safety Checks
 * Verifies proper JSON parsing with error handling
 */

import { SecurityCheck, ProcessContext, Finding } from "../types";

/**
 * Helper to strip comments from a Lua line
 */
function stripLuaComments(line: string): string {
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

export const jsonChecks: SecurityCheck[] = [
  {
    id: "JSON_DECODE_NO_PCALL",
    category: "json",
    description:
      "json.decode() without pcall will crash on malformed JSON input",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");

      for (let i = 0; i < lines.length; i++) {
        // Strip comments before checking - avoid matching json.decode in comments
        const line = stripLuaComments(lines[i]);

        // Skip lines that don't have json.decode or .decode (for require("json").decode)
        if (!/\.decode/.test(line) && !/json\.decode/.test(line)) continue;

        // Skip if wrapped in pcall (various patterns)
        // Pattern: pcall(json.decode, ...)
        if (/pcall\s*\(\s*json\.decode/.test(line)) continue;
        // Pattern: pcall(require("json").decode, ...)
        if (/pcall\s*\(\s*require\s*\(\s*["']json["']\s*\)\.decode/.test(line)) continue;
        // Pattern: pcall(function() ... json.decode ... end)
        if (/pcall\s*\(\s*function/.test(line) && /\.decode/.test(line)) continue;

        // Skip if it's a local assignment from pcall result on same line
        if (/local\s+\w+\s*,\s*\w+\s*=\s*pcall/.test(line)) continue;

        // Skip if not actually a json decode call (could be other .decode)
        if (!/json\.decode/.test(line) && !/require\s*\(\s*["']json["']\s*\)\.decode/.test(line)) continue;

        // Check if previous lines have pcall setup (multi-line pcall)
        if (i > 0) {
          const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
          if (/pcall\s*\(\s*function/.test(context) && /\.decode/.test(context)) continue;
        }

        findings.push({
          code: "JSON_DECODE_NO_PCALL",
          message: "json.decode() without pcall crashes on malformed JSON",
          severity: "high",
          line: i + 1,
          fix: "Use: local ok, data = pcall(json.decode, msg.Data); if not ok then return end",
        });
      }

      return findings;
    },
  },

  {
    id: "JSON_ENCODE_NO_PCALL",
    category: "json",
    description:
      "json.encode() without pcall may crash on circular references or invalid data",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");

      for (let i = 0; i < lines.length; i++) {
        // Strip comments before checking - avoid matching json.encode in comments
        const line = stripLuaComments(lines[i]);

        // Skip lines that don't have json.encode or .encode
        if (!/\.encode/.test(line) && !/json\.encode/.test(line)) continue;

        // Skip if wrapped in pcall (various patterns)
        if (/pcall\s*\(\s*json\.encode/.test(line)) continue;
        if (/pcall\s*\(\s*require\s*\(\s*["']json["']\s*\)\.encode/.test(line)) continue;
        if (/pcall\s*\(\s*function/.test(line) && /\.encode/.test(line)) continue;

        // Skip if it's a local assignment from pcall result
        if (/local\s+\w+\s*,\s*\w+\s*=\s*pcall/.test(line)) continue;

        // Skip if not actually a json encode call
        if (!/json\.encode/.test(line) && !/require\s*\(\s*["']json["']\s*\)\.encode/.test(line)) continue;

        // Check if previous lines have pcall setup
        if (i > 0) {
          const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
          if (/pcall\s*\(\s*function/.test(context) && /\.encode/.test(context)) continue;
        }

        findings.push({
          code: "JSON_ENCODE_NO_PCALL",
          message:
            "json.encode() without pcall may crash on circular references",
          severity: "high",
          line: i + 1,
          fix: "Use: local ok, result = pcall(json.encode, data); if not ok then ... end",
        });
      }

      return findings;
    },
  },

  {
    id: "DUPLICATE_JSON_DECODE",
    category: "json",
    description:
      "JSON decoded twice in same handler (matcher + body) - inefficient",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      for (const [name, handler] of ctx.handlers) {
        const info = handler.handlerInfo;

        // Only check function matchers (they can contain json.decode)
        if (info.signature_type !== "function_matcher") continue;

        // Get the source lines for this handler
        const lines = ctx.sourceCode.split("\n");
        const handlerLines = lines.slice(
          handler.startLine - 1,
          handler.endLine,
        );
        const handlerSource = handlerLines.join("\n");

        // Look for json.decode in the handler source
        const decodeMatches = handlerSource.match(/json\.decode/g);
        if (decodeMatches && decodeMatches.length >= 2) {
          findings.push({
            code: "DUPLICATE_JSON_DECODE",
            message: `Handler "${name}" decodes JSON ${decodeMatches.length} times - parse once and pass via closure or msg.Tags`,
            severity: "low",
            line: handler.startLine,
            fix: "Parse JSON once in matcher, store result, access in handler body",
          });
        }
      }

      return findings;
    },
  },

  {
    id: "MSG_DATA_NO_JSON_DECODE",
    category: "json",
    description:
      "Handler likely receives JSON in msg.Data but never parses it",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      // Patterns that indicate a handler expecting data payload
      const dataHandlerPatterns = [
        /^Update/i, /^Set/i, /^Create/i, /^Add/i, /^Modify/i,
        /^Submit/i, /^Register/i, /^Configure/i, /^Init/i,
      ];

      for (const [name, handler] of ctx.handlers) {
        // Skip Safe library handlers - they parse JSON internally
        if (handler.isSafeLibrary) continue;

        // Check if handler name suggests it receives data
        const expectsData = dataHandlerPatterns.some(p => p.test(name));
        if (!expectsData) continue;

        // Get handler source
        const lines = ctx.sourceCode.split("\n");
        const handlerLines = lines.slice(
          handler.startLine - 1,
          handler.endLine,
        );
        const handlerSource = handlerLines.join("\n");

        // Check if handler has json.decode anywhere
        const hasJsonDecode = /json\.decode/.test(handlerSource);
        if (hasJsonDecode) continue;

        // Check if handler uses msg.Data (even indirectly)
        const usesMsgData = /msg\.Data/.test(handlerSource);

        // Flag if handler name suggests data payload but no json.decode
        // Even if msg.Data isn't accessed (might be a bug - data is expected but ignored)
        findings.push({
          code: "MSG_DATA_NO_JSON_DECODE",
          message: `Handler "${name}" likely expects JSON data but doesn't parse msg.Data`,
          severity: usesMsgData ? "high" : "medium",
          line: handler.startLine,
          fix: "Add: local ok, data = pcall(json.decode, msg.Data); if not ok then return end",
        });
      }

      return findings;
    },
  },

  {
    id: "SILENT_PCALL_FAILURE",
    category: "json",
    description:
      "pcall failure is silently ignored - user won't know what went wrong",
    run(ctx: ProcessContext): Finding[] {
      const findings: Finding[] = [];

      const lines = ctx.sourceCode.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Look for pcall with json operations
        if (!/pcall\s*\(\s*json\.(decode|encode)/.test(line)) continue;

        // Check if there's error handling in next few lines
        const nextLines = lines.slice(i, i + 5).join("\n");
        const hasErrorHandling =
          /if\s+not\s+ok/.test(nextLines) ||
          /ao\.send.*Error/.test(nextLines) ||
          /msg\.reply.*Error/.test(nextLines) ||
          /return.*nil/.test(nextLines) ||
          /return\s*$/.test(nextLines) ||
          /return\s+false/.test(nextLines);

        if (!hasErrorHandling) {
          findings.push({
            code: "SILENT_PCALL_FAILURE",
            message: "pcall failure is silently ignored",
            severity: "info",
            line: i + 1,
            fix: "Add: if not ok then ao.send({Target=msg.From, Action='Error', Data='Invalid JSON'}) return end",
          });
        }
      }

      return findings;
    },
  },
];
