# Zen Tree Tabs

Sidebery-style **tree tabs** built into [Zen Browser](https://zen-browser.app)'s own sidebar — no extension, no second tab list. Tabs nest under the tab they were opened from, subtrees collapse, and drag & drop lets you pick the nesting depth.

It's a userChrome.js mod (loaded with [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig)), so it works on Zen's real tab strip and plays along with spaces, split views, pinned tabs and folders.

## Features

- **Automatic nesting** — tabs opened from a link become children of that tab.
- **New tabs (Ctrl+T)** go right below the current tab, as its sibling (configurable: sibling / child / end).
- **Indentation & guide lines** — uses Zen's native indent (same step as its folders) plus thin per-level lines.
- **Collapse / expand** — hover a parent's favicon to get a chevron; collapsed parents show a badge with the number of hidden tabs. Selecting a hidden tab (Ctrl+Tab, search…) expands its branch.
- **Drag & drop with depth picking** — the drop line shows where the tab lands and at what level; drag sideways to nest deeper or pull out. The future parent is highlighted (or the space header, for a top-level drop). Subtrees move along with their root.
- **Split views are tree nodes** — a split nests, has children, and drags as one unit. Drag-onto-a-tab splitting still works (hover a tab's middle).
- **Pinned tabs have their own tree** per space. Pinning/unpinning a tab moves its whole subtree; you can drag between the pinned and normal trees at any depth.
- **Closing a parent** moves its children up one level.
- **Persistent** — the tree survives restarts and "undo close tab" (stored via SessionStore).

Zen's own folders and Essentials are left alone.

## Install

Requirements: Zen Browser (developed against **1.22.3b**, Firefox 156 base) on Linux, installed either natively (distro package, tarball) or as a **Flatpak**. Other OSes work the same way but `install.sh` assumes Linux paths.

**Quit Zen first**, and consider backing up your profile (see [Backup & uninstall](#backup--uninstall)).

```sh
git clone https://github.com/tworekj/zen-tree-tabs.git
cd zen-tree-tabs
./install.sh --dry-run            # optional: show what would be done, change nothing
./install.sh                      # native install
./install.sh --flatpak            # Flatpak install (see below)
./install.sh "/path/to/zen/profile"   # explicit profile (works with either mode)
```

The script:

1. detects Zen's program directory and default profile (override with `ZEN_INSTALL` / `ZEN_ROOT`, or pass the profile path),
2. clones fx-autoconfig into `vendor/` (set `FXAC_REF=<tag>` to pin a specific tag or branch),
3. backs up an existing `chrome/` folder to `chrome.bak-<timestamp>` the first time (when it has no `chrome/utils/` yet),
4. copies the fx-autoconfig loader files into your profile's `chrome/utils/`,
5. links (native) or copies (Flatpak) `src/zen-tree-tabs.uc.js` → `chrome/JS/` and `src/zen-tree-tabs.css` → `chrome/resources/`,
6. installs the one-time program-side loader (`config.js`, `config-prefs.js`) into the Zen program directory — automatically if that directory is writable by you, with `sudo` if you pass `--sudo`, otherwise it prints the `sudo` commands for you to run.

Restart Zen. In the Browser Console (Ctrl+Shift+J) you should see `[zen-tree-tabs] loaded, script saved …`. If nothing loads on the very first install, use **about:support → Clear startup cache…** once.

> A Zen update may replace its program directory. If the mod stops loading after an update, re-run `./install.sh` (or the two `sudo cp` commands it prints).

### Flatpak install

> Flatpak support is **experimental** — please report what you see on your setup.

For Zen installed from Flathub (`app.zen_browser.zen`):

```sh
./install.sh --flatpak --sudo                   # --sudo is needed for system-wide Flatpak installs
flatpak run app.zen_browser.zen -purgecaches    # first launch only, after fully quitting Zen
```

If Zen was installed system-wide (`flatpak install` without `--user`; the app directory is under `/var/lib/flatpak`), the loader has to be written with root rights. Without `--sudo` the script only **prints** the `sudo` commands, and the mod will not load until you run them. A `--user` install needs neither.

Use `--app-id` if your Flatpak app id differs (check with `flatpak list | grep -i zen`):

```sh
./install.sh --flatpak --app-id org.example.Zen
```

How it differs from a native install:

| | Native | Flatpak |
|---|---|---|
| Program directory | e.g. `/opt/zen-browser-bin` (auto-detected) | the app's deployed files, found via `flatpak info --show-location` |
| Loader install | needs `sudo` if the directory is root-owned | automatic for `flatpak install --user`; **system-wide** installs need `--sudo` (or run the printed commands) |
| Profile location | `~/.zen` or `~/.config/zen` | under `~/.var/app/<app-id>/` (usually `.zen/`) |
| Mod files in profile | **symlinks** to this clone | **copies** — the sandbox can't follow symlinks into your clone |
| After editing `src/` | press Ctrl+Alt+Shift+R | re-run `./install.sh --flatpak`, then Ctrl+Alt+Shift+R |
| After a Zen update | re-run if the mod stops loading | re-run — an update replaces the app files and **drops the loader** |

Tips:

- Confirm the script picked the right profile: it prints `Profile: …`; compare with **about:support → Profile Folder**.
- Nothing needs to be granted to the sandbox (no `--filesystem` overrides): everything lives in the app's own deployment and data directory.
- `flatpak repair` may also remove the added loader files; re-run the script if that happens.

### Backup & uninstall

Back up before the first install (Zen closed). Examples:

```sh
cp -a ~/.zen                         ~/zen-backup-$(date +%F)    # native (or ~/.config/zen)
cp -a ~/.var/app/app.zen_browser.zen ~/zen-backup-$(date +%F)    # Flatpak
```

- **Remove the mod only:** `./install.sh --uninstall` (add `--flatpak` for Flatpak) deletes the mod's two files from the profile and leaves the loader and `chrome/utils` in place, since other userChrome scripts may use them. It prints which loader files to delete if you want those gone too.
- **Disable temporarily:** delete or rename `chrome/JS/zen-tree-tabs.uc.js` in your profile and restart.
- **Full restore:** quit Zen, delete the profile (or data) folder and copy your backup back.

### Troubleshooting

| Symptom | Try |
|---|---|
| Script finished but nothing changed (Flatpak, system-wide install) | The loader was only printed, not installed. Re-run `./install.sh --flatpak --sudo`, then quit Zen and run `flatpak run app.zen_browser.zen -purgecaches` |
| `Sandbox: CanCreateUserNamespace() clone() failure: EPERM` in the terminal | Harmless nested-sandbox notice from Flatpak browsers; unrelated to this mod |
| Check that the loader is active | In `about:config`, `general.config.filename` should be `config.js`. If it isn't, the loader files are missing from the app directory |
| No `[zen-tree-tabs] loaded` in the Browser Console | Run Zen once with `-purgecaches` (Flatpak: `flatpak run app.zen_browser.zen -purgecaches`), or **about:support → Clear startup cache…** |
| Worked, stopped after a Zen update | Re-run `./install.sh` (add `--flatpak` for Flatpak) |
| Script says it can't detect the profile | Pass it explicitly: `./install.sh [--flatpak] "/path/to/profile"` |
| `fx-autoconfig layout changed` | Pin a known-good tag: `FXAC_REF=<tag> ./install.sh` (remove `vendor/fx-autoconfig` first) |
| Flatpak: edits to `src/` have no effect | Files are copies — re-run `./install.sh --flatpak`, then Ctrl+Alt+Shift+R |

## Usage

| Action | How |
|---|---|
| Nest a tab | Open it from a link, or drag it and move the pointer **right** (one indent ≈ one level) |
| Un-nest | Drag and move the pointer **left** |
| Collapse / expand | Hover a parent's favicon → click the chevron |
| Move a whole branch | Drag its root tab |
| Pin a branch | Pin its root (context menu or drag into the pinned area) |
| Make a split | Drag a tab onto the middle of another tab and hold briefly |
| Reload the mod | **Ctrl+Alt+Shift+R** (picks up edits to the JS and CSS, no restart) |

## Settings (`about:config`)

| Pref | Type | Default | Meaning |
|---|---|---|---|
| `zen-tree-tabs.newtab-position` | string | `sibling` | Where Ctrl+T / new-tab-button tabs go: `sibling` (below the current tab, same level), `child` (last child of the current tab), `end` (end of the list) |
| `zen-tree-tabs.block-tab-split` | bool | `false` | Disable Zen's drag-onto-a-tab split view while dragging tree tabs |
| `zen-tree-tabs.debug` | bool | `false` | Log drag/drop and tree decisions to the Browser Console (takes effect immediately) |

Create a pref with the **+** button if it doesn't exist yet.

Look & feel lives in `src/zen-tree-tabs.css` (`--ztt-guide-width`, `--ztt-guide-color`, badge style…). The indent step is `INDENT_PX` in the script.

## Development

- Native installs: edit files in `src/` — they're symlinked into the profile — then press **Ctrl+Alt+Shift+R** in Zen.
- Flatpak installs: the profile holds copies, so re-run `./install.sh --flatpak` after editing, then press **Ctrl+Alt+Shift+R**.
- `node tests/scenarios.mjs` runs the tree logic against a mocked tab strip (no browser needed) and prints the resulting trees for nesting, drag/drop, splits, pinned tabs and new-tab placement.
- How it works and which Zen internals it relies on: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Known limitations

- Relies on Zen/Firefox internals (see the architecture doc); a Zen update can break it.
- Tabs inside Zen folders and Essentials are not part of the tree.
- Links and Ctrl+T from a pinned tab open normal tabs, which aren't nested (they're in the other section).
- Multi-selected tabs (other than the tabs of one split) are dragged by Zen without tree handling.
- Pinning a branch pins its tabs one by one, which can take a moment for large branches.
- Flatpak: the loader lives in the app deployment, so it must be re-installed after each Zen update (re-run `./install.sh --flatpak`).

## License

[MIT](LICENSE)