# Lark Wiki Sync — Obsidian Plugin

Sync one or more Lark Wiki spaces into your Obsidian vault. Uses [`lark-cli`](https://github.com/larksuite/lark-cli) as the transport so auth, scopes, and API coverage are handled upstream — this plugin adds the Obsidian-side UX (ribbon button, setup wizard, paste-a-link, conflict-aware sync, image download).

> **Status:** v0.0.10 — pull works end-to-end across multiple spaces, with full-tree pagination, folder mirroring, GFM-table rendering, and image attachments. Push exists but is unverified end-to-end. Three-way conflict modal still falls back to a `.remote.conflict.md` sidecar.

## Features

- **Multi-space sync.** Configure as many Lark Wiki spaces as you want; each lives in its own self-contained subfolder under a single local root (default `📥 Lark`).
- **Setup wizard.** Verify `lark-cli`, pick a space from a dropdown, **or paste any wiki URL** and the plugin resolves the space + root node for you.
- **Full-tree pull with pagination.** Walks every descendant up to depth 20, paginates `wiki nodes list` automatically.
- **Native Obsidian markdown.** Lark-flavoured tags (`<lark-table>`, `<text>`, etc.) get converted to GFM pipe tables and clean markdown.
- **Inline images.** `<image token="…"/>` references download via `lark-cli docs +media-download` into `_attachments/<token>.<ext>` and embed as `![[<token>.<ext>]]`. Cached across syncs.
- **3-way diff classification.** Per-file `lastSyncedHash` enables proper conflict detection (skip / pull / push / conflict / reconcile). Sync state is keyed by Lark `nodeToken`, so it survives any future path-mapping changes.
- **Push confirmation.** When the engine plans to upload local edits to Lark, a modal lists every file going up so you can cancel before anything is overwritten remotely. Toggle in settings.
- **Per-file error visibility.** If any pull/push/conflict step fails (missing scope, rate limit, malformed content), a results modal pops up after sync listing every failure with the actual `lark-cli` error message, so you don't have to spelunk through the dev console.
- **Lossless push round-trip.** Pipe tables you edit locally are rewritten as `<lark-table>` and pulled image embeds (`![[<token>.<ext>]]`) become `<image token="..."/>` before they hit Lark's update API, so structure survives the round trip. Image embeds whose target is *not* a known Lark token are left alone (newly-pasted local images aren't yet uploaded — that's a future item).
- **One-click sync.** Ribbon icon (Lucide `sync`) and command palette entries.

## Prerequisites

1. **`lark-cli` installed and authorized.**
   ```bash
   lark-cli auth login --scope "wiki:space:retrieve wiki:node:retrieve docx:document:readonly docx:document drive:drive:readonly"
   ```
   (Drop `docx:document` and `drive:drive:readonly` if you only need pull-only / no images.)
2. Obsidian desktop. The plugin is `isDesktopOnly: true` because it shells out to `lark-cli` via `child_process.spawn`.

## Install via BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin in Obsidian.
2. BRAT → **Add beta plugin** → `fszlnwr/obsidian-lark-wiki-sync`.
3. Enable **Lark Wiki Sync** in Community plugins.
4. Click the ribbon icon → run the setup wizard. Paste a Lark wiki link in the Source step and the plugin will resolve everything.

## Install (dev)

```bash
cd /path/to/your/vault/.obsidian/plugins
ln -s /Users/daphnedevanita/work-stuff/obsidian-lark-wiki-sync ./lark-wiki-sync
cd lark-wiki-sync
npm install
npm run dev        # watches main.ts → main.js
```

Then in Obsidian: **Settings → Community plugins → reload → enable "Lark Wiki Sync"**.

## Architecture

```
main.ts                          Plugin entry, ribbon, commands, settings migration
src/settings.ts                  Settings schema (spaces[]) + settings tab
src/ui/SetupWizardModal.ts       Add-a-space wizard (dropdown OR paste-a-link)
src/lark/LarkCli.ts              Shell-out wrapper around lark-cli
src/sync/SyncEngine.ts           Per-space pull/push/conflict orchestration
src/state/StateStore.ts          Per-file hash + last-sync timestamps
src/util/hash.ts                 SHA-1 helper
src/util/parseWikiUrl.ts         Lark URL → node_token parser
src/util/larkToObsidianMd.ts     Lark-flavoured MD → Obsidian MD converter (pull)
src/util/obsidianToLarkMd.ts     Obsidian MD → Lark-flavoured MD converter (push)
```

### File layout in your vault

```
📥 Lark/
  Nexus Wiki/
    FRD.md
    FSD/
      Loyalty engine spec.md
    _attachments/
      <image-token>.jpg
  Another Wiki Space/
    ...
    _attachments/
      ...
```

Each space is fully self-contained — delete its folder and everything for that space is gone, no orphans.

### Sync classification (per file)

For each docx node, compare three hashes:

| `lastSyncedHash` vs. `localHash` | `lastSyncedHash` vs. `remoteHash` | Action |
|----------------------------------|-----------------------------------|--------|
| same                             | same                              | skip |
| same                             | changed                           | pull |
| changed                          | same                              | push (confirmed) |
| changed                          | changed                           | conflict → apply policy |

Special branches when there is no prior `lastSyncedHash` (first sync of a node, or after a reset):

- Local file absent → **pull** (new download).
- Local file present, hash matches remote → **reconcile** (silently adopt the existing file as the baseline; no I/O).
- Local file present, hash differs → **conflict** (real first-sync collision).

`lastSyncedHash` is the common ancestor. The remote hash is computed AFTER the Lark→Obsidian markdown transform, so re-pulling the same Lark content produces a stable hash. State is keyed by `nodeToken`, so renaming `localRoot` or restructuring folders does not orphan it.

## Settings tab

- **Wiki spaces** — list of currently-synced spaces with a Remove button each. "Add a wiki space" opens the wizard.
- **Connection** — `lark-cli` path (blank = use PATH), identity (user / bot).
- **Sync behaviour** — local root, sync direction (pull / push / bidirectional), conflict policy, auto-sync interval.
- **Maintenance** — last-synced timestamp, "Reset sync state" wipes cached hashes (use after a major layout change).

## Roadmap

- [x] v0.0.1 — scaffold: pull one docx node, record state
- [x] v0.0.5 — full space pull with folder mirroring + pagination
- [x] v0.0.6 — Lark-flavoured MD → Obsidian MD conversion (tables, images placeholder)
- [x] v0.0.7 — inline image download (was v0.5 in the original plan)
- [x] v0.0.9 — per-space subfolder, default root `📥 Lark`
- [x] v0.0.10 — multi-space configuration
- [x] v0.0.11 — push path actually fires (state keyed by `nodeToken`, reconcile branch); push confirmation modal
- [x] v0.0.12 — per-action error surfacing (results modal lists every failure with the real lark-cli message)
- [x] v0.0.13 — push uses `--mode overwrite` (lark-cli's `replace_all` mode is selection-scoped despite the name)
- [x] v0.1.0 — inverse Obsidian→Lark transform: pipe tables → `<lark-table>`, `![[<token>.<ext>]]` → `<image token="..."/>` on push
- [ ] v0.2.0 — three-way diff conflict modal
- [ ] v0.3.0 — wikilink ↔ Lark internal link conversion
- [ ] v0.4.0 — embedded `<sheet>` rendering / link
- [ ] v1.0.0 — ignore patterns, per-file `lark_sync: false` frontmatter flag, auto-sync timer, polish

## Testing strategy

- **Unit:** none yet — the converter (`larkToObsidianMd.ts`) and URL parser (`parseWikiUrl.ts`) are pure functions and would benefit from a small test harness.
- **Integration:** run against a throwaway Wiki space.
- **E2E:** dry-run mode (Cmd+P → "Lark Wiki Sync — preview changes (dry run)") prints intended actions without applying.

## License

MIT
