#!/bin/bash
# LifeCycle installer for macOS. Guide: docs/install-mac.md
#
#   cd ~/Downloads/operational-lifecycle-main && ./install.sh
#
# Installs LifeCycle for this Mac user only, with nothing hosted anywhere:
#   ~/.lifecycle/app       LifeCycle's code (copied from the folder this script is in)
#   ~/.lifecycle/runtime   a private copy of Node.js, used only by LifeCycle. It is not added to
#                          your PATH, so any Node.js, Homebrew or developer tool you already have
#                          is left exactly as it is.
#   ~/.lifecycle/bin       the `lifecycle` command (start, stop, open, setup, update, uninstall)
#   ~/Library/LaunchAgents/<label>.plist   starts LifeCycle when you log in
#   ~/Applications/LifeCycle.app           opens LifeCycle in your browser
# Your settings and credentials (~/.lifecycle/config.json, credentials.json) are kept on a reinstall
# or update. Needs no admin password, git, Homebrew or Xcode tools: only what macOS ships with.
#
# Overrides (for tests and troubleshooting): LIFECYCLE_HOME, LIFECYCLE_PORT, LIFECYCLE_LABEL,
# LIFECYCLE_APPS_DIR, LIFECYCLE_NODE_DIST, LIFECYCLE_NPM_REGISTRY, LIFECYCLE_NO_SETUP=1,
# LIFECYCLE_NO_LAUNCHD=1, LIFECYCLE_NO_OPEN=1.
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LC_HOME="${LIFECYCLE_HOME:-$HOME/.lifecycle}"
APP="$LC_HOME/app"
RUNTIME="$LC_HOME/runtime"
BIN="$LC_HOME/bin"
PORT="${LIFECYCLE_PORT:-4317}"
LABEL="${LIFECYCLE_LABEL:-com.lifecycle.server}"
APPS_DIR="${LIFECYCLE_APPS_DIR:-$HOME/Applications}"
NODE_DIST="${LIFECYCLE_NODE_DIST:-https://nodejs.org/dist/latest-v24.x}"
NPM_REGISTRY="${LIFECYCLE_NPM_REGISTRY:-https://registry.npmjs.org/}"
TOTAL=6
STEP=0
STEP_NAME=""

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else B=""; G=""; R=""; D=""; N=""; fi

# Paths are shown as ~/… so the output stays short; commands stay copy-pasteable.
t() { case "$1" in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }
runnable() { case "$1" in *" "*) printf '"%s"' "$1" ;; *) t "$1" ;; esac; }
step() { STEP=$((STEP + 1)); STEP_NAME="$1"; printf '\n%sStep %d of %d: %s%s\n' "$B" "$STEP" "$TOTAL" "$1" "$N"; }
ok() { printf '  %s✓ %s%s\n' "$G" "$1" "$N"; }
info() { printf '  %s%s%s\n' "$D" "$1" "$N"; }
# fail "what went wrong" "what to do". Names the step, so the person knows where it stopped.
fail() {
  printf '\n%s✗ Step %d of %d (%s) did not work.%s\n' "$R" "$STEP" "$TOTAL" "$STEP_NAME" "$N" >&2
  printf '  What went wrong: %s\n' "$1" >&2
  printf '  What to do: %s\n' "$2" >&2
  printf '  Nothing outside LifeCycle'"'"'s own folder (%s) was changed. When it is fixed, run the same install command again:\n    cd %s && ./install.sh\n' "$(t "$LC_HOME")" "$(runnable "$SRC")" >&2
  exit 1
}
NETWORK_FIX="Check that you are connected to the internet (open any website in your browser). If you are on a company VPN or network that blocks downloads, try another network or ask IT to allow"

# ---------------------------------------------------------------------------------------------
step "Check this Mac"
[ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS, and this computer runs $(uname -s)." "Use a Mac, or see the README for a manual install."
MACOS="$(sw_vers -productVersion)"
MAJOR="${MACOS%%.*}"; REST="${MACOS#*.}"; MINOR="${REST%%.*}"; [ "$REST" = "$MACOS" ] && MINOR=0
if [ "$MAJOR" -lt 13 ] || { [ "$MAJOR" -eq 13 ] && [ "$MINOR" -lt 5 ]; }; then
  fail "This Mac runs macOS $MACOS. LifeCycle needs macOS 13.5 (Ventura) or newer." "Update macOS in System Settings → General → Software Update, then run the installer again."
fi
# hw.optional.arm64 is 1 on Apple Silicon even when this Terminal runs under Rosetta.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then ARCH=arm64; CHIP="Apple Silicon (M1 or newer)"; else ARCH=x64; CHIP="Intel"; fi
for tool in curl tar shasum launchctl; do
  command -v "$tool" >/dev/null 2>&1 || fail "The macOS tool '$tool' is missing." "This is part of every Mac. Restart the Mac and try again; if it is still missing, ask IT."
done
[ -f "$SRC/package.json" ] && [ -f "$SRC/src/server.js" ] || fail "This folder does not look like LifeCycle ($SRC)." "Download LifeCycle again (GitHub → Code → Download ZIP) and run install.sh from the unzipped folder."
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -1)"
ok "macOS $MACOS on $CHIP. Installing LifeCycle $VERSION in $(t "$LC_HOME")"

