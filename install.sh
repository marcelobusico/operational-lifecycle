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
#                          Or, with LIFECYCLE_NODE=system (the `node` on your PATH) or
#                          LIFECYCLE_NODE=/path/to/node, your own Node.js 20+ and its npm instead:
#                          nothing is downloaded, and ~/.lifecycle/node-path records which one.
#                          LIFECYCLE_NODE=private goes back to the private copy. Updates keep the choice.
#   ~/.lifecycle/ca.pem    only with LIFECYCLE_CA_FILE=/path/to/root.pem (or NODE_EXTRA_CA_CERTS
#                          already set): a root certificate to trust on top of the usual ones, for
#                          networks whose proxy re-signs HTTPS. Used for every download and by the
#                          app itself. LIFECYCLE_CA_FILE=none removes it. Updates keep it.
# npm reads your own npm settings (~/.npmrc: registry, proxy, cafile), so a company registry works.
#   ~/.lifecycle/bin       the `lifecycle` command (start, stop, open, setup, update, uninstall)
#   ~/Library/LaunchAgents/<label>.plist   starts LifeCycle when you log in
#   ~/Applications/LifeCycle.app           opens LifeCycle in your browser
# Your settings and credentials (~/.lifecycle/config.json, credentials.json) are kept on a reinstall
# or update. Needs no admin password, git, Homebrew or Xcode tools: only what macOS ships with.
#
# Overrides (for tests and troubleshooting): LIFECYCLE_HOME, LIFECYCLE_PORT, LIFECYCLE_LABEL,
# LIFECYCLE_APPS_DIR, LIFECYCLE_NODE, LIFECYCLE_CA_FILE, LIFECYCLE_NODE_DIST, LIFECYCLE_NPM_REGISTRY, LIFECYCLE_NO_SETUP=1,
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
NODE_PATH_FILE="$LC_HOME/node-path"
NODE_DIST="${LIFECYCLE_NODE_DIST:-https://nodejs.org/dist/latest-v24.x}"
CA_SAVED="$LC_HOME/ca.pem"        # extra root certificate (PEM), when the network needs one
CA_BUNDLE="$LC_HOME/ca-bundle.pem" # macOS's roots plus that one, for curl
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
CA_FIX="Your network seems to re-sign HTTPS with its own certificate (a company proxy). Ask IT for its root certificate (a .pem file) and run the installer again with it: LIFECYCLE_CA_FILE=/path/to/root.pem ./install.sh"
# Picks the fix for a failed download: the certificate one when the output mentions certificates.
net_fix() { if printf '%s' "$1" | grep -qiE 'certificate|SSL|self.signed|UNABLE_TO|CERT_'; then printf '%s' "$CA_FIX"; else printf '%s %s.' "$NETWORK_FIX" "$2"; fi; }
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
# An extra root certificate: LIFECYCLE_CA_FILE, else NODE_EXTRA_CA_CERTS from this shell, else the saved one.
CA_CHOICE="${LIFECYCLE_CA_FILE:-${NODE_EXTRA_CA_CERTS:-}}"
if [ "$CA_CHOICE" = none ]; then
  rm -f "$CA_SAVED" "$CA_BUNDLE"
elif [ -n "$CA_CHOICE" ] && ! [ "$CA_CHOICE" -ef "$CA_SAVED" ]; then
  [ -f "$CA_CHOICE" ] && grep -q -- '-----BEGIN CERTIFICATE-----' "$CA_CHOICE" \
    || fail "The certificate file $CA_CHOICE is missing or is not a PEM certificate (a text file starting with -----BEGIN CERTIFICATE-----)." "Check the path, or ask IT for the root certificate in PEM format."
  cp "$CA_CHOICE" "$CA_SAVED" && chmod 644 "$CA_SAVED" || fail "Could not copy $CA_CHOICE into $LC_HOME." "Check free disk space and try again."
