/**
 * RuleLoader - Load detection rules from skill YAML files
 *
 * This module enables ao-lens to dynamically load anti-pattern detection rules
 * from skill YAML files, allowing skills to define their own security checks.
 *
 * Detection types:
 * - handler_analysis: Check handler name and body patterns
 * - regex: Source code pattern matching with optional follow-up
 * - prompt_only: Cannot detect statically (skip these)
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { glob } from "glob";

/**
 * Auto-detect skills directory by walking up from a starting path
 * Looks for: skills/ or uses AO_LENS_SKILLS_DIR env var
 *
 * @param startPath Starting path (usually the file being analyzed)
 * @returns Path to skills directory, or null if not found
 */
export function findSkillsDir(startPath: string): string | null {
  // Check environment variable first
  // Empty string means "disable auto-detection"
  if (process.env.AO_LENS_SKILLS_DIR !== undefined) {
    const envPath = process.env.AO_LENS_SKILLS_DIR;
    if (envPath === "") {
      return null; // Explicitly disabled
    }
    if (fs.existsSync(envPath)) {
      return envPath;
    }
  }

  // Walk up directory tree looking for skills/
  let dir = path.resolve(startPath);

  // If startPath is a file, start from its directory
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) {
    dir = path.dirname(dir);
  }

  for (let i = 0; i < 15; i++) {
    // Check for skills/ directly
    const skillsPath = path.join(dir, "skills");
    if (fs.existsSync(skillsPath) && fs.statSync(skillsPath).isDirectory()) {
      // Verify it has ao/ or hyperbeam/ subdirectories
      const hasAo = fs.existsSync(path.join(skillsPath, "ao"));
      const hasHyperbeam = fs.existsSync(path.join(skillsPath, "hyperbeam"));
      if (hasAo || hasHyperbeam) {
        return skillsPath;
      }
    }

    // Move up one directory
    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      // Reached root
      break;
    }
    dir = parentDir;
  }

  return null;
}

/**
 * Detection configuration for handler_analysis type
 */
export interface HandlerAnalysisDetection {
  type: "handler_analysis";
  handler_name_contains?: string[];
  handler_name_not_contains?: string[];
  body_matches: string;
}

/**
 * Detection configuration for regex type
 */
export interface RegexDetection {
  type: "regex";
  pattern: string;
  requires_following?: string;
  /** Check same line + preceding lines for guard pattern (for inline nil guards) */
  requires_context?: string;
  lines_to_check?: number;
}

/**
 * Detection configuration for prompt_only type (not detectable)
 */
export interface PromptOnlyDetection {
  type: "prompt_only";
}

export type Detection =
  | HandlerAnalysisDetection
  | RegexDetection
  | PromptOnlyDetection;

/**
 * A detection rule loaded from a skill YAML
 */
export interface DetectionRule {
  id: string;
  skillId: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  detection: Detection;
  techStack: string[];
}

/**
 * Structured anti-pattern from skill YAML
 */
interface StructuredAntiPattern {
  id: string;
  description: string;
  severity?: string;
  detection?: Detection;
  bad_code?: string;
  good_code?: string;
}

/**
 * Skill YAML structure
 */
interface SkillYaml {
  skill_id: string;
  title: string;
  domain: string;
  tech_stack: string[];
  anti_patterns?: (string | StructuredAntiPattern)[];
}

/**
 * RuleLoader loads detection rules from skill YAML files
 */
export class RuleLoader {
  private rules: DetectionRule[] = [];
  private loaded = false;

