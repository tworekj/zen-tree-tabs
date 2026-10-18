#!/usr/bin/env bash
# Installs fx-autoconfig (profile side) and Zen Tree Tabs into a Zen profile.
#
# Usage: ./install.sh [options] [path/to/zen/profile]
#   --flatpak          Zen is installed as a Flatpak (copies files instead of symlinking)
#   --app-id ID        Flatpak app id (default: app.zen_browser.zen)
#   --sudo             Run the loader install with sudo when the program directory is root-owned
#   --dry-run          Print what would be done; change nothing
#   --uninstall        Remove the mod's files from the profile (loader is left alone)
#   -h, --help         Show this help
#
# Environment overrides (native installs):
#   ZEN_ROOT      directory holding installs.ini / profiles.ini  (default: auto, ~/.zen or ~/.config/zen)
#   ZEN_INSTALL   Zen program directory (contains application.ini) (default: auto-detected)
#   FXAC_REF      fx-autoconfig branch or tag to clone (default: its default branch)
#
# Notes:
#  - Quit Zen before running.
#  - Flatpak: the sandbox cannot follow symlinks into this clone, so files are copied.
#    Re-run after editing src/ and after every Flatpak update of Zen (an update
#    replaces the app files, which drops the loader).
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
fxac_url="https://github.com/MrOtherGuy/fx-autoconfig.git"
app_id="app.zen_browser.zen"
flatpak_mode=0 dry=0 uninstall=0 use_sudo=0
profile=""

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
run() {
  if ((dry)); then printf '  [dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --flatpak)   flatpak_mode=1; shift ;;
    --app-id)    app_id="${2:?--app-id needs a value}"; shift 2 ;;
    --sudo)      use_sudo=1; shift ;;
    --dry-run)   dry=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    -*)          die "unknown option: $1 (see --help)" ;;
    *)           profile="$1"; shift ;;
  esac
done

# ---- locate Zen's program directory and data root ---------------------------------------
zen_root="" zen_install=""

if ((flatpak_mode)); then
  command -v flatpak >/dev/null || die "flatpak is not installed"
  flatpak info "$app_id" >/dev/null 2>&1 \
    || die "Flatpak app '$app_id' is not installed (try: flatpak list | grep -i zen)"
  files="$(flatpak info --show-location "$app_id")/files"
  appini="$(find "$files" -maxdepth 3 -name application.ini -print -quit 2>/dev/null || true)"
  [[ -n "$appini" ]] || die "could not find application.ini under $files"
  zen_install="$(dirname "$appini")"

  data="$HOME/.var/app/$app_id"
  [[ -d "$data" ]] || die "no Flatpak data dir at $data — start Zen once first"
  ini="$(find "$data" -maxdepth 4 \( -name installs.ini -o -name profiles.ini \) -print 2>/dev/null | sort | head -n1 || true)"
  if [[ -n "$ini" ]]; then zen_root="$(dirname "$ini")"; fi
else
  zen_root="${ZEN_ROOT:-}"
  if [[ -z "$zen_root" ]]; then
    for d in "$HOME/.zen" "$HOME/.config/zen"; do
      if [[ -f "$d/installs.ini" || -f "$d/profiles.ini" ]]; then zen_root="$d"; break; fi
    done
    zen_root="${zen_root:-$HOME/.zen}"
  fi

  zen_install="${ZEN_INSTALL:-}"
  if [[ -z "$zen_install" ]]; then
    cands=(/opt/zen-browser-bin /opt/zen /usr/lib/zen /usr/lib64/zen "$HOME/.local/share/zen")
    if bin="$(command -v zen 2>/dev/null)" && [[ -n "$bin" ]]; then
      cands=("$(dirname "$(readlink -f "$bin")")" "${cands[@]}")
    fi
    for d in "${cands[@]}"; do
      if [[ -f "$d/application.ini" ]]; then zen_install="$d"; break; fi
    done
    zen_install="${zen_install:-/opt/zen-browser-bin}"
  fi
fi

