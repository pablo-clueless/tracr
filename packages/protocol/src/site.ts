/**
 * `runId:procId:siteId`, language- and platform-neutral.
 *
 * Only the integer ships at runtime. The `{ file, line, col, fnName }` mapping
 * lives in a side table emitted alongside the transform.
 */
export type SiteId = number;
export type RunId = number;
export type ProcId = number;

export interface QualifiedSite {
  runId: RunId;
  procId: ProcId;
  siteId: SiteId;
}

/** Side-table entry. Emitted at transform time, never sent per-event. */
export interface SiteInfo {
  siteId: SiteId;
  file: string;
  line: number;
  col: number;
  /**
   * The function this site sits *inside*, never the one it calls. The core
   * builds file -> function -> call site containment from it, so a callee name
   * here invents a function that the file does not define.
   *
   * `null` for top-level code, which belongs to the file and no function.
   */
  fnName: string | null;
}

/**
 * A call the parse found, before anything ran.
 *
 * The static half of the graph: the site table says where code is, this says
 * what calls what. Without it the core declares no edges and every observed
 * crossing is reported as unpredicted, which drains that signal of meaning.
 */
export interface CallEdge {
  /** Enclosing function, matching `SiteInfo.fnName`. `null` at top level. */
  from: string | null;
  /** The callee as written. Only plain identifiers are recorded. */
  to: string;
  /** Module the callee was imported from, or `null` if declared in `file`. */
  module: string | null;
  file: string;
  line: number;
  col: number;
}

/** What a transform unit emits alongside its instrumented output. */
export interface SiteTable {
  runId: RunId;
  sites: SiteInfo[];
  /** Optional: an older transform emits none, and the core copes. */
  calls?: CallEdge[];
}
