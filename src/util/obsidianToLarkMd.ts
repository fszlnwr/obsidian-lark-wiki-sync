/**
 * Inverse of `larkToObsidianMarkdown`. Used on the push path so that local
 * edits land back in Lark with the structures the API expects rather than
 * raw GFM that Lark may render unevenly.
 *
 * Scope:
 *   - GFM pipe tables           → <lark-table>/<lark-tr>/<lark-td>
 *   - ![[<token>.<ext>]]        → <image token="..."/> when the wikilink
 *                                 target looks like a Lark token (long
 *                                 alphanumeric basename) and the file lives
 *                                 in our attachments cache.
 *
 * Things we deliberately don't try to reverse:
 *   - <text ...> styling wrappers — info was discarded on pull.
 *   - <sheet token> placeholders  — placeholder text only; reattach later.
 *   - Whiteboards, mindmaps       — never touched on pull.
 *
 * The converter is a best-effort, regex-driven pass. Edge cases that fail
 * to match silently fall through unchanged — that is the safe default for
 * a push transform: never destroy content the user wrote.
 */

export interface InverseOptions {
  /**
   * Set of filenames known to live in `_attachments/` (i.e. images we pulled
   * from Lark). Only embeds whose target is in this set are rewritten back
   * to <image>; everything else is left as-is.
   */
  knownImageFilenames?: Set<string>;
}

/** A Lark file_token: long mixed-case alphanumeric, no separators. */
const LARK_TOKEN_RE = /^[A-Za-z0-9_-]{15,}$/;

export function obsidianToLarkMarkdown(src: string, opts: InverseOptions = {}): string {
  let out = src;

  out = convertPipeTablesToLarkTables(out);
  out = convertImageEmbedsToLarkImages(out, opts.knownImageFilenames);

  return out;
}

// -------------------------------------------------------------------------
// Tables
// -------------------------------------------------------------------------

function convertPipeTablesToLarkTables(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const tableEnd = findPipeTableEnd(lines, i);
    if (tableEnd > i) {
      const tableLines = lines.slice(i, tableEnd);
      out.push(renderLarkTable(tableLines));
      i = tableEnd;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

/**
 * Returns the (exclusive) end index of a pipe-table block starting at `start`,
 * or `start` if no table begins here. A valid pipe table is:
 *   line 0: header row    `| ... |`
 *   line 1: separator row `| --- | --- |` (cells of dashes/colons only)
 *   lines 2+: data rows   `| ... |`
 */
function findPipeTableEnd(lines: string[], start: number): number {
  if (start + 1 >= lines.length) return start;
  if (!isPipeRow(lines[start])) return start;
  if (!isPipeSeparator(lines[start + 1])) return start;

  let end = start + 2;
  while (end < lines.length && isPipeRow(lines[end])) end++;
  return end;
}

function isPipeRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length >= 3;
}

function isPipeSeparator(line: string): boolean {
  if (!isPipeRow(line)) return false;
  const cells = splitPipeRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()));
}

function splitPipeRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, "");
  // Split on unescaped pipes: `\\|` is a literal pipe inside a cell.
  const cells: string[] = [];
  let buf = "";
  let escape = false;
  for (const ch of trimmed) {
    if (escape) {
      buf += ch;
      escape = false;
    } else if (ch === "\\") {
      escape = true;
    } else if (ch === "|") {
      cells.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  cells.push(buf);
  return cells.map((c) => c);
}

function renderLarkTable(tableLines: string[]): string {
  const rows: string[][] = [];
  for (let i = 0; i < tableLines.length; i++) {
    if (i === 1) continue; // skip separator row
    const cells = splitPipeRow(tableLines[i]).map(unsanitizeCell);
    rows.push(cells);
  }
  if (rows.length === 0) return tableLines.join("\n");

  const cols = Math.max(...rows.map((r) => r.length));
  const lines: string[] = [];
  lines.push(`<lark-table rows="${rows.length}" cols="${cols}" header-row="true">`);
  for (const row of rows) {
    lines.push("  <lark-tr>");
    for (let c = 0; c < cols; c++) {
      const cell = (row[c] ?? "").trim();
      lines.push(`    <lark-td>${cell}</lark-td>`);
    }
    lines.push("  </lark-tr>");
  }
  lines.push("</lark-table>");
  return lines.join("\n");
}

/** Reverse the cell sanitisation applied by larkToObsidianMd.sanitizeCell. */
function unsanitizeCell(raw: string): string {
  return raw
    .trim()
    .replace(/\\\|/g, "|") // unescape pipes
    .replace(/\s*<br>\s*/g, "\n"); // <br> → real newline
}

// -------------------------------------------------------------------------
// Images
// -------------------------------------------------------------------------

function convertImageEmbedsToLarkImages(
  src: string,
  knownFiles: Set<string> | undefined,
): string {
  return src.replace(/!\[\[([^\]\n|]+)(?:\|[^\]]*)?\]\]/g, (match, target: string) => {
    const filename = target.trim();
    const dot = filename.lastIndexOf(".");
    const basename = dot > 0 ? filename.slice(0, dot) : filename;

    if (!LARK_TOKEN_RE.test(basename)) return match;
    if (knownFiles && !knownFiles.has(filename)) return match;

    return `<image token="${basename}"/>`;
  });
}
