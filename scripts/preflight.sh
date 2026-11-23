#!/usr/bin/env bash
# Pre-flight check for a production deployment.
#
# Verifies the things that silently break a WhatsApp bot in production:
# Node version, persistent session dir, secrets, proxy/TLS cookie settings,
# port availability, service state and dependency health.
#
# Usage: scripts/preflight.sh

set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$APP_DIR" || { echo "✗ app dir not found: $APP_DIR"; exit 1; }

ok=0; warn=0; fail=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; ok=$((ok+1)); }
caution() { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
error() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Read a setting the way the app does: the process environment wins, and .env
# is the fallback (dotenv does NOT override an existing variable).
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
envval() {
  local key="$1" val
  val="$(printenv "$key" 2>/dev/null || true)"
  if [ -n "$val" ]; then printf '%s' "$val"; return; fi
  if [ -f "$ENV_FILE" ]; then
    val="$(sed -n "s/^${key}=//p" "$ENV_FILE" | tail -1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^"//;s/"$//')"
    printf '%s' "$val"
  fi
}

section "Runtime"
if command -v node >/dev/null 2>&1; then
  v="$(node -v)"
  major="${v#v}"; major="${major%%.*}"
  if [ "$major" -ge 20 ]; then pass "node $v"; else error "node $v is too old (need >= 20)"; fi
else
  error "node is not installed"
fi
if [ -d node_modules/baileys ] || [ -d node_modules/@whiskeysockets/baileys ]; then
  pass "dependencies installed"
else
  error "dependencies missing — run: npm ci --omit=dev"
fi

section "Configuration"
SESSION_DIR_ABS="$(envval SESSION_DIR)"; [ -n "$SESSION_DIR_ABS" ] || SESSION_DIR_ABS="$APP_DIR/session"
if [ -d "$SESSION_DIR_ABS" ]; then
  pass "session dir exists: $SESSION_DIR_ABS"
  if [ -w "$SESSION_DIR_ABS" ]; then pass "session dir is writable"; else error "session dir is NOT writable"; fi
else
  error "session dir missing: $SESSION_DIR_ABS (must be a persistent disk)"
fi
if [ -n "$(envval SESSION_SECRET)" ]; then
  pass "SESSION_SECRET is set"
else
  if [ -f "$SESSION_DIR_ABS/.session_secret" ]; then
    caution "SESSION_SECRET not set — a generated one is persisted at $SESSION_DIR_ABS/.session_secret"
  else
    error "SESSION_SECRET not set (and none persisted) — sessions will not survive a restart"
  fi
fi
if [ -n "$(envval GROQ_API_KEY)" ]; then
  pass "GROQ_API_KEY set (your own key)"
else
  caution "GROQ_API_KEY not set — ChatAI and voice-note transcription stay off"
fi
if [ -n "$(envval PUBLIC_URL)" ]; then pass "PUBLIC_URL set: $(envval PUBLIC_URL)"; else caution "PUBLIC_URL not set — invite links fall back to the request host"; fi
if [ -n "$(envval INVITE_CODE)" ] || [ -f "$SESSION_DIR_ABS/invites.json" ]; then
  pass "registration codes configured"
else
  caution "no registration codes — new signups are closed (first account = admin)"
fi

section "Network / TLS"
PORT_ABS="$(envval PORT)"; [ -n "$PORT_ABS" ] || PORT_ABS=3000
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT_ABS "; then
  pass "port $PORT_ABS is in use (service already running)"
else
  caution "port $PORT_ABS is free"
fi
TRUST_PROXY_ABS="$(envval TRUST_PROXY)"; [ -n "$TRUST_PROXY_ABS" ] || TRUST_PROXY_ABS=1
if [ "$TRUST_PROXY_ABS" = "0" ]; then
  caution "TRUST_PROXY=0 — only correct when the app is exposed directly"
else
  pass "TRUST_PROXY=$TRUST_PROXY_ABS (proxy hops trusted)"
fi
COOKIE="$(envval COOKIE_SECURE)"
if [ -z "$COOKIE" ]; then
  if [ "$(envval NODE_ENV)" = "production" ]; then pass "session cookie: secure (NODE_ENV=production)"; else pass "session cookie: insecure (development)"; fi
elif [ "$COOKIE" = "true" ]; then
  pass "session cookie: secure"
else
  caution "session cookie: NOT secure — use only over plain HTTP (a secure cookie is dropped over http:// and login loops)"
fi

section "Service"
SERVICE_ENV=""
UNITS="$(systemctl list-unit-files 2>/dev/null || true)"
if command -v systemctl >/dev/null 2>&1 && printf '%s' "$UNITS" | grep -q "autoviewer.service"; then
  state="$(systemctl is-active autoviewer.service 2>/dev/null || true)"
  if [ "$state" = "active" ]; then pass "autoviewer.service is active"; else caution "autoviewer.service is $state"; fi
  # Read the env the SERVICE actually runs with (it may differ from this shell).
  SERVICE_ENV="$(systemctl show autoviewer.service -p Environment --value 2>/dev/null || true)"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 5 "http://127.0.0.1:$PORT_ABS/health" >/dev/null 2>&1; then
      pass "health endpoint responds"
    else
      error "health endpoint did not respond on port $PORT_ABS"
    fi
  fi
  # The cookie setting that matters is the SERVICE's, not this shell's.
  case "$SERVICE_ENV" in
    *COOKIE_SECURE=true*)  pass "service cookie setting: secure" ;;
    *COOKIE_SECURE=false*) caution "service cookie setting: NOT secure (fine over plain HTTP, wrong behind TLS)" ;;
    *NODE_ENV=production*)
        # The unit sets NODE_ENV=production; COOKIE_SECURE may come from .env.
        if [ "$(envval COOKIE_SECURE)" = "false" ]; then
          caution "service cookie setting: NOT secure (NODE_ENV=production, but COOKIE_SECURE=false in .env)"
        else
          pass "service cookie setting: secure (NODE_ENV=production)"
        fi ;;
    *)                      caution "service cookie setting: not pinned" ;;
  esac