fi
CA=""; CA_FROM=""
[ -z "${LIFECYCLE_CA_FILE:-}" ] && [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && ! [ "$NODE_EXTRA_CA_CERTS" -ef "$CA_SAVED" ] && CA_FROM=", from NODE_EXTRA_CA_CERTS"
if [ -s "$CA_SAVED" ]; then
  cat /etc/ssl/cert.pem "$CA_SAVED" > "$CA_BUNDLE" 2>/dev/null || cp "$CA_SAVED" "$CA_BUNDLE"
  CA=yes; export NODE_EXTRA_CA_CERTS="$CA_SAVED"
fi
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
  [ -z "$CA" ] || ok "Your network's root certificate is trusted (saved as $(t "$CA_SAVED")$CA_FROM)"
else
  [ "$SRC" = "$APP" ] || rm -f "$APP/installed-commit.json"
  ok "LifeCycle's files are in $(t "$APP")"
  [ -z "$CA" ] || ok "Your network's root certificate is trusted (saved as $(t "$CA_SAVED")$CA_FROM)"
  info "This copy doesn't say which commit it is, so the app shows \"Installed version unknown\" until its first update."
fi

# ---------------------------------------------------------------------------------------------
# Which Node.js: LIFECYCLE_NODE, else the choice saved by the last install, else the private copy.
NODE_CHOICE="${LIFECYCLE_NODE:-}"
if [ -z "$NODE_CHOICE" ] && [ -s "$NODE_PATH_FILE" ]; then NODE_CHOICE="$(head -1 "$NODE_PATH_FILE")"; fi
case "$NODE_CHOICE" in ""|private) NODE_CHOICE=private ;; esac
if [ "$NODE_CHOICE" = private ]; then
step "Get Node.js (a private copy, only for LifeCycle)"
NODE="$RUNTIME/node/bin/node"
if [ -t 1 ]; then PROGRESS=--progress-bar; else PROGRESS=-sS; fi
SUMS="$(curl -fsSL --retry 2 --connect-timeout 15 ${CA:+--cacert "$CA_BUNDLE"} "$NODE_DIST/SHASUMS256.txt" 2>&1)" \
  || fail "Could not reach the Node.js download site ($NODE_DIST): ${SUMS##*curl: }" "$(net_fix "$SUMS" nodejs.org)"
LINE="$(printf '%s\n' "$SUMS" | grep " node-v[0-9.]*-darwin-$ARCH\.tar\.gz$" | head -1)"
[ -n "$LINE" ] || fail "The Node.js download site has no build for this Mac ($ARCH)." "Try again later; if it keeps happening, report it to the LifeCycle team."
SHA="${LINE%% *}"; FILE="${LINE##* }"; NODE_VERSION="$(printf '%s' "$FILE" | sed 's/^node-\(v[0-9.]*\)-.*/\1/')"
if [ -x "$NODE" ] && [ "$("$NODE" -v 2>/dev/null)" = "$NODE_VERSION" ]; then
  ok "Node.js $NODE_VERSION is already in place (private to LifeCycle)"
else
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  info "Downloading $FILE from nodejs.org (about 50 MB)…"
  curl -fSL --retry 2 --connect-timeout 15 ${CA:+--cacert "$CA_BUNDLE"} $PROGRESS -o "$TMP/$FILE" "$NODE_DIST/$FILE" \
    || fail "The Node.js download ($FILE) did not finish." "$NETWORK_FIX nodejs.org."
  [ "$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)" = "$SHA" ] \
    || fail "The downloaded Node.js file is damaged or not the official one (its checksum does not match nodejs.org's)." "Run the installer again. If it happens again, your network may be altering downloads: try another network."
  mkdir -p "$TMP/node" && tar -xzf "$TMP/$FILE" -C "$TMP/node" --strip-components 1 || fail "Could not unpack Node.js." "Check free disk space and try again."
  rm -rf "$RUNTIME/node.old"; mkdir -p "$RUNTIME"; [ -d "$RUNTIME/node" ] && mv "$RUNTIME/node" "$RUNTIME/node.old"
  mv "$TMP/node" "$RUNTIME/node" && rm -rf "$RUNTIME/node.old"
  "$NODE" -v >/dev/null 2>&1 || fail "The private Node.js does not run on this Mac." "Report it to the LifeCycle team with your macOS version ($MACOS) and chip ($CHIP)."
  ok "Node.js $NODE_VERSION installed in $(t "$RUNTIME/node") (your PATH and any other Node.js are untouched)"
fi

NPM_CLI="$RUNTIME/node/lib/node_modules/npm/bin/npm-cli.js"
rm -f "$NODE_PATH_FILE"
else
step "Use your own Node.js"
if [ "$NODE_CHOICE" = system ]; then
  CANDIDATE="$(command -v node 2>/dev/null)"
  [ -n "$CANDIDATE" ] || fail "LIFECYCLE_NODE=system was set, but there is no 'node' on your PATH." "Install Node.js 20 or newer, or point at one with LIFECYCLE_NODE=/path/to/node, or leave LIFECYCLE_NODE out to use LifeCycle's private copy."
