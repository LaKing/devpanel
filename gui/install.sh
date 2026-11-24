#!/usr/bin/env bash
#
# One-time setup for the devpanel GUI: install dependencies, build the Vue app,
# and install the systemd service. Safe to re-run — it is how you pick up
# dependency changes.
#
#   ./install.sh              dependencies, certificate, build   (as the owner)
#   ./install.sh --service    install/refresh the service        (needs root)
#   ./install.sh --sandbox    install/verify sandbox prerequisites (needs root)
#
# The build half runs as the invoking user and needs no privilege. Writing a unit
# into /etc/systemd/system does need root, so that half is a separate step — and
# the service it writes still runs the panel as the owning user, never as root.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

say () { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn () { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die () { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

MODE="${1:-all}"

UNIT_NAME=devpanel.service
UNIT_TARGET="/etc/systemd/system/$UNIT_NAME"
UNIT_RENDERED="$HERE/systemd/$UNIT_NAME"

# The panel binds 443 without privilege because this specific binary carries
# cap_net_bind_service. `node` may be a symlink; the capability lives on the
# real file, and that is what the unit has to exec.
resolve_node () {
  local bin; bin="$(command -v node)"
  readlink -f "$bin"
}

# render_unit <node> <user> <group> [<gui dir> <output>]: the checkout's own gui/
# and systemd/devpanel.service unless named.
render_unit () {
  local node_bin="$1" user="$2" group="$3" dir="${4:-$HERE}" out="${5:-$UNIT_RENDERED}"
  local template="$dir/systemd/devpanel.service.in"
  [[ -f "$template" ]] || die "missing unit template at $template"
  sed -e "s|@DIR@|$dir|g" \
      -e "s|@NODE@|$node_bin|g" \
      -e "s|@USER@|$user|g" \
      -e "s|@GROUP@|$group|g" \
      "$template" > "$out"
}

# --- what root runs comes from this checkout --------------------------------
#
# As root, --service runs tools/install-sandbox.sh and installs a unit rendered
# from systemd/devpanel.service.in, and --sandbox runs the helper: files the
# panel's own user can change. Before anything runs, every such file and every
# folder above it must be writable by nobody but root and the checkout's owner.
# Everything is read through the checkout's canonical path, which has no links
# in it, and no link is allowed inside the checkout, so the checked path is the
# one that is hashed, run and rendered. The owner stays trusted (gui/README.md).
CHECKOUT="$(cd -- "$HERE/.." && pwd -P)"
GUI="$CHECKOUT/gui"
SANDBOX_INPUTS=(install.sh tools/install-sandbox.sh systemd/run-devpanel-proc.mount systemd/devpanel-sandbox.conf)
SERVICE_INPUTS=("${SANDBOX_INPUTS[@]}" systemd/devpanel.service.in)

# Why someone other than root and <owner> could change <path>; nothing when nobody can.
untrusted_writer () {
  local p="$1" owner="$2" user mode acl
  user="$(stat -c '%U' -- "$p")" || { echo "cannot be read"; return; }
  mode="$(stat -c '%a' -- "$p")" || { echo "cannot be read"; return; }
  mode=$((8#$mode))
  if [[ "$user" != root && "$user" != "$owner" ]]; then
    if [[ "$owner" == root ]]; then echo "is owned by $user, not root"; else echo "is owned by $user, neither root nor the checkout owner $owner"; fi
    return
  fi
  if (( mode & 8#020 )); then echo "is writable by its group (fix: chmod g-w $p)"; return; fi
  # A folder others may write is safe only with the sticky bit (like /tmp); a file never is.
  if (( mode & 8#002 )); then
    if [[ ! -d "$p" ]] || (( (mode & 8#1000) == 0 )); then echo "is writable by others (fix: chmod o-w $p)"; return; fi
  fi
  # A probe that fails, or answers nothing usable, is a refusal: an unknown is not clean.
  if command -v getfacl >/dev/null 2>&1; then
    acl="$(getfacl --skip-base --absolute-names -- "$p" 2>/dev/null)" || { echo "could not be checked for an ACL (getfacl failed)"; return; }
    if [[ -n "$acl" ]]; then echo "carries an ACL (fix: setfacl -b $p)"; return; fi
  else
    acl="$(ls -ld -- "$p" 2>/dev/null)" || { echo "could not be checked for an ACL (ls failed)"; return; }
    if (( ${#acl} < 11 )); then echo "could not be checked for an ACL (ls printed no mode)"; return; fi
    if [[ "${acl:10:1}" == "+" ]]; then echo "carries an ACL (fix: setfacl -b $p)"; return; fi
  fi
}

# check_chain <dir> <owner>: refuse unless <dir> and every folder above it is safe.
check_chain () {
  local dir="$1" owner="$2" why
  while :; do
    why="$(untrusted_writer "$dir" "$owner")"
    [[ -z "$why" ]] || die "refusing to run as root: $dir $why"
    [[ "$dir" == / ]] && break
    dir="$(dirname -- "$dir")"
  done
}

# Refuse unless every <input> (relative to gui/) and every folder above it is safe.
check_root_inputs () {
  local owner rel p part why dir parts
  owner="$(stat -c '%U' -- "$CHECKOUT")"
  [[ "$(stat -c '%U' -- "$GUI")" == "$owner" ]] \
    || die "refusing to run as root: $GUI is owned by $(stat -c '%U' -- "$GUI"), the checkout $CHECKOUT by $owner"
  check_chain "$CHECKOUT" "$owner"
  for rel in "$@"; do
    p="$CHECKOUT"
    IFS=/ read -ra parts <<< "gui/$rel"
    for part in "${parts[@]}"; do
      p="$p/$part"
      [[ -L "$p" ]] && die "refusing to run as root: $p is a symlink inside the checkout"
      why="$(untrusted_writer "$p" "$owner")"
      [[ -z "$why" ]] || die "refusing to run as root: $p $why"
    done
    [[ -f "$p" ]] || die "refusing to run as root: $p is not a regular file"
  done
}

# sha256_of <file>: its digest, or failure when it cannot be computed.
sha256_of () {
  local d
  d="$(sha256sum < "$1")" || return 1
  d="${d%% *}"
  [[ "$d" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$d"
}

sandbox_digest () {
  local d
  d="$(sha256_of "$GUI/tools/install-sandbox.sh")" || die "refusing to run as root: the sha256 of tools/install-sandbox.sh could not be computed"
  say "sha256 of tools/install-sandbox.sh: $d"
}

# Where the rendered unit is staged as root: a fixed folder, never the inherited
# TMPDIR. It and every folder above it must be owned by root, with no exception
# for the checkout owner (who could otherwise rename the staging folder), and pass
# the other writer checks. The variable exists for the test suite; whatever it
# names is held to the same root-only rule.
STAGE_PARENT="${DEVPANEL_INSTALL_STAGE_PARENT:-/run}"

install_service () {
  local node_bin user group
  node_bin="$(resolve_node)"
  # Installed as root, but the service must run as whoever owns the project —
  # deciding that from the directory rather than from who ran the installer,
  # which under sudo would be root.
  user="$(stat -c '%U' "$HERE")"
  group="$(stat -c '%G' "$HERE")"

  [[ "$user" == "root" ]] && warn "this directory is owned by root; the panel is meant to run as an ordinary user"

  say "service will run as ${user}:${group} using ${node_bin}"

  if command -v getcap >/dev/null 2>&1; then
    if getcap "$node_bin" 2>/dev/null | grep -q cap_net_bind_service; then
      say "${node_bin} carries cap_net_bind_service — port 443 works unprivileged"
    else
      warn "${node_bin} has no cap_net_bind_service; port 443 will be refused"
      warn "  grant it with: setcap cap_net_bind_service=+ep ${node_bin}"
      warn "  or run the panel on an unprivileged port with PORT=8443"
    fi
  fi

  if [[ "$(id -u)" -ne 0 ]]; then
    render_unit "$node_bin" "$user" "$group"
    say "the unit is rendered at:"
    say "  $UNIT_RENDERED"
    say "installing it needs root — run:"
    printf '\n    install -m 0644 %s %s\n' "$UNIT_RENDERED" "$UNIT_TARGET"
    printf '    systemctl daemon-reload\n'
    printf '    systemctl enable --now %s\n\n' "$UNIT_NAME"
    return 1
  fi

  # As root: check first, then show what will run and be installed, then do it.
  # The unit is rendered into a root-owned folder, never into the checkout.
  check_root_inputs "${SERVICE_INPUTS[@]}"
  local parent unit_sha
  parent="$(cd -- "$STAGE_PARENT" && pwd -P)" || die "refusing to run as root: cannot use $STAGE_PARENT to stage the unit"
  check_chain "$parent" root
  STAGED="$(mktemp -d -p "$parent" devpanel-unit.XXXXXX)" || die "refusing to run as root: cannot create a staging folder in $parent"
  trap 'rm -rf -- "$STAGED"' EXIT
  render_unit "$node_bin" "$user" "$group" "$GUI" "$STAGED/$UNIT_NAME"
  unit_sha="$(sha256_of "$STAGED/$UNIT_NAME")" || die "refusing to run as root: the sha256 of the rendered unit could not be computed"
  say "the unit that will be installed as $UNIT_TARGET:"
  cat -- "$STAGED/$UNIT_NAME"
  say "sha256 of that unit: $unit_sha"
  sandbox_digest
  bash "$GUI/tools/install-sandbox.sh"

  install -m 0644 "$STAGED/$UNIT_NAME" "$UNIT_TARGET"
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null
  say "installed $UNIT_TARGET and enabled it at boot"

  # A hand-started panel already holding the port would make the service fail to
  # start for a reason that looks nothing like the cause.
  if pgrep -f 'node.*server/index\.js' >/dev/null 2>&1; then
    local strays; strays="$(pgrep -fc 'node.*server/index\.js')"
    warn "${strays} devpanel process(es) are already running outside systemd"
    warn "  stop them first, or the service cannot take port 443:"
    warn "    pkill -f 'node.*server/index\\.js'"
    warn "  then: systemctl start $UNIT_NAME"
  else
    systemctl restart "$UNIT_NAME"
    say "started — systemctl status $UNIT_NAME"
  fi
  return 0
}

case "$MODE" in
  --sandbox|sandbox)
    if [[ "$(id -u)" -eq 0 ]]; then
      check_root_inputs "${SANDBOX_INPUTS[@]}"
      sandbox_digest
      exec bash "$GUI/tools/install-sandbox.sh"
    fi
    exec bash "$HERE/tools/install-sandbox.sh"
    ;;
  --service|service)
    install_service
    exit $?
    ;;
  -h|--help|help)
    sed -n '2,/^set /{ /^#/s/^# \{0,1\}//p; }' "${BASH_SOURCE[0]}"
    exit 0
    ;;
  all|'') ;;
  *) die "unknown mode '$MODE' — expected '--service' or '--sandbox' (see ./install.sh --help)" ;;
esac

[[ "$(id -u)" -eq 0 ]] && die "run the build as the project's owner, not as root — for the service alone use: ./install.sh --service" 

# --- prerequisites ---------------------------------------------------------

command -v node >/dev/null 2>&1 || die "node is not installed or not on PATH"
command -v npm  >/dev/null 2>&1 || die "npm is not installed or not on PATH"

NODE_VERSION="$(node --version)"      # e.g. v22.22.2
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
NODE_MINOR="${NODE_VERSION#v*.}";  NODE_MINOR="${NODE_MINOR%%.*}"

# Vite 8 requires ^20.19.0 || >=22.12.0.
node_too_old () {
  if   (( NODE_MAJOR >  22 )); then return 1
  elif (( NODE_MAJOR == 22 )); then (( NODE_MINOR < 12 ))
  elif (( NODE_MAJOR == 21 )); then return 0
  elif (( NODE_MAJOR == 20 )); then (( NODE_MINOR < 19 ))
  else return 0
  fi
}

if node_too_old; then
  die "node ${NODE_VERSION} is too old — this project needs ^20.19.0 or >=22.12.0"
fi

say "node ${NODE_VERSION}, npm $(npm --version), user $(id -un)"

# --- dependencies ----------------------------------------------------------

# The build (vite) and the test suites need the devDependencies. npm leaves
# them out when NODE_ENV=production is set, as it often is on servers, and the
# build then fails on a missing @vitejs/plugin-vue, so include them explicitly.
if [[ -f package-lock.json ]]; then
  say "installing dependencies from package-lock.json"
  npm ci --include=dev --no-audit --no-fund
else
  warn "no package-lock.json — resolving fresh"
  npm install --include=dev --no-audit --no-fund
fi

# --- certificate -----------------------------------------------------------

# HTTPS is the default, so setup is not complete without a certificate.
if [[ "${DEVPANEL_TLS:-1}" != "0" ]]; then
  ./make-cert.sh
else
  say "DEVPANEL_TLS=0 — skipping certificate generation"
fi

# --- build -----------------------------------------------------------------

say "building the production bundle"
npm run build

# --- service ---------------------------------------------------------------

say "preparing the systemd service"
if install_service; then
  say "done — the panel is running under systemd"
else
  say "done — dependencies and build are ready"
  say "run the command above as root to install the service, or start it by hand with ./start.sh"
fi
