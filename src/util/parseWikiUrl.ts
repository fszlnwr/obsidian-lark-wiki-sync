export interface ParsedWikiUrl {
  nodeToken: string;
}

const LARK_HOST_RE = /\.(feishu\.cn|feishu\.com|larksuite\.com|larkoffice\.com)$/i;
const TOKEN_RE = /^[A-Za-z0-9]+$/;

export function parseWikiUrl(input: string): ParsedWikiUrl | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (!trimmed.includes("/") && TOKEN_RE.test(trimmed)) {
    return { nodeToken: trimmed };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (!LARK_HOST_RE.test(url.hostname)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const wikiIdx = segments.indexOf("wiki");
  if (wikiIdx === -1) return null;

  const rest = segments.slice(wikiIdx + 1).filter((s) => s !== "space");
  const token = rest[0];
  if (!token || !TOKEN_RE.test(token)) return null;

  return { nodeToken: token };
}