# ---- locate the profile ---------------------------------------------------------------
detect_profile() {
  local rel=""
  [[ -n "$zen_root" ]] || return 1
  if [[ -f "$zen_root/installs.ini" ]]; then
    rel="$(awk '/^Default=/{sub(/^Default=/,""); print; exit}' "$zen_root/installs.ini")"
  fi
  if [[ -z "$rel" && -f "$zen_root/profiles.ini" ]]; then
    rel="$(awk '/^\[Install/{s=1;next} /^\[/{s=0} s&&/^Default=/{sub(/^Default=/,""); print; exit}' "$zen_root/profiles.ini")"
  fi
  [[ -n "$rel" ]] || return 1
  case "$rel" in /*) printf '%s\n' "$rel" ;; *) printf '%s\n' "$zen_root/$rel" ;; esac
}

if [[ -z "$profile" ]]; then
  profile="$(detect_profile)" || die "could not detect the default profile; pass its path as an argument"
fi
[[ -d "$profile" ]] || die "profile not found: $profile"
say "Profile: $profile"
if ((flatpak_mode)); then say "Flatpak app directory: $zen_install"; else say "Zen program directory: $zen_install"; fi
chrome="$profile/chrome"

# ---- uninstall ------------------------------------------------------------------------
if ((uninstall)); then
  run rm -f "$chrome/JS/zen-tree-tabs.uc.js" "$chrome/resources/zen-tree-tabs.css"
  say "Removed Zen Tree Tabs from the profile. Restart Zen."
  say "The fx-autoconfig loader and chrome/utils were left in place (other scripts may use them)."
  say "To remove the loader too, delete these (with sudo if needed):"
  say "  $zen_install/config.js"
  say "  $zen_install/defaults/pref/config-prefs.js"
  exit 0
fi

# ---- fetch fx-autoconfig --------------------------------------------------------------
fxac="$repo/vendor/fx-autoconfig"
[[ -f "$repo/src/zen-tree-tabs.uc.js" && -f "$repo/src/zen-tree-tabs.css" ]] \
  || die "run this from the zen-tree-tabs repo (src/ files not found)"

if [[ ! -d "$fxac" ]]; then
  command -v git >/dev/null || die "git is required to fetch fx-autoconfig"
  clone_args=(--depth 1)
  if [[ -n "${FXAC_REF:-}" ]]; then clone_args+=(--branch "$FXAC_REF"); fi
  run git clone "${clone_args[@]}" "$fxac_url" "$fxac"
fi
if ((!dry)); then
  for f in program/config.js program/defaults/pref/config-prefs.js profile/chrome/utils; do
    [[ -e "$fxac/$f" ]] || die "fx-autoconfig layout changed: missing $f (try FXAC_REF=<known-good tag>)"
  done
fi

# ---- first-time backup of an existing chrome/ folder ----------------------------------
if [[ -d "$chrome" && ! -d "$chrome/utils" ]]; then
  bak="$chrome.bak-$(date +%Y%m%d-%H%M%S)"
  say "Backing up existing chrome/ -> $bak"
  run cp -a "$chrome" "$bak"
fi

# ---- profile side ---------------------------------------------------------------------
run mkdir -p "$chrome/JS" "$chrome/resources" "$chrome/utils"
run cp -r "$fxac/profile/chrome/utils/." "$chrome/utils/"
if ((flatpak_mode)); then
  run rm -f "$chrome/JS/zen-tree-tabs.uc.js" "$chrome/resources/zen-tree-tabs.css"
  run cp "$repo/src/zen-tree-tabs.uc.js" "$chrome/JS/zen-tree-tabs.uc.js"
  run cp "$repo/src/zen-tree-tabs.css"   "$chrome/resources/zen-tree-tabs.css"
else
  run ln -sfn "$repo/src/zen-tree-tabs.uc.js" "$chrome/JS/zen-tree-tabs.uc.js"
  run ln -sfn "$repo/src/zen-tree-tabs.css"   "$chrome/resources/zen-tree-tabs.css"
fi
run rm -f "$chrome/CSS/zen-tree-tabs.uc.css"   # older layout; the script loads its own CSS now
say "Profile side installed."

# ---- program side (one-time loader) ---------------------------------------------------
if [[ -f "$zen_install/config.js" ]]; then
  say "Loader already present in $zen_install."
elif [[ -w "$zen_install" ]]; then
  run mkdir -p "$zen_install/defaults/pref"
  run cp "$fxac/program/config.js" "$zen_install/"
  run cp "$fxac/program/defaults/pref/config-prefs.js" "$zen_install/defaults/pref/"
  say "Loader installed into $zen_install."
elif ((use_sudo)); then
  say "Installing the loader with sudo into $zen_install"
  run sudo mkdir -p "$zen_install/defaults/pref"
  run sudo cp "$fxac/program/config.js" "$zen_install/"
  run sudo cp "$fxac/program/defaults/pref/config-prefs.js" "$zen_install/defaults/pref/"
  say "Loader installed."
else
  say
  say "!! The mod will NOT load until the loader is installed into the Zen program directory"
  say "!! (it is root-owned). Re-run with --sudo, or run these yourself:"
  say "  sudo mkdir -p '$zen_install/defaults/pref'"
  say "  sudo cp '$fxac/program/config.js' '$zen_install/'"
  say "  sudo cp '$fxac/program/defaults/pref/config-prefs.js' '$zen_install/defaults/pref/'"
fi

# ---- next steps -----------------------------------------------------------------------
say
if ((dry)); then say "Dry run: nothing was changed."; say; fi
if ((flatpak_mode)); then
  say "Fully quit Zen, then start it once with:  flatpak run $app_id -purgecaches"
  say "Edits to src/ need this script re-run (files are copies), then Ctrl+Alt+Shift+R in Zen."
  say "After a Flatpak update of Zen, re-run this script."
else
  say "Then restart Zen. Afterwards, edits reload with Ctrl+Alt+Shift+R (no restart,"
  say "no cache clearing). If the script doesn't load at all, open about:support and"
  say "use 'Clear startup cache…' once."
fi