elif command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q '"name":"autoviewer"'; then
  pm2_status="$(pm2 jlist 2>/dev/null | node -e '
    try {
      const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const app = list.find(a => a.name === "autoviewer");
      console.log(app ? app.pm2_env.status : "unknown");
    } catch { console.log("unknown"); }
  ')"
  if [ "$pm2_status" = "online" ]; then
    pass "autoviewer is online under PM2"
  else
    caution "autoviewer is $pm2_status under PM2"
  fi
  if systemctl is-enabled pm2-ubuntu.service >/dev/null 2>&1; then
    pass "PM2 startup enabled on boot (pm2-ubuntu.service)"
  else
    caution "PM2 startup not enabled — run: pm2 startup"
  fi
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 5 "http://127.0.0.1:$PORT_ABS/health" >/dev/null 2>&1; then
      pass "health endpoint responds"
    else
      error "health endpoint did not respond on port $PORT_ABS"
    fi
  fi
  CS="${COOKIE_SECURE:-$(envval COOKIE_SECURE)}"
  if [ "$CS" = "true" ]; then pass "session cookie: secure"
  elif [ "$CS" = "false" ]; then caution "session cookie: NOT secure (fine over plain HTTP, wrong behind TLS)"
  elif [ "$(envval NODE_ENV)" = "production" ]; then pass "session cookie: secure (NODE_ENV=production)"
  else pass "session cookie: insecure (development)"; fi
else
  caution "autoviewer service not installed"
  # No service → judge the cookie from this shell's environment or .env.
  CS="${COOKIE_SECURE:-$(envval COOKIE_SECURE)}"
  if [ "$CS" = "true" ]; then pass "session cookie: secure"
  elif [ "$CS" = "false" ]; then caution "session cookie: NOT secure (fine over plain HTTP, wrong behind TLS)"
  elif [ "$(envval NODE_ENV)" = "production" ]; then pass "session cookie: secure (NODE_ENV=production)"
  else pass "session cookie: insecure (development)"; fi
fi

section "Duplicate instances"
if command -v ps >/dev/null 2>&1; then
  # `pgrep -f` matches its OWN command line (the pattern is in it), which
  # reports a phantom second instance. Use ps + the [a] trick instead.
  n="$(ps -eo args 2>/dev/null | grep -E '[a]utoviewer\.js' | grep -v 'bot_worker' | wc -l | tr -d ' ')"
  if [ "${n:-0}" -le 1 ]; then pass "single manager process (${n:-0})"; else error "$n manager processes running — kill the extras (they fight for the port)"; fi
fi

printf '\n\033[1mSummary:\033[0m %d ok, %d warnings, %d failures\n' "$ok" "$warn" "$fail"
[ "$fail" -eq 0 ] || exit 1
