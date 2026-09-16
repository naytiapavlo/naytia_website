/**
 * 逆向工作台的前端类型与 API 客户端（docs/plans/07）。
 * 类型与 backend/app/reverse/schemas.py 一一对应；字段变更时两边一起改。
 */
import { apiFetch } from '../../shared/api-client';

export interface IdaInstance {
  host: string;
  port: number;
  pid: number | null;
  binary: string | null;
  idb_path: string | null;
  started_at: string | null;
  reachable: boolean;
  active: boolean;
}

export interface IdaStatus {
  reachable: boolean;
  error: string | null;
  code: string | null;
  idb_path: string | null;
  module: string | null;
  input_path: string | null;
  imagebase: string | null;
  auto_analysis_ready: boolean | null;
  hexrays_ready: boolean | null;
  strings_cache_ready: boolean | null;
  uptime_sec: number | null;
}

export interface SegmentInfo {
  name: string;
  start: string;
  end: string;
  size: string;
  permissions: string | null;
}

export interface BinaryOverview {
  module: string | null;
  path: string | null;
  arch: string | null;
  base_address: string | null;
  image_size: string | null;
  total_functions: number | null;
  named_functions: number | null;
  library_functions: number | null;
  unnamed_functions: number | null;
  total_strings: number | null;
  total_segments: number | null;
  segments: SegmentInfo[];
}

export interface FunctionSummary {
  addr: string;
  name: string;
  size: string | null;
}

export interface FunctionPage {
  items: FunctionSummary[];
  next_offset: number | null;
  total: number | null;
}

export interface DisasmLine {
  addr: string;
  instruction: string;
  label: string | null;
}

export interface StackVar {
  name: string;
  offset: string | null;
  size: string | null;
  type: string | null;
}

export interface Disassembly {
  addr: string;
  name: string | null;
  start_ea: string | null;
  segment: string | null;
  lines: DisasmLine[];
  stack_frame: StackVar[];
  total: number | null;
}

export interface XrefItem {
  addr: string;
  type: string | null;
  fn: string | null;
  fn_name: string | null;
}

export interface XrefGroup {
  addr: string;
  xrefs: XrefItem[];
  more: boolean;
  error: string | null;
}

export interface CalleeItem {
  addr: string;
  name: string | null;
  type: string | null;
}

export interface CalleeGroup {
  addr: string;
  callees: CalleeItem[];
  more: boolean;
  error: string | null;
}

export interface BasicBlock {
  start: string;
  end: string | null;
  size: number | null;
  type: number | null;
  successors: string[];
  predecessors: string[];
}

export interface BlockGroup {
  addr: string;
  blocks: BasicBlock[];
  count: number | null;
  total_blocks: number | null;
  error: string | null;
}

export interface Pseudocode {
  addr: string;
  code: string;
  error: string | null;
}

export interface StringMatch {
  addr: string;
  string: string;
}

export interface StringSearchResult {
  total: number;
  matches: StringMatch[];
}

export interface ReversePermissions {
  role: 'member' | 'admin' | 'superadmin' | null;
  can_write: boolean;
}

/** 所有请求都带上当前实例端口；port 为 null 表示沿用 MCP 当前实例。 */
function withPort(path: string, port: number | null, extra: Record<string, string | number | boolean | undefined> = {}): string {
  const params = new URLSearchParams();
  if (port !== null) params.set('port', String(port));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export const reverseApi = {
  status: (port: number | null) => apiFetch<IdaStatus>(withPort('/api/reverse/status', port)),

  instances: () => apiFetch<IdaInstance[]>('/api/reverse/instances'),

  permissions: () => apiFetch<ReversePermissions>('/api/reverse/permissions'),

  overview: (port: number | null) => apiFetch<BinaryOverview>(withPort('/api/reverse/overview', port)),

  functions: (port: number | null, offset: number, count: number, filter?: string) =>
    apiFetch<FunctionPage>(withPort('/api/reverse/functions', port, { offset, count, filter })),

  lookup: (port: number | null, queries: string[]) => {
    const params = new URLSearchParams();
    if (port !== null) params.set('port', String(port));
    for (const query of queries) params.append('q', query);
    return apiFetch<FunctionSummary[]>(`/api/reverse/functions/lookup?${params.toString()}`);
  },

  decompile: (port: number | null, addr: string, includeAddresses = true) =>
    apiFetch<Pseudocode>(
      withPort('/api/reverse/decompile', port, { addr, include_addresses: includeAddresses }),
    ),

  disasm: (port: number | null, addr: string, offset = 0, maxInstructions = 2000) =>
    apiFetch<Disassembly>(
      withPort('/api/reverse/disasm', port, { addr, offset, max_instructions: maxInstructions }),
    ),

  xrefs: (port: number | null, addr: string, direction: 'to' | 'from' | 'both' = 'to', limit = 200) =>
    apiFetch<XrefGroup[]>(withPort('/api/reverse/xrefs', port, { addr, direction, limit })),

  callees: (port: number | null, addr: string, limit = 200) =>
    apiFetch<CalleeGroup[]>(withPort('/api/reverse/callees', port, { addr, limit })),

  blocks: (port: number | null, addr: string, maxBlocks = 500) =>
    apiFetch<BlockGroup[]>(withPort('/api/reverse/blocks', port, { addr, max_blocks: maxBlocks })),

  searchStrings: (port: number | null, pattern: string, limit = 50, offset = 0) =>
    apiFetch<StringSearchResult>(
      withPort('/api/reverse/search/strings', port, { pattern, limit, offset }),
    ),

  searchText: (port: number | null, pattern: string, limit = 50, start?: string, regex = false) =>
    apiFetch<{ hits: Array<{ addr: string; text: string; kind: string | null }>; next_start: string | null }>(
      withPort('/api/reverse/search/text', port, { pattern, limit, start, regex }),
    ),

  rename: (port: number | null, addr: string, name: string, dryRun = false) =>
    apiFetch<{ addr: string; name: string; dry_run: boolean; operator: string; result: unknown }>(
      withPort('/api/reverse/functions/rename', port, { addr }),
      { method: 'POST', body: JSON.stringify({ name, dry_run: dryRun }) },
    ),
};
