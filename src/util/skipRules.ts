/**
 * Helpers for "should this file be skipped" decisions in the sync engine.
 *
 *   - globToRegex / matchAnyGlob: minimal glob matcher for ignorePatterns
 *     (no minimatch dep). Supports `*`, `**`, `?`, and exact path segments.
 *   - hasLarkSyncFalse: cheap frontmatter scan to detect `lark_sync: false`
 *     without pulling in a YAML parser. Looks at the first frontmatter
 *     block only (between leading `---` lines).
 */

/**
 * Convert a glob pattern to a regex source. Conventions:
 *   `*`   → any characters except `/`
 *   `**`  → any characters including `/`
 *   `?`   → single character except `/`
 *   anything else is escaped literally
 */
export function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++; // skip the second *
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\.+^$()[]{}|".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$");
}

export function matchAnyGlob(path: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const p of patterns) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (globToRegex(trimmed).test(path)) return true;
  }
  return false;
}

/**
 * Returns true if the markdown's frontmatter has `lark_sync: false`. Tolerates
 * varying whitespace and quote styles. Does not parse the rest of the frontmatter.
 */
export function hasLarkSyncFalse(md: string): boolean {
  if (!md.startsWith("---")) return false;
  const end = md.indexOf("\n---", 3);
  if (end < 0) return false;
  const fm = md.slice(3, end);
  return /^\s*lark_sync\s*:\s*(false|no|0|"false"|'false')\s*$/im.test(fm);
}
