import { register } from "node:module";
import { pathToFileURL } from "node:url";

/** `node --import tracr/register app.js` */
register("./loader.js", pathToFileURL(import.meta.filename));
