# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Obsidian community plugin that two-way-syncs a vault folder with a Lark Wiki space. Status: **v0.0.1 scaffold** — pull path works end-to-end, push is implemented but unverified, conflict-resolution UI (3-way diff modal) is still a stub. Roadmap and open questions live in [PLAN.md](PLAN.md).

`isDesktopOnly: true` — the plugin shells out to `lark-cli` via Node `child_process.spawn`, so it cannot run on Obsidian mobile.

## Commands

```bash
npm install
npm run dev        # esbuild watch: main.ts → main.js (inline sourcemap)
npm run build      # tsc --noEmit typecheck, then esbuild production bundle (minified)
npm run typecheck  # tsc --noEmit -skipLibCheck
```

There is no test runner wired up yet (the README's testing strategy is aspirational). Validate changes by typechecking, then loading the built `main.js` into a real vault (see "Dev install" below).

### Dev install into a vault

```bash
cd /path/to/vault/.obsidian/plugins
ln -s /Users/daphnedevanita/work-stuff/obsidian-lark-wiki-sync ./lark-wiki-sync
# in Obsidian: Settings → Community plugins → reload → enable "Lark Wiki Sync"
```

The repo already contains a self-symlink `obsidian-lark-wiki-sync → .` — it's intentional, used to make the symlink target name stable inside vault plugin folders.

## Architecture

The plugin is deliberately thin: **`lark-cli` owns all Lark API knowledge, auth, and scopes.** This repo only adds an Obsidian-side UX (ribbon, wizard, settings tab) and the sync state machine. If a Lark operation is missing, add it to `lark-cli` first, not here.

Layering (entry point → leaves):

- [main.ts](main.ts) — `Plugin` subclass. Wires `LarkCli`, `StateStore`, `SyncEngine`, registers ribbon icon + 3 commands (`sync-now`, `setup`, `dry-run`) + settings tab. First-time ribbon click opens the wizard instead of syncing.
- [src/settings.ts](src/settings.ts) — `LarkWikiSyncSettings` schema, `DEFAULT_SETTINGS`, and `LarkWikiSyncSettingTab`. `configured: boolean` gates whether sync runs or opens the wizard.
- [src/ui/SetupWizardModal.ts](src/ui/SetupWizardModal.ts) — 6-step modal (`intro → auth → space → root → local → confirm`). Mutates a local `draft` object; calls `savePartial()` on each step to persist and re-prime `LarkCli`.
- [src/lark/LarkCli.ts](src/lark/LarkCli.ts) — typed shell-out wrapper around `lark-cli`. Every call appends `--as <identity>` from settings. Commands are parsed as JSON except `fetchDoc` which uses `{ raw: true }` to get pretty markdown stdout.
- [src/sync/SyncEngine.ts](src/sync/SyncEngine.ts) — the state machine (see below).
- [src/state/StateStore.ts](src/state/StateStore.ts) — persists `FileSyncState` per vault-relative path to `.obsidian/plugins/<id>/sync-state.json`. Keyed by `localPath`.
- [src/util/hash.ts](src/util/hash.ts) — `sha1(utf8)`, used for all three hashes below.

### The sync classification (core of the engine)

`SyncEngine.run()` iterates Wiki nodes with `obj_type === "docx"` (other types are skipped in v0.1). For each node it compares three SHA-1 hashes:

| `localHash` vs `lastSyncedHash` | `remoteHash` vs `lastSyncedHash` | Action |
|---|---|---|
| same    | same    | skip |
| same    | changed | pull (write remote → vault) |
| changed | same    | push (`updateDoc` with `replace_all`), unless `direction === "pull"` |
| changed | changed | conflict → `conflictPolicy` (`prefer-local` / `prefer-remote` / `ask`) |

`lastSyncedHash` is the common ancestor stored in `StateStore`; the trio is what makes this 3-way rather than last-writer-wins. Two edge cases:

- **No state + no local file** → brand-new pull.
- **No state + local file exists** → treated as conflict (untracked collision); logged, counted, not overwritten.

`ask` policy is currently a stub: it writes the remote side to `<localPath>.remote.conflict.md` so neither side is destroyed, and logs a warning. Building the real 3-way diff modal (`src/ui/ConflictModal.ts`) is the next major UI task.

### Path mapping (v0.1 flat)

`mapNodeToLocalPath()` currently flattens every docx node to `${localRoot}/${safeTitle}.md` — no folder mirroring yet. Mirroring the node tree is a v0.2 task tracked in PLAN.md. When changing this, remember `StateStore` is keyed by `localPath`, so any mapping change will orphan existing state entries unless migrated.

### lark-cli contract assumptions

`LarkCli` assumes these shortcut commands exist in the `lark-cli` binary — they are the integration contract and must match the installed CLI:

- `contact +me` → `{ data: { name, user_id } }`
- `wiki spaces list` → `{ data: { items: [{ space_id, name }] } }`
- `wiki spaces nodes list --space-id [--parent-node-token]` → `{ data: { items: [{ node_token, obj_token, obj_type, title }] } }`
- `wiki spaces get_node --token` → `{ data: { node } }`
- `docs +fetch --doc --format pretty` → raw markdown on stdout (not JSON)
- `docs +create --title --markdown - [--folder-token]` → stdin-fed markdown, returns JSON
- `docs +update --doc --mode <overwrite|append|replace_all> --markdown -` → stdin-fed, returns JSON

Verifying these response shapes against a real `lark-cli` is Phase 1 of PLAN.md and is not yet done. If a call starts returning unexpected shapes, check `lark-cli` version first.

## Conventions worth preserving

- **Don't add direct Lark HTTP calls.** Everything goes through `LarkCli` / `lark-cli`. Auth and scope handling belong upstream.
- **`SyncEngine.run()` must be idempotent.** Re-running with no changes should produce `skipped: N, pulled: 0, pushed: 0, conflicts: 0`. This is checklist item #4 before calling v0.1 done.
- **Never destroy either side on conflict.** The `ask` fallback writes a `.remote.conflict.md` sidecar; preserve this invariant when building the modal.
- **State is authoritative for hashes.** When recording a successful sync, always call `recordSync()` with the hash that now matches both sides. A mismatch there breaks all future classification for that file.
