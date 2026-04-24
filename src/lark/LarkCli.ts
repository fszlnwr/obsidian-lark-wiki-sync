import { spawn } from "child_process";
import type { LarkWikiSyncSettings } from "../settings";
import { larkToObsidianMarkdown } from "../util/larkToObsidianMd";

export interface WikiNode {
  space_id: string;
  node_token: string;
  obj_token: string;
  obj_type: string;
  title: string;
  has_child?: boolean;
  [key: string]: any;
}

export interface WikiNodeWithPath extends WikiNode {
  parentPath: string[];
}

// Obsidian on macOS spawns subprocesses with a minimal PATH that excludes
// Homebrew and common node install dirs, so `#!/usr/bin/env node` shebangs
// (including lark-cli's) fail with "env: node: No such file or directory".
// Always prepend the usual suspects.
function augmentedPath(): string {
  const home = process.env.HOME ?? "";
  const extras = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    `${home}/.local/bin`,
    `${home}/.nvm/versions/node/current/bin`,
    `${home}/.volta/bin`,
    `${home}/.fnm/current/bin`,
  ];
  const existing = (process.env.PATH ?? "").split(":").filter(Boolean);
  const seen = new Set<string>();
  return [...extras, ...existing].filter((p) => !seen.has(p) && seen.add(p)).join(":");
}

/**
 * Thin wrapper around the lark-cli binary.
 *
 * All actual API knowledge lives in lark-cli; this class is just a typed
 * shell-out layer. Returns parsed JSON for shortcut commands.
 */
export class LarkCli {
  constructor(private settings: LarkWikiSyncSettings) {}

  updateSettings(s: LarkWikiSyncSettings) {
    this.settings = s;
  }

  // ---------------------------------------------------------------------------
  // Auth & health
  // ---------------------------------------------------------------------------

  async whoAmI(): Promise<{ name?: string; user_id?: string } | null> {
    const r = await this.run(["contact", "+get-user"]);
    const u = r?.data?.user;
    if (!u) return null;
    return { name: u.name ?? u.en_name, user_id: u.user_id ?? u.open_id };
  }

  // ---------------------------------------------------------------------------
  // Wiki — spaces & nodes
  // ---------------------------------------------------------------------------

  async listSpaces(): Promise<Array<{ space_id: string; name: string }>> {
    const r = await this.run(["wiki", "spaces", "list"]);
    return r?.data?.items ?? [];
  }

  async listNodes(spaceId: string, parentNodeToken?: string) {
    const out: any[] = [];
    let pageToken = "";
    while (true) {
      const params: Record<string, any> = { space_id: spaceId, page_size: 50 };
      if (parentNodeToken) params.parent_node_token = parentNodeToken;
      if (pageToken) params.page_token = pageToken;
      const r = await this.run(["wiki", "nodes", "list", "--params", JSON.stringify(params)]);
      out.push(...(r?.data?.items ?? []));
      if (!r?.data?.has_more) break;
      pageToken = r?.data?.page_token ?? "";
      if (!pageToken) break;
    }
    return out;
  }

  async getNode(token: string) {
    const r = await this.run([
      "wiki",
      "spaces",
      "get_node",
      "--params",
      JSON.stringify({ token, obj_type: "wiki" }),
    ]);
    return r?.data?.node ?? null;
  }

  /**
   * Walk the entire node tree starting from `rootToken` (or the whole space
   * if omitted) and return every node flat, with `parentPath` (ancestor
   * titles) attached so callers can mirror the tree into folders.
   *
   * - Paginates every level via listNodes().
   * - Recurses into any node with has_child === true, regardless of obj_type
   *   (a non-docx node can still have docx descendants we want to pull).
   * - If a specific root is provided, the root itself is included too, so
   *   URLs that point directly at a leaf doc still sync that one doc.
   */
  async listAllDescendants(
    spaceId: string,
    rootToken?: string,
    maxDepth = 20,
  ): Promise<WikiNodeWithPath[]> {
    const out: WikiNodeWithPath[] = [];

    if (rootToken) {
      const root = await this.getNode(rootToken);
      if (root) out.push({ ...root, parentPath: [] });
    }

    const walk = async (parentToken: string | undefined, parentPath: string[]) => {
      if (parentPath.length > maxDepth) {
        console.warn(
          `LarkWikiSync: max tree depth ${maxDepth} exceeded at ${parentPath.join("/")}; stopping recursion here.`,
        );
        return;
      }
      const children = await this.listNodes(spaceId, parentToken);
      for (const n of children) {
        out.push({ ...n, parentPath });
        if (n.has_child) {
          await walk(n.node_token, [...parentPath, n.title]);
        }
      }
    };

    await walk(rootToken, []);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Docs — fetch / create / update
  // ---------------------------------------------------------------------------

  async fetchDoc(docToken: string): Promise<string> {
    const r = await this.run(["docs", "+fetch", "--doc", docToken, "--format", "pretty"], {
      raw: true,
    });
    return larkToObsidianMarkdown(r as unknown as string);
  }

  async createDoc(title: string, markdown: string, folderToken?: string) {
    const args = ["docs", "+create", "--title", title, "--markdown", "-"];
    if (folderToken) args.push("--folder-token", folderToken);
    const r = await this.run(args, { stdin: markdown });
    return r?.data ?? null;
  }

  async updateDoc(
    docToken: string,
    markdown: string,
    mode: "overwrite" | "append" | "replace_all" = "replace_all",
  ) {
    const args = ["docs", "+update", "--doc", docToken, "--mode", mode, "--markdown", "-"];
    const r = await this.run(args, { stdin: markdown });
    return r?.data ?? null;
  }

  // ---------------------------------------------------------------------------
  // Internal: spawn lark-cli
  // ---------------------------------------------------------------------------

  private run(
    args: string[],
    opts: { stdin?: string; raw?: boolean } = {},
  ): Promise<any> {
    const bin = this.settings.larkCliPath || "lark-cli";
    const fullArgs = [...args, "--as", this.settings.larkIdentity];

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, fullArgs, {
        env: { ...process.env, PATH: augmentedPath() },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));

      proc.on("error", (err) => reject(new Error(`Failed to spawn lark-cli: ${err.message}`)));

      proc.on("close", (code) => {
        if (opts.raw) {
          if (code !== 0) {
            reject(new Error(`lark-cli exit ${code}: ${stderr || stdout}`));
            return;
          }
          resolve(stdout);
          return;
        }

        // lark-cli may exit non-zero but still emit a structured JSON payload
        // with { ok: false, error: { message, hint } }. Prefer the payload
        // over the raw exit-code noise.
        let parsed: any = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          /* not JSON */
        }

        if (parsed && parsed.ok === false) {
          const msg = parsed.error?.message ?? "lark-cli returned ok:false";
          const hint = parsed.error?.hint ? `\nHint: ${parsed.error.hint}` : "";
          reject(new Error(`${msg}${hint}`));
          return;
        }

        if (code !== 0) {
          reject(new Error(`lark-cli exit ${code}: ${stderr || stdout.slice(0, 200)}`));
          return;
        }

        if (parsed === null) {
          reject(new Error(`lark-cli returned non-JSON: ${stdout.slice(0, 200)}`));
          return;
        }

        resolve(parsed);
      });

      if (opts.stdin) {
        proc.stdin.write(opts.stdin);
        proc.stdin.end();
      }
    });
  }
}
