/**
 * Node module customization hooks. Registered via `module.register()`, which is
 * Node-only; browser code is instrumented by the bundler plugin instead.
 */
export interface LoadContext {
  format: string | null | undefined;
  importAttributes?: Record<string, string>;
}

export interface LoadResult {
  format: string;
  source: string | ArrayBuffer | Uint8Array;
  shortCircuit?: boolean;
}

export type NextLoad = (url: string, context: LoadContext) => Promise<LoadResult>;

export const load = async (
  url: string,
  context: LoadContext,
  nextLoad: NextLoad,
): Promise<LoadResult> => {
  const result = await nextLoad(url, context);
  if (url.includes("/node_modules/")) return result;
  return result;
};
