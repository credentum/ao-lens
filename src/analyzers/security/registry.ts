/**
 * CheckRegistry
 * Manages all security checks and provides iteration
 */

import { SecurityCheck, CheckCategory } from "./types";

// Import check modules
import { authChecks } from "./checks/auth";
import { frozenChecks } from "./checks/frozen";
import { determinismChecks } from "./checks/determinism";
import { jsonChecks } from "./checks/json";
import { responseChecks } from "./checks/response";
import { styleChecks } from "./checks/style";

export class CheckRegistry {
  private categories: CheckCategory[];
  private checkMap: Map<string, SecurityCheck>;

  constructor() {
    this.categories = [
      {
        id: "auth",
        name: "Authorization",
        description: "Handler authorization and access control checks",
        checks: authChecks,
      },
      {
        id: "frozen",
        name: "Frozen State",
        description: "Frozen state handling checks",
        checks: frozenChecks,
      },
      {
        id: "determinism",
        name: "Determinism",
        description: "Replay safety and determinism checks",
        checks: determinismChecks,
      },
      {
        id: "json",
        name: "JSON Safety",
        description: "JSON parsing safety checks",
        checks: jsonChecks,
      },
      {
        id: "response",
        name: "Response",
        description: "Handler response pattern checks",
        checks: responseChecks,
      },
      {
        id: "style",
        name: "Style & Best Practices",
        description: "Code quality and AO pattern checks",
        checks: styleChecks,
      },
    ];

    // Build check map for quick lookup
    this.checkMap = new Map();
    for (const category of this.categories) {
      for (const check of category.checks) {
        this.checkMap.set(check.id, check);
      }
    }
  }

  /**
   * Get all registered checks
   */
  getChecks(): SecurityCheck[] {
    const checks: SecurityCheck[] = [];
    for (const category of this.categories) {
      checks.push(...category.checks);
    }
    return checks;
  }

  /**
   * Get checks by category
   */
  getChecksByCategory(categoryId: string): SecurityCheck[] {
    const category = this.categories.find((c) => c.id === categoryId);
    return category ? category.checks : [];
  }

  /**
   * Get a specific check by ID
   */
  getCheck(id: string): SecurityCheck | undefined {
    return this.checkMap.get(id);
  }

  /**
   * Get all categories
   */
  getCategories(): CheckCategory[] {
    return this.categories;
  }

  /**
   * Get total check count
   */
  getCheckCount(): number {
    return this.checkMap.size;
  }
}
