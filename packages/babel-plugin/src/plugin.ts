import type { PluginObj, PluginPass } from "@babel/core";
import type * as BabelTypes from "@babel/types";

import { resolveOptions, type TracrPluginOptions } from "./options.js";
import { SiteTableBuilder } from "./site-table.js";

export interface TracrPass extends PluginPass {
  tracr: {
    options: TracrPluginOptions;
    sites: SiteTableBuilder;
  };
}

interface BabelApi {
  types: typeof BabelTypes;
  assertVersion(range: number): void;
}

/**
 * Build order (each step lands with its own tests before the next starts):
 *   1. declarations   `let x = e` -> `let x = e, x$t = <label of e>`
 *   2. object anchoring + reanchor
 *   3. binary ops     value unchanged, taint is a union, short-circuit on 0
 *   4. assignment propagation
 *   5. call args      side channel set immediately before the call
 *   6. returns
 *   7. template literals
 *   8. destructuring, spread, default params
 *   9. builtin summaries
 */
export const tracrBabelPlugin = (
  api: BabelApi,
  rawOptions: Partial<TracrPluginOptions> = {},
): PluginObj<TracrPass> => {
  api.assertVersion(7);

  const options = resolveOptions(rawOptions);

  return {
    name: "tracr",

    pre() {
      this.tracr = {
        options,
        sites: new SiteTableBuilder(0),
      };
    },

    visitor: {
      VariableDeclaration() {},
      BinaryExpression() {},
      AssignmentExpression() {},
      CallExpression() {},
      ReturnStatement() {},
      TemplateLiteral() {},
    },

    post() {},
  };
};

export default tracrBabelPlugin;
