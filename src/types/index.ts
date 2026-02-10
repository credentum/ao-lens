/**
 * ao-lens type definitions
 * Schema version: 1.5
 */

export const SCHEMA_VERSION = "1.5";

// Base output structure with schema versioning
export interface BaseOutput {
  schema_version: string;
  timestamp: string;
}

// AST Foundation types
export interface FunctionDefinition {
  name: string;
  line: number;
  end_line: number;
  params: string[];
  is_local: boolean;
}

export interface GlobalAssignment {
  name: string;
  line: number;
  value_type: "table" | "function" | "string" | "number" | "boolean" | "nil" | "unknown";
  initial_value?: string;
}

export interface ParseResult extends BaseOutput {
  file: string;
  success: boolean;
  error?: {
    message: string;
    line?: number;
    column?: number;
  };
  functions: FunctionDefinition[];
  globals: GlobalAssignment[];
  handlers: HandlerInfo[];
  state_analysis: FileStateAnalysis;
  /** Raw source code for pattern-based security checks */
  sourceCode?: string;
  stats: {
    total_lines: number;
    function_count: number;
    global_count: number;
    handler_count: number;
    state_write_count: number;
    ao_send_count: number;
    determinism_issue_count: number;
    parse_time_ms: number;
  };
}

// Handler types
export interface HandlerTrigger {
  action_tag: string | null;
  required_tags: Record<string, string>;
  checks_from: boolean;
  checks_data: boolean;
  checks_frozen: boolean;
}

export interface MatcherAnalysis {
  type: "inline_function" | "hasMatchingTag" | "always_true" | "complex";
  strictness: "loose" | "moderate" | "strict";
  validates_schema: boolean;
  checks_authorization: boolean;
}

export interface SafeLibraryOptions {
  owner: boolean;
  frozen: boolean;
  public: boolean;
}

export interface HandlerInfo {
  name: string;
  line: number;
  end_line: number;
  signature_type: "function_matcher" | "hasMatchingTag" | "table" | "safe_handler" | "safe_query";
  trigger: HandlerTrigger;
  matcher_analysis: MatcherAnalysis;
  has_handler_body: boolean;
  is_safe_library: boolean;
  safe_options?: SafeLibraryOptions;
}

// State tracking types
export interface StateAccessEntry {
  field: string;
  type: "read" | "write";
  line: number;
}

export interface MessageSendEntry {
  target: string;
  target_type: "static" | "dynamic";
  action: string | null;
  line: number;
}

export interface MsgFieldUsage {
  field: string;
  line: number;
}

export interface DeterminismViolation {
  type: "os_time" | "math_random" | "io_call";
  line: number;
  code: string;
  suggestion: string;
}

export interface FileStateAnalysis {
  state_mutations: StateAccessEntry[];
  ao_sends: MessageSendEntry[];
  determinism_issues: DeterminismViolation[];
}

// CLI output types
export interface CLIOutput {
  format: "json" | "pretty";
  data: ParseResult;
}

// IPC Topology types
export interface ProcessInfo {
  name: string;
  file: string;
  handlers: string[];
  sends: MessageSendEntry[];
}

export interface MessageFlow {
  from: string;
  to: string;
  action: string;
  line: number;
  file: string;
}

export interface SpawnRelationship {
  parent: string;
  child: string;
  line: number;
  file: string;
}

export interface IPCGraphResult extends BaseOutput {
  processes: ProcessInfo[];
  message_flows: MessageFlow[];
  spawn_relationships: SpawnRelationship[];
  summary: {
    process_count: number;
    handler_count: number;
    message_flow_count: number;
    spawn_count: number;
    action_types: string[];
    targets: string[];
  };
  mermaid?: string;
}

// Agent-Driven Semantic Exploration types

/** Output for get_function_details tool */
export interface FunctionDetails {
  name: string;
  line: number;
  end_line: number;
  params: string[];
  is_local: boolean;
  source_snippet: string;
  body_analysis: {
    calls: string[];
    reads_state: boolean;
    writes_state: boolean;
    ao_sends: string[];
  };
}

/** Output for get_handler_body tool */
export interface HandlerBodyResult {
  handler_name: string;
  line: number;
  end_line: number;
  matcher_source: string;
  body_source: string;
  body_analysis: {
    validates_auth: boolean;
    auth_pattern: "assert" | "conditional" | "mixed" | "safe_library" | "none";
    checks_frozen: boolean;
    parses_json: boolean;
    json_is_pcalled: boolean;
    state_reads: string[];
    state_writes: string[];
    ao_sends: Array<{
      target: string;
      action: string | null;
    }>;
    local_functions_called: string[];
  };
}

/** Entry for state field usage */
export interface StateUsageEntry {
  file: string;
  line: number;
  handler: string | null;
  code_snippet: string;
}

/** Output for find_state_usage tool */
export interface StateUsageResult {
  state_field: string;
  reads: StateUsageEntry[];
  writes: StateUsageEntry[];
  summary: {
    total_reads: number;
    total_writes: number;
    handlers_reading: string[];
    handlers_writing: string[];
  };
}

/** Filters for query_handlers tool */
export interface HandlerQueryFilters {
  action_pattern?: string;
  name_pattern?: string;
  has_auth?: boolean;
  has_frozen_check?: boolean;
  mutates_state?: boolean;
  strictness?: "loose" | "moderate" | "strict";
}

/** Handler entry in query result */
export interface HandlerQueryEntry {
  file: string;
  name: string;
  line: number;
  action: string | null;
  strictness: "loose" | "moderate" | "strict";
  has_auth: boolean;
  has_frozen_check: boolean;
  mutates_state: boolean;
}

/** Output for query_handlers tool */
export interface HandlerQueryResult {
  filters: HandlerQueryFilters;
  handlers: HandlerQueryEntry[];
  total: number;
}
