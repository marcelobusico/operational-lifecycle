#!/bin/bash
# Last step of an upgrade started from the app (src/update/upgrade.js): swap in the new version,
# restart LifeCycle and make sure the new version answers. If it doesn't, put the previous version
# back and restart that one. Runs detached from the server (which this restart replaces), from a
# copy in ~/.lifecycle/update/, so moving the app folder never pulls the script from under itself.
#
#   bash apply-update.sh <lifecycle home> <new version folder> <commit> <port>
#
# Only ~/.lifecycle/app is swapped: settings, credentials, cache, history and logs stay as they are.
# Overrides (tests): LIFECYCLE_RESTART_CMD (instead of launchctl), LIFECYCLE_HEALTH_SECONDS.
set -uo pipefail
LC_HOME="$1"; STAGING="$2"; COMMIT="$3"; PORT="$4"; FROM="${5:-}"
APP="$LC_HOME/app"
WORK="$LC_HOME/update"
PREV="$WORK/previous"
RESULT="$WORK/result.json"
LOCK="$WORK/lock"
LOG="$LC_HOME/logs/updates.log"
SAVED_LABEL=""; [ -f "$LC_HOME/service.env" ] && . "$LC_HOME/service.env"
LABEL="${LIFECYCLE_LABEL:-${SAVED_LABEL:-com.lifecycle.server}}"
WAIT="${LIFECYCLE_HEALTH_SECONDS:-45}"
printf '{"pid": %d, "started_at": "%s", "step": "restart"}\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
finish() { # outcome, message, fix
  printf '{\n  "outcome": "%s",\n  "step": "restart",\n  "from": "%s",\n  "to": "%s",\n  "message": "%s",\n  "fix": "%s",\n  "finished_at": "%s"\n}\n' \
    "$1" "$FROM" "$COMMIT" "$2" "$3" "$(now)" > "$RESULT"
  mkdir -p "$(dirname "$LOG")"
  printf '{"at":"%s","action":"upgrade","from":%s,"to":"%s","outcome":"%s"%s}\n' "$(now)" \
    "$([ -n "$FROM" ] && printf '"%s"' "$FROM" || printf null)" "$COMMIT" "$1" "$([ "$1" = ok ] || printf ',"step":"restart"')" >> "$LOG"
  rm -f "$LOCK"
  exit 0
}
restart() {
  if [ -n "${LIFECYCLE_RESTART_CMD:-}" ]; then bash -c "$LIFECYCLE_RESTART_CMD"
  else launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1; fi
}
answers() { # true when LifeCycle answers on the port with commit $1 (any commit when empty)
  local out; out="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/update/version" 2>/dev/null)" || return 1
  [ -z "$1" ] || printf '%s' "$out" | grep -q "\"commit\": *\"$1\""
}
wait_for() { for _ in $(seq 1 $((WAIT * 2))); do answers "$1" && return 0; sleep 0.5; done; return 1; }

sleep 1 # let the server finish answering the page before it is restarted
rm -rf "$PREV"
if ! mv "$APP" "$PREV"; then
  finish failed "The new version could not be put in place, so the current one was kept." "Try again. If it keeps failing, update in Terminal: ~/.lifecycle/bin/lifecycle update"
fi
if ! mv "$STAGING" "$APP"; then
  mv "$PREV" "$APP"
  finish failed "The new version could not be put in place, so the current one was kept." "Try again. If it keeps failing, update in Terminal: ~/.lifecycle/bin/lifecycle update"
fi
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
chmod +x "$APP/bin/lifecycle" "$APP/install.sh" 2>/dev/null || true
restart
if wait_for "$COMMIT"; then
  rm -rf "$PREV"
  finish ok "LifeCycle was updated." ""
fi
# The new version didn't come up: put the previous one back and start it again.
rm -rf "$WORK/failed"; mv "$APP" "$WORK/failed"
mv "$PREV" "$APP"
restart
wait_for "$FROM" || true
rm -rf "$WORK/failed"
finish failed "The new version did not start, so LifeCycle went back to the version you had, which is running again." "Try again later. If it keeps failing, send the LifeCycle team the end of ~/.lifecycle/logs/server.log"
