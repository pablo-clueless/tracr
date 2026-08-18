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
  fnName: string | null;
}

/** What a transform unit emits alongside its instrumented output. */
export interface SiteTable {
  runId: RunId;
  sites: SiteInfo[];
}
