#!/usr/bin/env bash
#
# Run the devpanel GUI.
#
#   ./start.sh          production — serves the built app from dist/ (one process)
#   ./start.sh dev      development — Vite dev server + API, both with live reload
#
# Environment:
#   PORT              API/app port                      (default 443)
#   HOST              API/app bind address, or a comma-separated list (default 0.0.0.0)
#   DEVPANEL_DEV_PORT Vite dev server port, dev only    (default 5173)
#   DEVPANEL_TICK_MS  metrics broadcast interval in ms  (default 2000)
#   DEVPANEL_TLS      set to 0 to serve plain HTTP      (default on)
#   DEVPANEL_CERT_DIR where localhost.crt/.key live     (default <dataRoot>/cert, else ../cert)
#
# Runs entirely as the invoking user (the project owner) — never as root. Port 443 works
# unprivileged because /usr/bin/node-22 carries cap_net_bind_service.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

MODE="${1:-prod}"

# Starting a second copy by hand is how you end up with several panels and one
# port: the newcomer loses the bind, and the browser keeps talking to whichever
# process won — usually the oldest one, running the oldest code.
# A user-level service (systemctl --user) on another port is another instance
# with its own data root and is left alone; only the same port is a conflict.
if systemctl is-active --quiet devpanel.service 2>/dev/null; then
  printf '\033[33mwarning:\033[0m devpanel.service is already running this panel.\n' >&2
  printf '         Use it instead of starting a second copy:\n' >&2
  printf '           systemctl restart devpanel      # pick up code changes\n' >&2
  printf '           journalctl -u devpanel -f       # follow its log\n' >&2
  printf '         Continuing anyway would leave two processes competing for the port.\n' >&2
  exit 1
fi

if command -v ss >/dev/null 2>&1; then
  if ss -Hltn "sport = :${PORT:-443}" 2>/dev/null | grep -q .; then
    printf '\033[33mwarning:\033[0m port %s is already in use (another devpanel?).\n' "${PORT:-443}" >&2
    printf '         Stop it first, or start this one on another PORT.\n' >&2
    exit 1
  fi
elif pgrep -f 'node.*server/index\.js' >/dev/null 2>&1; then
  printf '\033[33mwarning:\033[0m another devpanel process is already running.\n' >&2
  printf '         Stop it first:  pkill -f '"'"'node.*server/index\.js'"'"'\n' >&2
  exit 1
fi

say () { printf '\033[36m==>\033[0m %s\n' "$*"; }
die () { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is not installed or not on PATH"

if [[ ! -d node_modules ]]; then
  die "dependencies are missing — run ./install.sh first"
fi

export PORT="${PORT:-443}"
export HOST="${HOST:-0.0.0.0}"

SCHEME=https
if [[ "${DEVPANEL_TLS:-1}" == "0" ]]; then
  SCHEME=http
else
  CERT_DIR="${DEVPANEL_CERT_DIR:-$(node "$HERE/tools/data-path.mjs" cert)}"
  if [[ ! -f "$CERT_DIR/localhost.crt" || ! -f "$CERT_DIR/localhost.key" ]]; then
    say "no certificate yet — generating one"
    ./make-cert.sh
  fi
fi

# Refuse to bind a privileged port without the capability that makes it possible,
# rather than failing with a bare EACCES after startup.
if (( PORT < 1024 )) && command -v getcap >/dev/null 2>&1; then
  NODE_REAL="$(readlink -f "$(command -v node)")"
  if ! getcap "$NODE_REAL" 2>/dev/null | grep -q cap_net_bind_service; then
    die "port ${PORT} needs cap_net_bind_service on ${NODE_REAL}, which it does not have.
       Either use a port above 1024 (PORT=3000 ./start.sh) or have an administrator run:
         sudo setcap cap_net_bind_service=ep ${NODE_REAL}"
  fi
fi

# A bind address is not a browsable host name.
display_host () {
  if [[ "$HOST" == "0.0.0.0" || "$HOST" == "::" ]]; then
    # os.hostname() rather than `hostname -f`, which reports "localhost" here —
    # and it is what the certificate's CN was built from.
    node -e 'process.stdout.write(require("os").hostname())' 2>/dev/null || hostname
  else
    echo "$HOST"
  fi
}
# Omit the port when it is the scheme's default.
display_port () {
  if [[ ( "$SCHEME" == https && "$1" == 443 ) || ( "$SCHEME" == http && "$1" == 80 ) ]]; then echo ""; else echo ":$1"; fi
}

case "$MODE" in
  dev)
    export DEVPANEL_DEV_PORT="${DEVPANEL_DEV_PORT:-5173}"
    say "development mode"
    say "  app  ${SCHEME}://$(display_host):${DEVPANEL_DEV_PORT}   (open this one — it hot-reloads)"
    say "  api  ${SCHEME}://$(display_host)$(display_port "$PORT")"
    # concurrently forwards SIGINT to both children, so one Ctrl-C stops everything.
    exec npm run dev
    ;;

  prod|start|'')
    if [[ ! -f dist/index.html ]]; then
      say "no build found — building now"
      npm run build
    fi
    say "production mode"
    say "  app  ${SCHEME}://$(display_host)$(display_port "$PORT")"
    exec node server/index.js
    ;;

  -h|--help|help)
    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;

  *)
    die "unknown mode '${MODE}' — expected 'dev' or 'prod' (see ./start.sh --help)"
    ;;
esac
