/**
 * Where the transform redirects a shimmed import to.
 *
 * Only the shimmed hooks live here. The transform splits an import declaration
 * rather than repointing it, so `useEffect` and friends still come straight
 * from `react` and this module never has to mirror React's surface — which it
 * could not do anyway, since `@types/react` uses `export =` and cannot be
 * star-re-exported.
 */
export { useReducer, useRef, useState } from "./shims.js";