# ---------------------------------------------------------------------------------------------
step "Copy LifeCycle onto this Mac"
mkdir -p "$LC_HOME" && chmod 700 "$LC_HOME" || fail "Could not create $LC_HOME." "Check that your home folder is not full (Apple menu → About This Mac → Storage)."
if [ "$SRC" != "$APP" ]; then
  rm -rf "$APP.new" && mkdir -p "$APP.new" || fail "Could not write to $LC_HOME." "Check free disk space and try again."
  (cd "$SRC" && tar --exclude ./node_modules --exclude ./.git --exclude ./.lifecycle --exclude ./installed-commit.json -cf - .) | (cd "$APP.new" && tar -xf -) \
    || fail "Could not copy the LifeCycle files into $APP." "Check free disk space and try again."
  rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"
  mv "$APP.new" "$APP" && rm -rf "$APP.old"
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
chmod +x "$APP/bin/lifecycle" "$APP/install.sh"
mkdir -p "$BIN" && ln -sf "$APP/bin/lifecycle" "$BIN/lifecycle"
# Which `main` commit this is, so the app can tell when a newer one exists (src/update/check.js).
# GitHub fills in .lifecycle-source in every ZIP and tarball (export-subst, see .gitattributes);
# a git working copy has git itself; an upgrade passes LIFECYCLE_INSTALL_COMMIT.
COMMIT="${LIFECYCLE_INSTALL_COMMIT:-}"; COMMIT_DATE="${LIFECYCLE_INSTALL_COMMIT_DATE:-}"
if [ -z "$COMMIT" ] && [ -f "$SRC/.lifecycle-source" ]; then
  read -r c d _ < "$SRC/.lifecycle-source" || true
  if [[ "${c:-}" =~ ^[0-9a-f]{40}$ ]]; then COMMIT="$c"; COMMIT_DATE="${d:-}"; fi
fi
if [ -z "$COMMIT" ] && [ -d "$SRC/.git" ] && command -v git >/dev/null 2>&1; then
  COMMIT="$(git -C "$SRC" rev-parse HEAD 2>/dev/null)"; COMMIT_DATE="$(git -C "$SRC" log -1 --format=%cI 2>/dev/null)"
