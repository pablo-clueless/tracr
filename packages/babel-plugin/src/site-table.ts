import type { SiteId, SiteInfo, SiteTable } from "@pablo_clueless/protocol";

/**
 * Site IDs are assigned at transform time and the agent ships only the integer.
 * The file/line/col mapping lives here and is emitted alongside the output.
 */
export class SiteTableBuilder {
  private readonly sites: SiteInfo[] = [];
  private next: number;

  private readonly runId: number;

  constructor(runId: number, siteIdBase = 0) {
    this.runId = runId;
    this.next = siteIdBase + 1;
  }

  assign(file: string, line: number, col: number, fnName: string | null): SiteId {
    const siteId = this.next++;
    this.sites.push({ siteId, file, line, col, fnName });
    return siteId;
  }

  build(): SiteTable {
    return { runId: this.runId, sites: [...this.sites] };
  }
}
