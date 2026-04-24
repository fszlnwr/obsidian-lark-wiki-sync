# Implementation Plan — Lark Wiki Sync

Kicked off: 2026-04-24
Owner: Faiszal
Source idea: `[[Idea - Obsidian Plugin Lark Wiki Sync]]` in the second-brain vault

---

## Goal for v0.1 (first shippable milestone)

A logged-in Faiszal can:

1. Install the plugin in his vault
2. Run the wizard and point it at a real Lark Wiki space (e.g. Antikode team wiki)
3. Click "Sync" and pull N docx nodes into `📥 Wiki/` as `.md` files
4. Change a file locally, click "Sync" again, and see it pushed back to Lark
5. See a clean "X pulled, Y pushed, Z conflicts" notice on success

Anything beyond that (attachments, wikilink conversion, 3-way diff modal, auto-sync) = v0.2+.

---

## Open questions before v0.1

- **Does `lark-cli wiki spaces nodes list` return `obj_type=docx` for leaf docs?** Verify against an actual space.
- **How does `lark-cli docs +fetch --format pretty` handle frontmatter?** Does it preserve it, or do we need a separate metadata sidecar?
- **Rate limits:** does listing nodes for a big space paginate? Check `page_token`.
- **Folder structure:** for v0.1 we flatten every docx under `localRoot/`. In v0.2 mirror the node tree to folders.
- **Auth UX:** should the wizard run `lark-cli auth login` directly, or just detect and error if unauthorized?

---

## Task breakdown

### Phase 0 — Scaffold (DONE, this commit)
- [x] manifest.json, package.json, tsconfig.json, esbuild.config.mjs
- [x] main.ts with ribbon button + settings tab + commands
- [x] Settings schema + settings tab
- [x] LarkCli wrapper (whoAmI, listSpaces, listNodes, fetchDoc, createDoc, updateDoc)
- [x] StateStore for per-file sync metadata
- [x] SyncEngine skeleton (pull path + stub push + stub conflict)
- [x] SetupWizardModal (intro → auth → space → root → local → confirm)
- [x] README + this PLAN

### Phase 1 — Make it actually work
- [ ] `npm install` + confirm esbuild builds `main.js` without errors
- [ ] Verify `LarkCli.whoAmI()` against Faiszal's lark-cli
- [ ] Verify `LarkCli.listSpaces()` + `listNodes()` — check actual response shape
- [ ] Walk through wizard in a test vault — fix any modal UX issues
- [ ] Click sync → confirm `🟢 X pulled` notice + files appear in `📥 Wiki/`
- [ ] Modify one file → sync → confirm it pushes back + remote reflects change
- [ ] Modify both sides → confirm "conflict" count increments + `.conflict.md` file written

### Phase 2 — Polish for internal release
- [ ] Handle pagination when listing nodes
- [ ] Handle deletes (node removed / local file removed)
- [ ] Preserve Obsidian frontmatter across push cycles (strategy: append as callout block on Lark side, parse back on pull)
- [ ] Better conflict UX: three-way diff modal with accept-side buttons
- [ ] Ignore patterns (glob matcher)
- [ ] Per-file `lark_sync: false` frontmatter flag
- [ ] Auto-sync interval
- [ ] Dry-run visual report (not just counts)

### Phase 3 — Share with team
- [ ] Install on Deddy's / Tobi's / Irfan's vaults
- [ ] Gather feedback on wizard + conflict UX
- [ ] Document scope requirements clearly in README
- [ ] Optionally: publish to Obsidian community plugins registry

---

## Risks / Gotchas

1. **`lark-cli docs +fetch --format pretty` may not round-trip cleanly** — pulling a doc and re-pushing the same markdown could produce diffs due to Lark's block-based format. Need to test.
2. **Obsidian's `spawn()` in a plugin needs node integration enabled** — should work in desktop builds (`isDesktopOnly: true` in manifest) but double-check permissions.
3. **Conflict policy defaults to `ask` but modal isn't built yet** — fallback writes a `.conflict.md` file. Document this clearly.
4. **Primary identity assumption** — plugin currently uses `--as user`. Document that users must `lark-cli auth login` first.

---

## Validation checklist before calling v0.1 done

- [ ] Wizard completes without thrown errors on a fresh vault
- [ ] Pull works for a space with ≥ 10 docs
- [ ] Push works end-to-end (edit local → sync → open in Lark → see change)
- [ ] Re-sync after no changes = all-skip, 0 writes
- [ ] Conflict case produces a `.conflict.md` sidecar and doesn't destroy data
- [ ] Reset button in settings wipes `sync-state.json`
- [ ] Uninstall cleanly removes plugin without leaving orphan state

---

## Links

- Second-brain idea note: `[[Idea - Obsidian Plugin Lark Wiki Sync]]`
- Obsidian plugin docs: https://docs.obsidian.md/Plugins/Getting+started
- Lark Wiki API: https://open.larksuite.com/document/server-docs/docs/wiki-v2