fi
if [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  printf '{\n  "commit": "%s",\n  "date": "%s",\n  "installed_at": "%s"\n}\n' "$COMMIT" "$COMMIT_DATE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$APP/installed-commit.json"
  ok "LifeCycle's files are in $(t "$APP") (commit ${COMMIT:0:7} of main)"
else
  [ "$SRC" = "$APP" ] || rm -f "$APP/installed-commit.json"
  ok "LifeCycle's files are in $(t "$APP")"
  info "This copy doesn't say which commit it is, so the app shows \"Installed version unknown\" until its first update."
fi

# ---------------------------------------------------------------------------------------------
step "Get Node.js (a private copy, only for LifeCycle)"
NODE="$RUNTIME/node/bin/node"
if [ -t 1 ]; then PROGRESS=--progress-bar; else PROGRESS=-sS; fi
SUMS="$(curl -fsSL --retry 2 --connect-timeout 15 "$NODE_DIST/SHASUMS256.txt" 2>&1)" \
  || fail "Could not reach the Node.js download site ($NODE_DIST): ${SUMS##*curl: }" "$NETWORK_FIX nodejs.org."
LINE="$(printf '%s\n' "$SUMS" | grep " node-v[0-9.]*-darwin-$ARCH\.tar\.gz$" | head -1)"
[ -n "$LINE" ] || fail "The Node.js download site has no build for this Mac ($ARCH)." "Try again later; if it keeps happening, report it to the LifeCycle team."
SHA="${LINE%% *}"; FILE="${LINE##* }"; NODE_VERSION="$(printf '%s' "$FILE" | sed 's/^node-\(v[0-9.]*\)-.*/\1/')"
if [ -x "$NODE" ] && [ "$("$NODE" -v 2>/dev/null)" = "$NODE_VERSION" ]; then
  ok "Node.js $NODE_VERSION is already in place (private to LifeCycle)"
else
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  info "Downloading $FILE from nodejs.org (about 50 MB)…"
  curl -fSL --retry 2 --connect-timeout 15 $PROGRESS -o "$TMP/$FILE" "$NODE_DIST/$FILE" \
    || fail "The Node.js download ($FILE) did not finish." "$NETWORK_FIX nodejs.org."
  [ "$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)" = "$SHA" ] \
    || fail "The downloaded Node.js file is damaged or not the official one (its checksum does not match nodejs.org's)." "Run the installer again. If it happens again, your network may be altering downloads: try another network."
  mkdir -p "$TMP/node" && tar -xzf "$TMP/$FILE" -C "$TMP/node" --strip-components 1 || fail "Could not unpack Node.js." "Check free disk space and try again."
  rm -rf "$RUNTIME/node.old"; mkdir -p "$RUNTIME"; [ -d "$RUNTIME/node" ] && mv "$RUNTIME/node" "$RUNTIME/node.old"
  mv "$TMP/node" "$RUNTIME/node" && rm -rf "$RUNTIME/node.old"
  "$NODE" -v >/dev/null 2>&1 || fail "The private Node.js does not run on this Mac." "Report it to the LifeCycle team with your macOS version ($MACOS) and chip ($CHIP)."
  ok "Node.js $NODE_VERSION installed in $(t "$RUNTIME/node") (your PATH and any other Node.js are untouched)"
fi

# ---------------------------------------------------------------------------------------------
step "Install LifeCycle's libraries"
# Only the private Node.js is on PATH here, so npm and its scripts never pick up another Node.
NPM_OUT="$(cd "$APP" && PATH="$RUNTIME/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" npm_config_registry="$NPM_REGISTRY" \
  npm_config_fetch_retries=1 npm_config_fetch_timeout=20000 npm_config_update_notifier=false \
  "$NODE" "$RUNTIME/node/lib/node_modules/npm/bin/npm-cli.js" ci --omit=dev --no-audit --no-fund --loglevel=error 2>&1)" \
  || fail "Could not download LifeCycle's libraries from the npm registry ($NPM_REGISTRY). npm said: $(printf '%s' "$NPM_OUT" | grep -E 'npm (ERR!|error)' | grep -m1 -iE 'request to|ECONN|ENOTFOUND|ETIMEDOUT|network|code ' | sed -E 's/^npm (ERR!|error) *//')" "$NETWORK_FIX registry.npmjs.org."
ok "Libraries installed"

# ---------------------------------------------------------------------------------------------
step "Connect to GitHub (first-run setup)"
# A setup that can't finish never stops the install: LifeCycle still gets installed, and the end
# message says GitHub is not connected yet (setup exits 2 when its answers are saved but GitHub
# access doesn't work yet).
SETUP_CMD="$(runnable "$BIN/lifecycle") setup"
CONNECTED=no
if [ -n "${LIFECYCLE_NO_SETUP:-}" ]; then
  info "Skipped (LIFECYCLE_NO_SETUP is set)."
elif [ -f "$LC_HOME/credentials.json" ] && [ -f "$LC_HOME/config.json" ]; then
  CONNECTED=yes
  ok "Your settings were kept. To change them later: $SETUP_CMD"
elif { : </dev/tty; } 2>/dev/null; then
  if LIFECYCLE_HOME="$LC_HOME" "$NODE" "$APP/src/cli/setup.js" </dev/tty; then CONNECTED=yes
  else printf '  ! GitHub is not connected yet. The install carries on; connect it afterwards with: %s\n' "$SETUP_CMD"; fi
else
  info "No keyboard to answer setup questions here. Run it afterwards with: $SETUP_CMD"
fi

# ---------------------------------------------------------------------------------------------
step "Start LifeCycle and open it"
if [ -n "${LIFECYCLE_NO_LAUNCHD:-}" ]; then
  # Test/override mode: write nothing outside LifeCycle's folder (no LaunchAgent, no app).
  info "Not started, and not set to start at login (LIFECYCLE_NO_LAUNCHD is set)."
else
  LIFECYCLE_HOME="$LC_HOME" LIFECYCLE_PORT="$PORT" LIFECYCLE_LABEL="$LABEL" LIFECYCLE_APPS_DIR="$APPS_DIR" \
    "$APP/bin/lifecycle" install-service || fail "Could not set LifeCycle to start on its own." "See the message above, then run the installer again."
  LIFECYCLE_HOME="$LC_HOME" LIFECYCLE_PORT="$PORT" LIFECYCLE_LABEL="$LABEL" "$APP/bin/lifecycle" start \
    || fail "LifeCycle did not start." "See the message above. The server log is $(t "$LC_HOME/logs/server.log")"
  [ -n "${LIFECYCLE_NO_OPEN:-}" ] || open "http://lifecycle.localhost:$PORT"
fi

L="$(runnable "$BIN/lifecycle")"
if [ "$CONNECTED" = yes ]; then
  printf '\n%s✓ LifeCycle is installed.%s\n' "$G" "$N"
else
  printf '\n%s! Almost done: LifeCycle is installed, but not connected to GitHub yet,%s\n' "$B" "$N"
  printf '  so your roadmap stays empty until you run this (two questions):\n    %s\n\n' "$SETUP_CMD"
fi
cat <<EOF
  Open it:        http://lifecycle.localhost:$PORT  (or type LifeCycle in Spotlight: Command + Space)
  After a reboot: nothing to do. LifeCycle starts on its own when you log in.
  Change setup:   $L setup
  Update:         $L update
  Uninstall:      $L uninstall
EOF
