/**
 * Convert Lark-flavored markdown (as returned by `docs +fetch --format pretty`)
 * to something Obsidian renders natively.
 *
 * Scope of this converter:
 *   - <lark-table> / <lark-tr> / <lark-td> → pipe-syntax GFM tables
 *   - <image token="..." .../>            → placeholder until v0.5 attachments
 *   - <sheet token="..." .../>            → placeholder
 *   - <text>...</text> styling wrappers   → stripped (content kept)
 *
 * Non-goals:
 *   - Whiteboards, mindmaps, embeds — left as-is.
 *   - Round-trip to Lark. Push will need an inverse converter when we
 *     implement the push path for files that contain tables/images.
 */

export interface ConvertOptions {
  /** Map from Lark image token → filename to embed via ![[...]]. */
  imageMap?: Record<string, string>;
  /**
   * Map from Lark `node_token` → resolved doc title. When a Lark wiki URL in
   * the source markdown points at a known node, the link is rewritten as an
   * Obsidian wikilink (`[[title]]` or `[[title|alias]]`) so the synced doc
   * navigates to the corresponding local file.
   */
  nodeTitleMap?: Record<string, string>;
}

export function larkToObsidianMarkdown(src: string, opts: ConvertOptions = {}): string {
  let out = src;

  out = out.replace(
    /<lark-table([^>]*)>([\s\S]*?)<\/lark-table>/g,
    (match, attrs: string, inner: string) => convertTable(match, attrs, inner),
  );

  out = out.replace(
    /<image\s+([^/]*?)\/>/g,
    (_match, attrs: string) => {
      const token = /token="([^"]+)"/.exec(attrs)?.[1];
      if (!token) return "*[📷 image]*";
      const mapped = opts.imageMap?.[token];
      if (mapped) return `![[${mapped}]]`;
      return `*[📷 image — Lark token \`${token}\`]*`;
    },
  );

  out = convertLarkWikiLinks(out, opts.nodeTitleMap);

  out = out.replace(
    /<sheet\s+([^/]*?)\/>/g,
    (_match, attrs: string) => {
      const token = /token="([^"]+)"/.exec(attrs)?.[1];
      return token
        ? `*[📊 embedded sheet — Lark token \`${token}\`]*`
        : "*[📊 embedded sheet]*";
    },
  );

  // Strip <text ...>...</text> styling wrappers but keep their contents.
  out = out.replace(/<text[^>]*>([\s\S]*?)<\/text>/g, "$1");

  return out;
}

/**
 * Rewrite Lark wiki links to Obsidian wikilinks when the destination doc is
 * already known to the sync state.
 *
 * Matches `[label](https://<host>/wiki/<node_token>...)` where `<host>` is a
 * Lark/Feishu domain. If `nodeTitleMap` has the token, emit
 * `[[title]]` (when label === title) or `[[title|label]]` (preserving the
 * user's link text). If not, leave the link untouched — the doc may simply
 * not be synced yet.
 */
function convertLarkWikiLinks(
  src: string,
  nodeTitleMap: Record<string, string> | undefined,
): string {
  if (!nodeTitleMap) return src;
  // Allow any number of subdomain levels so e.g. `fcn.sg.larksuite.com` matches.
  const LARK_HOSTS = /(?:[a-z0-9-]+\.)*(?:feishu\.cn|feishu\.com|larksuite\.com|larkoffice\.com)/i;
  const LINK_RE = new RegExp(
    `\\[([^\\]]+)\\]\\(https?://${LARK_HOSTS.source}/wiki/([A-Za-z0-9]+)(?:[/?#][^)]*)?\\)`,
    "gi",
  );
  return src.replace(LINK_RE, (match, label: string, token: string) => {
    const title = nodeTitleMap[token];
    if (!title) return match;
    if (label.trim() === title) return `[[${title}]]`;
    return `[[${title}|${label}]]`;
  });
}

export function extractImageTokens(src: string): string[] {
  const tokens = new Set<string>();
  for (const m of src.matchAll(/<image\s+[^>]*token="([^"]+)"/g)) {
    tokens.add(m[1]);
  }
  return [...tokens];
}

function convertTable(original: string, _attrs: string, inner: string): string {
  const rowMatches = [...inner.matchAll(/<lark-tr[^>]*>([\s\S]*?)<\/lark-tr>/g)];
  const rows = rowMatches.map((m) => {
    const cellMatches = [...m[1].matchAll(/<lark-td[^>]*>([\s\S]*?)<\/lark-td>/g)];
    return cellMatches.map((c) => sanitizeCell(c[1]));
  });

  if (rows.length === 0) return original;

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];

  // GFM pipe tables require a header row. Always promote row 0 to the header —
  // that matches the usual pattern in Lark docs and avoids synthesising empty
  // headers. A truly header-less data table will lose one row of distinction,
  // which is an acceptable tradeoff.
  const lines: string[] = [];
  lines.push(`| ${pad(rows[0]).join(" | ")} |`);
  lines.push(`| ${Array(width).fill("---").join(" | ")} |`);
  for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(" | ")} |`);

  return lines.join("\n");
}

function sanitizeCell(raw: string): string {
  return raw
    .trim() // kill wrapping whitespace/newlines before any <br> conversion
    .replace(/\|/g, "\\|")
    .replace(/\{align="[^"]*"\}/g, "") // strip Lark alignment annotations
    .replace(/\r?\n\s*/g, " <br> ") // real internal newlines → <br>
    .replace(/[ \t]+/g, " ")
    .trim();
}
