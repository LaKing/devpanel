#!/usr/bin/env bash
#
# Generate the self-signed certificate the panel serves HTTPS with.
#
# Writes <project>/cert/localhost.crt + localhost.key,
# owned and readable only by the running user. Re-run to replace an expired one
# (pass --force to overwrite a valid one).
#
# Runs as the invoking user (the project owner); nothing here needs root.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# DEVPANEL_CERT_DIR, else <dataRoot>/cert from the host settings, else ../cert.
CERT_DIR="${DEVPANEL_CERT_DIR:-$(node "$HERE/tools/data-path.mjs" cert)}"
CRT="$CERT_DIR/localhost.crt"
KEY="$CERT_DIR/localhost.key"
DAYS="${DEVPANEL_CERT_DAYS:-825}"

say () { printf '\033[36m==>\033[0m %s\n' "$*"; }
die () { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || die "openssl is not installed"

if [[ -f "$CRT" && -f "$KEY" && "${1:-}" != "--force" ]]; then
  if openssl x509 -in "$CRT" -noout -checkend 604800 >/dev/null 2>&1; then
    say "certificate already valid — $CRT"
    say "    expires $(openssl x509 -in "$CRT" -noout -enddate | cut -d= -f2)"
    say "    re-run with --force to replace it"
    exit 0
  fi
  say "existing certificate expires within a week — replacing it"
fi

mkdir -p "$CERT_DIR"
chmod 755 "$CERT_DIR"

# Everything the panel might legitimately be reached as. A browser matches the
# certificate against the name in the address bar, so each one needs a SAN entry.
FQDN="$(hostname -f 2>/dev/null || true)"
[[ -z "$FQDN" || "$FQDN" == "localhost" ]] && FQDN="$(node -e 'process.stdout.write(require("os").hostname())' 2>/dev/null || hostname)"
SHORT="${FQDN%%.*}"

ALT="DNS:localhost,DNS:${FQDN}"
[[ "$SHORT" != "$FQDN" ]] && ALT="${ALT},DNS:${SHORT}"
ALT="${ALT},IP:127.0.0.1,IP:::1"

# Add every routable address this host answers on.
while read -r ip; do
  [[ -n "$ip" ]] && ALT="${ALT},IP:${ip}"
done < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9a-fA-F:.]+$' | sort -u)

say "generating a ${DAYS}-day self-signed certificate"
say "    names: ${ALT}"

openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$KEY" -out "$CRT" \
  -subj "/CN=${FQDN}/O=devpanel/OU=development" \
  -addext "subjectAltName=${ALT}" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  2>/dev/null || die "openssl failed to generate the certificate"

chmod 600 "$KEY"
chmod 644 "$CRT"

say "wrote $CRT"
say "wrote $KEY"
say "expires $(openssl x509 -in "$CRT" -noout -enddate | cut -d= -f2)"
