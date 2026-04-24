# Lark Wiki Sync — Obsidian Plugin

Two-way sync between an Obsidian vault and a Lark Wiki space. Uses [`lark-cli`](https://github.com/larksuite/lark-cli) as the transport layer so auth, scopes, and API coverage are handled upstream. The plugin adds a ribbon button, a setup wizard, and conflict-aware sync logic on top.

> **Status:** v0.0.1 scaffold. Pull path works end-to-end; push + conflict-resolution UI are stubs.
> **Related idea note:** [[Idea - Obsidian Plugin Lark Wiki Sync]] in the second-brain vault.

## Features (Target v1.0)

- Setup wizard: detect `lark-cli`, pick space + root node, pick local folder, pick sync direction
- One-click sync from ribbon or command palette
- Three-way conflict detection with diff modal (ask / prefer-local / prefer-remote)
- Wikilink ↔ Lark internal link conversion (v0.2+)
- Attachment handling (download on pull, upload on push) (v0.3+)
- Scope controls: ignore patterns, per-file `lark_sync: false` frontmatter flag
- Dry-run mode

## Prerequisites

1. **`lark-cli` installed and authorized** on the same machine. Run:
   ```bash
   lark-cli auth login
   ```
2. Ensure the user identity has the required scopes for wiki + docs:
   - `wiki:wiki:readonly` (or `:write` for push)
   - `docx:document:readonly` / `docx:document`
   - `contact:user.base:readonly` (for identity check)

## Install via BRAT

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin in Obsidian.
2. BRAT → **Add beta plugin** → `fszlnwr/obsidian-lark-wiki-sync`.
3. Enable **Lark Wiki Sync** in Community plugins.
4. Make sure `lark-cli auth login` has been run on the same machine.
5. Click the ribbon icon to run the setup wizard. You can paste a Lark wiki link directly — the wizard will resolve the space and root node for you.

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
main.ts                       Plugin entry + commands + ribbon
src/settings.ts               Settings schema + settings tab
src/ui/SetupWizardModal.ts    First-run wizard
src/ui/ConflictModal.ts       (TODO) Three-way diff UI
src/lark/LarkCli.ts           Shell-out wrapper around lark-cli
src/sync/SyncEngine.ts        Pull / push / conflict classification
src/state/StateStore.ts       Per-file hash + last-sync timestamps
src/util/hash.ts              SHA-1 helper
```

### Sync classification (per file)

For each Wiki node that maps to a doc, compare three hashes:

| `lastSyncedHash` vs. `localHash` | `lastSyncedHash` vs. `remoteHash` | Action |
|----------------------------------|-----------------------------------|--------|
| same                             | same                              | skip |
| same                             | changed                           | pull |
| changed                          | same                              | push |
| changed                          | changed                           | conflict → apply policy |

`lastSyncedHash` is the common ancestor; the trio enables proper 3-way reasoning.

## Roadmap

- [x] v0.0.1 — scaffold: pull one docx node, record state
- [ ] v0.1.0 — full space pull with folder mirroring
- [ ] v0.2.0 — push path + conflict detection
- [ ] v0.3.0 — conflict resolution modal (3-way diff)
- [ ] v0.4.0 — wikilink ↔ wiki link conversion
- [ ] v0.5.0 — attachments
- [ ] v1.0.0 — ignore patterns, frontmatter flags, auto-sync interval, polish

## Testing strategy

- **Unit**: `SyncEngine.classify(state, local, remote)` returns correct action per case
- **Integration**: run against a throwaway test Wiki space (one folder, 3 docs)
- **E2E**: dry-run mode prints intended actions without applying

## License

MIT
