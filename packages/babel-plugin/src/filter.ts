/**
 * Just enough glob for `include` / `exclude`. A dependency would be the obvious
 * move, but the loader runs inside the host process on every module load, so
 * its dependency surface is the host's too. The supported syntax is what the
 * config patterns actually use: `**`, `*`, `?`, and `{a,b}` alternation.
 */

const ESCAPE = /[.+^$()|[\]\\]/g;

const literal = (text: string): string => text.replace(ESCAPE, "\\$&");

const compile = (pattern: string): string => {
  let out = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i] as string;

    if (char === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += literal(char);
        i++;
        continue;
      }
      const alternatives = pattern.slice(i + 1, end).split(",");
      out += `(?:${alternatives.map(compile).join("|")})`;
      i = end + 1;
      continue;
    }

    if (char === "*") {
      // `**/` spans zero or more segments; a bare `**` spans anything.
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]*/)*";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }

    if (char === "?") {
      out += "[^/]";
      i++;
      continue;
    }

    out += literal(char);
    i++;
  }

  return out;
};

export const globToRegExp = (pattern: string): RegExp => new RegExp(`^${compile(pattern)}$`);

export type PathFilter = (relativePath: string) => boolean;

/**
 * Exclusion wins. An empty `include` includes everything, which keeps a config
 * that only sets `exclude` behaving the way it reads.
 */
export const createFilter = (include: string[], exclude: string[]): PathFilter => {
  const included = include.map(globToRegExp);
  const excluded = exclude.map(globToRegExp);

  return (relativePath) => {
    const path = relativePath.replace(/\\/g, "/");
    if (excluded.some((re) => re.test(path))) return false;
    return included.length === 0 || included.some((re) => re.test(path));
  };
};