  /**
   * Load rules from a skills directory
   *
   * @param skillsPath Path to skills directory
   * @returns Number of rules loaded
   */
  async loadFromSkillsDirectory(skillsPath: string): Promise<number> {
    const resolvedPath = path.resolve(skillsPath);

    if (!fs.existsSync(resolvedPath)) {
      console.error(`Skills directory not found: ${resolvedPath}`);
      return 0;
    }

    // Find all skill YAML files (excluding _archive directories)
    const pattern = path.join(resolvedPath, "**", "skill_*.yaml");
    const allFiles = await glob(pattern, {
      ignore: ["**/_archive/**", "**/archive/**", "**/.archive/**"],
    });

    // Post-filter to ensure _archive exclusion (glob v10 ignore can be unreliable)
    const skillFiles = allFiles.filter(f =>
      !f.includes("/_archive/") &&
      !f.includes("/archive/") &&
      !f.includes("/.archive/")
    );

    let rulesLoaded = 0;

    for (const file of skillFiles) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const skill = yaml.parse(content) as SkillYaml;

        if (!skill.skill_id || !skill.anti_patterns) {
          continue;
        }

        for (const ap of skill.anti_patterns) {
          // Skip legacy string anti-patterns
          if (typeof ap === "string") {
            continue;
          }

          // Skip prompt_only detection (not automatable)
          if (!ap.detection || ap.detection.type === "prompt_only") {
            continue;
          }

          const rule: DetectionRule = {
            id: ap.id,
            skillId: skill.skill_id,
            description: ap.description,
            severity: (ap.severity as DetectionRule["severity"]) || "high",
            detection: ap.detection,
            techStack: skill.tech_stack || [],
          };

          this.rules.push(rule);
          rulesLoaded++;
        }
      } catch (error) {
        console.error(`Error parsing skill file ${file}:`, error);
      }
    }

    this.loaded = true;
    return rulesLoaded;
  }

  /**
   * Get all loaded rules
   */
  getRules(): DetectionRule[] {
    return this.rules;
  }

  /**
   * Get rules filtered by tech stack
   *
   * @param techStack Tech stack to filter by (e.g., ["lua", "ao"])
   * @returns Rules matching the tech stack
   */
  getRulesForTechStack(techStack: string[]): DetectionRule[] {
    const stackSet = new Set(techStack.map((t) => t.toLowerCase()));

    return this.rules.filter((rule) => {
      // Rule matches if any of its tech_stack items match
      return rule.techStack.some((t) => stackSet.has(t.toLowerCase()));
    });
  }

  /**
   * Get rules filtered by severity
   *
   * @param minSeverity Minimum severity level
   * @returns Rules at or above the severity level
   */
  getRulesBySeverity(
    minSeverity: "critical" | "high" | "medium" | "low"
  ): DetectionRule[] {
    const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    const minLevel = severityOrder[minSeverity];

    return this.rules.filter((rule) => {
      return severityOrder[rule.severity] >= minLevel;
    });
  }

  /**
   * Check if rules have been loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Get count of loaded rules
   */
  getRuleCount(): number {
    return this.rules.length;
  }

  /**
   * Clear all loaded rules
   */
  clear(): void {
    this.rules = [];
    this.loaded = false;
  }

  /**
   * Print summary of loaded rules
   */
  printSummary(): void {
    console.log(`\nLoaded ${this.rules.length} detection rules:`);

    const byType = new Map<string, number>();
    const bySeverity = new Map<string, number>();

    for (const rule of this.rules) {
      const type = rule.detection.type;
      byType.set(type, (byType.get(type) || 0) + 1);
      bySeverity.set(rule.severity, (bySeverity.get(rule.severity) || 0) + 1);
    }

    console.log("\nBy detection type:");
    for (const [type, count] of byType) {
      console.log(`  ${type}: ${count}`);
    }

    console.log("\nBy severity:");
    for (const [severity, count] of bySeverity) {
      console.log(`  ${severity}: ${count}`);
    }

    console.log("\nRules:");
    for (const rule of this.rules) {
      console.log(`  [${rule.severity.toUpperCase()}] ${rule.id}`);
      console.log(`    Skill: ${rule.skillId}`);
      console.log(`    Type: ${rule.detection.type}`);
    }
  }
}
