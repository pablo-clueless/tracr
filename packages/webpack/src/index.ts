import { transformAsync } from "@babel/core";
import { tracrBabelPlugin, resolveOptions, type TracrPluginOptions } from "@tracr/babel-plugin";

export type TracrLoaderOptions = Partial<TracrPluginOptions>;

interface LoaderContext {
  resourcePath: string;
  getOptions(): TracrLoaderOptions;
  async(): (err: Error | null, code?: string, map?: unknown) => void;
}

export default function tracrLoader(this: LoaderContext, source: string): void {
  const callback = this.async();
  const resolved = resolveOptions(this.getOptions());

  transformAsync(source, {
    filename: this.resourcePath,
    babelrc: false,
    configFile: false,
    sourceMaps: true,
    plugins: [[tracrBabelPlugin, resolved]],
  })
    .then((result) => callback(null, result?.code ?? source, result?.map ?? undefined))
    .catch((error: unknown) => callback(error as Error));
}
