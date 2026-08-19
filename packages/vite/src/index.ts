import { transformAsync } from "@babel/core";
import {
  tracrBabelPlugin,
  resolveOptions,
  type TracrPluginOptions,
} from "@pablo_clueless/babel-plugin";

export interface TracrViteOptions extends Partial<TracrPluginOptions> {
  /** When false the plugin returns nothing, so a production build is untouched. */
  enabled?: boolean;
}

interface VitePluginShape {
  name: string;
  enforce: "post";
  apply: "serve";
  transform(code: string, id: string): Promise<{ code: string; map: unknown } | null>;
}

/**
 * `enforce: 'post'` is load-bearing. Running before plugin-react / plugin-vue
 * means being handed raw JSX or an uncompiled SFC, which is syntax the transform
 * does not understand.
 *
 * `apply: 'serve'` is the no-op build path: a tracer reaching a production
 * bundle is an incident, so the plugin never attaches to a build at all.
 */
export const tracr = (options: TracrViteOptions = {}): VitePluginShape | null => {
  const { enabled = true, ...pluginOptions } = options;
  if (!enabled) return null;

  const resolved = resolveOptions(pluginOptions);

  return {
    name: "tracr",
    enforce: "post",
    apply: "serve",

    async transform(code: string, id: string) {
      if (id.includes("node_modules")) return null;

      const result = await transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        plugins: [[tracrBabelPlugin, resolved]],
      });

      if (result?.code == null) return null;
      return { code: result.code, map: result.map };
    },
  };
};

export default tracr;