else
  CANDIDATE="$NODE_CHOICE"
fi
case "$CANDIDATE" in /*) ;; *) fail "LIFECYCLE_NODE must be 'system', 'private' or a full path to node, and it is '$CANDIDATE'." "Use for example LIFECYCLE_NODE=/opt/homebrew/bin/node" ;; esac
[ -x "$CANDIDATE" ] || fail "There is no Node.js at $CANDIDATE." "Check the path, or install LifeCycle with its private copy: LIFECYCLE_NODE=private ./install.sh"
REAL="$("$CANDIDATE" -p 'process.execPath' 2>/dev/null)"
NODE_VERSION="$("$CANDIDATE" -v 2>/dev/null)"
[ -n "$REAL" ] && [[ "$NODE_VERSION" =~ ^v[0-9]+\. ]] || fail "$CANDIDATE did not run as Node.js." "Point LIFECYCLE_NODE at a working node, or leave it out to use LifeCycle's private copy."
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[ "$NODE_MAJOR" -ge 20 ] || fail "Your Node.js ($CANDIDATE) is $NODE_VERSION, and LifeCycle needs 20 or newer." "Update it, or leave LIFECYCLE_NODE out to use LifeCycle's private copy (your Node.js stays as it is)."
# Homebrew's and nodejs.org's links (…/bin/node) survive upgrades, so they are kept as they are.
# Anything else (nvm, fnm, Volta, asdf shims) can change with the shell, so the real file is used.
case "$CANDIDATE" in /opt/homebrew/bin/node|/usr/local/bin/node|/opt/local/bin/node) NODE="$CANDIDATE" ;; *) NODE="$REAL" ;; esac
NPM_CLI="$(dirname "$(dirname "$REAL")")/lib/node_modules/npm/bin/npm-cli.js"
[ -f "$NPM_CLI" ] || fail "Your Node.js ($REAL) has no npm next to it ($NPM_CLI)." "Install npm with that Node.js, or leave LIFECYCLE_NODE out to use LifeCycle's private copy."
printf '%s\n' "$NODE" > "$NODE_PATH_FILE"
DROP_RUNTIME=yes # the private copy is removed only once the install has finished (the service may still run on it)
ok "Using your Node.js $NODE_VERSION at $(t "$NODE") with its npm (nothing downloaded)"
case "$REAL" in
  */.nvm/*|*/fnm*|*/.volta/*|*/.asdf/*|*/.nodenv/*|*/mise/*|*/n/versions/*)
    info "It comes from a version manager. If you remove that version, LifeCycle stops starting: run this installer again (or with LIFECYCLE_NODE=private)." ;;
esac
fi

# ---------------------------------------------------------------------------------------------
step "Install LifeCycle's libraries"
# Only LifeCycle's Node.js is on PATH here, so npm and its scripts never pick up another Node.
# npm uses your own npm settings (~/.npmrc: registry, proxy, cafile); LIFECYCLE_NPM_REGISTRY overrides the registry.
NPM_PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"
[ -z "${LIFECYCLE_NPM_REGISTRY:-}" ] || export npm_config_registry="$LIFECYCLE_NPM_REGISTRY"
REGISTRY="$(cd "$APP" && PATH="$NPM_PATH" "$NODE" "$NPM_CLI" config get registry 2>/dev/null)"
REGISTRY="${REGISTRY:-https://registry.npmjs.org/}"
REGISTRY_HOST="$(printf '%s' "$REGISTRY" | sed -E 's#^[a-z]+://([^/]*).*#\1#')"
[ "$REGISTRY_HOST" = registry.npmjs.org ] || info "Using your npm registry: $REGISTRY"
NPM_OUT="$(cd "$APP" && PATH="$NPM_PATH" \
  npm_config_fetch_retries=1 npm_config_fetch_timeout=20000 npm_config_update_notifier=false \
  "$NODE" "$NPM_CLI" ci --omit=dev --no-audit --no-fund --loglevel=error 2>&1)" \
  || fail "Could not download LifeCycle's libraries from the npm registry ($REGISTRY). npm said: $(printf '%s' "$NPM_OUT" | grep -E 'npm (ERR!|error)' | grep -m1 -iE 'request to|ECONN|ENOTFOUND|ETIMEDOUT|network|certificate|code ' | sed -E 's/^npm (ERR!|error) *//')" "$(net_fix "$NPM_OUT" "$REGISTRY_HOST")"
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

[ -z "${DROP_RUNTIME:-}" ] || rm -rf "$RUNTIME"
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
