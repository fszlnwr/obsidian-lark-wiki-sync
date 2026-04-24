import { spawn } from "child_process";
import type { LarkWikiSyncSettings } from "../settings";

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
    const r = await this.run(["contact", "+me"]);
    return r?.data ?? null;
  }

  // ---------------------------------------------------------------------------
  // Wiki — spaces & nodes
  // ---------------------------------------------------------------------------

  async listSpaces(): Promise<Array<{ space_id: string; name: string }>> {
    const r = await this.run(["wiki", "spaces", "list"]);
    return r?.data?.items ?? [];
  }

  async listNodes(spaceId: string, parentNodeToken?: string) {
    const args = ["wiki", "spaces", "nodes", "list", "--space-id", spaceId];
    if (parentNodeToken) args.push("--parent-node-token", parentNodeToken);
    const r = await this.run(args);
    return r?.data?.items ?? [];
  }

  async getNode(token: string) {
    const r = await this.run(["wiki", "spaces", "get_node", "--token", token]);
    return r?.data?.node ?? null;
  }

  // ---------------------------------------------------------------------------
  // Docs — fetch / create / update
  // ---------------------------------------------------------------------------

  async fetchDoc(docToken: string): Promise<string> {
    const r = await this.run(["docs", "+fetch", "--doc", docToken, "--format", "pretty"], {
      raw: true,
    });
    return r as unknown as string;
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
        if (code !== 0) {
          reject(new Error(`lark-cli exit ${code}: ${stderr || stdout}`));
          return;
        }
        if (opts.raw) {
          resolve(stdout);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`lark-cli returned non-JSON: ${stdout.slice(0, 200)}`));
        }
      });

      if (opts.stdin) {
        proc.stdin.write(opts.stdin);
        proc.stdin.end();
      }
    });
  }
}
