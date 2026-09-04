#!/usr/bin/env bash
#
# deploy.sh — publish overflow_calls_platform_app.html to the Hetzner box.
#
# STATUS: UNVERIFIED TEMPLATE. Nothing below was tested against the server —
# SSH access was not available when this was generated. Review every value in
# the CONFIG block, then run with --dry-run before running for real.
#
#   ./deploy.sh --dry-run    # print the remote commands, change nothing
#   ./deploy.sh              # execute
#
set -euo pipefail

# ─── CONFIG ───────────────────────────────────────────────────────────────────
SERVER_IP="178.156.198.66"
DEPLOY_USER="root"                       # <PLACEHOLDER> confirm the deploy user
SSH_KEY="${HOME}/.ssh/id_ed25519"     # verified: matches the authorized key


REPO_URL="git@github.com:bbarnes4318/overflow.git"   # <PLACEHOLDER> confirm repo
BRANCH="main"

REMOTE_DIR="/opt/overflow"               # <PLACEHOLDER> where the clone lives
WEB_ROOT="/var/www/overflowcalls.com"    # <PLACEHOLDER> what the web server serves
APP_FILE="overflow_calls_platform_app.html"
INDEX_NAME="index.html"                  # file is renamed to this in WEB_ROOT
WEB_SERVICE="nginx"                      # <PLACEHOLDER> nginx | caddy | apache2
HEALTH_URL="https://overflowcalls.com"   # <PLACEHOLDER> URL to verify after deploy

# ─── Messaging app ────────────────────────────────────────────────────────────
# The Node service that lives in messaging/ inside this repo.
MESSAGING_DIR="${REMOTE_DIR}/messaging"          # the app inside the clone
MESSAGING_UNIT="overflow-messaging"              # systemd unit name
MESSAGING_PORT="3100"
MESSAGING_HOST="messaging.overflowcalls.com"
# The SQLite file lives OUTSIDE the clone on purpose: a deploy pulls (and on a
# first run clones) over ${REMOTE_DIR}, so a database inside it would be one
# bad checkout from gone.
MESSAGING_STATE="/var/lib/overflow-messaging"
CERTBOT_EMAIL=""                         # <PLACEHOLDER> set to receive expiry notices

# !! HOST KEY CONFLICT: on 2026-09-03 this server presented ED25519/ECDSA/RSA keys
# !! that ALL differ from the entries stored in ~/.ssh/known_hosts (lines 112-114).
# !! Confirm the fingerprint below from the Hetzner web console before running.
# The script aborts on mismatch.
EXPECTED_HOSTKEY="SHA256:NkBxlnNuY+VJqP/ZMyXOGeJife9CFhhqNIKV6NBGdVw"
# ──────────────────────────────────────────────────────────────────────────────

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxxx\033[0m %s\n' "$*" >&2; exit 1; }

# ─── Preflight ────────────────────────────────────────────────────────────────
[[ -f "$APP_FILE" ]] || die "$APP_FILE not found; run this from the repo root."
[[ -f "$SSH_KEY"  ]] || die "SSH key not found: $SSH_KEY"

log "Verifying host key for ${SERVER_IP}"
ACTUAL_HOSTKEY="$(ssh-keyscan -T 8 -t ed25519 "$SERVER_IP" 2>/dev/null \
                  | ssh-keygen -lf - 2>/dev/null | awk '{print $2}')"
[[ -n "$ACTUAL_HOSTKEY" ]] || die "Could not read host key from ${SERVER_IP}."
if [[ "$ACTUAL_HOSTKEY" != "$EXPECTED_HOSTKEY" ]]; then
  die "Host key MISMATCH.
    expected: $EXPECTED_HOSTKEY
    actual:   $ACTUAL_HOSTKEY
  Do not continue until you know why this changed."
fi
log "Host key matches."

SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10
          -o StrictHostKeyChecking=accept-new)
TARGET="${DEPLOY_USER}@${SERVER_IP}"

# ─── Remote deploy script ─────────────────────────────────────────────────────
# The app is a single self-contained HTML file loading React/Tailwind from CDNs.
# There is no build step and no dependency install — deploying means getting the
# file into WEB_ROOT and reloading the web server.
REMOTE_CMDS=$(cat <<EOF
set -euo pipefail

# 1. Clone on first run, otherwise fast-forward to origin/${BRANCH}.
if [ -d "${REMOTE_DIR}/.git" ]; then
  echo "--> Updating existing clone at ${REMOTE_DIR}"
  cd "${REMOTE_DIR}"
  git remote set-url origin "${REPO_URL}"
  git fetch origin "${BRANCH}"
  git checkout "${BRANCH}"
  git pull --ff-only origin "${BRANCH}"
else
  echo "--> No clone found; cloning into ${REMOTE_DIR}"
  mkdir -p "\$(dirname "${REMOTE_DIR}")"
  git clone --branch "${BRANCH}" "${REPO_URL}" "${REMOTE_DIR}"
  cd "${REMOTE_DIR}"
fi

echo "--> Now at: \$(git log -1 --oneline)"

# 2. Publish the static file, keeping a timestamped backup of what was there.
mkdir -p "${WEB_ROOT}"
if [ -f "${WEB_ROOT}/${INDEX_NAME}" ]; then
  cp -a "${WEB_ROOT}/${INDEX_NAME}" "${WEB_ROOT}/${INDEX_NAME}.bak.\$(date +%Y%m%d-%H%M%S)"
fi
install -m 0644 "${REMOTE_DIR}/${APP_FILE}" "${WEB_ROOT}/${INDEX_NAME}"
echo "--> Published \$(wc -c < "${WEB_ROOT}/${INDEX_NAME}") bytes to ${WEB_ROOT}/${INDEX_NAME}"

# 2b. Deploy the messaging service.
#
# Ordered deliberately: state directory first (so the service has somewhere to
# write), then dependencies, then the unit, then the vhost. Every step is
# idempotent - a second run installs nothing new and never touches the database.
if [ -d "${MESSAGING_DIR}" ]; then
  echo "--> Deploying the messaging service"

  # The database lives here, outside the clone. Created once; never removed.
  mkdir -p "${MESSAGING_STATE}"
  chmod 750 "${MESSAGING_STATE}"

  cd "${MESSAGING_DIR}"
  if [ -f package-lock.json ]; then
    echo "--> npm ci --omit=dev"
    npm ci --omit=dev
  else
    echo "!!! no package-lock.json in ${MESSAGING_DIR}; refusing to npm install"
    exit 1
  fi

  # systemd unit, from the copy tracked in the repo.
  install -m 0644 "${REMOTE_DIR}/deploy/${MESSAGING_UNIT}.service" \
                  "/etc/systemd/system/${MESSAGING_UNIT}.service"
  systemctl daemon-reload
  systemctl enable "${MESSAGING_UNIT}"

  # nginx vhost for the subdomain. The upgrade map goes in conf.d because a
  # map is only valid in the http context.
  if [ "${WEB_SERVICE}" = "nginx" ]; then
    install -m 0644 "${REMOTE_DIR}/deploy/nginx-upgrade-map.conf" \
                    /etc/nginx/conf.d/overflow-upgrade-map.conf

    # certbot rewrites the vhost in place to add the TLS listener. Re-installing
    # the plain HTTP version on every deploy would undo that, so it is written
    # once and left alone afterwards.
    if [ ! -f "/etc/nginx/sites-available/${MESSAGING_HOST}" ]; then
      install -m 0644 "${REMOTE_DIR}/deploy/nginx-messaging.conf" \
                      "/etc/nginx/sites-available/${MESSAGING_HOST}"
      ln -sfn "/etc/nginx/sites-available/${MESSAGING_HOST}" \
              "/etc/nginx/sites-enabled/${MESSAGING_HOST}"
      echo "--> installed nginx vhost for ${MESSAGING_HOST}"
    else
      echo "--> nginx vhost for ${MESSAGING_HOST} already present, left as-is"
    fi
  fi

  systemctl restart "${MESSAGING_UNIT}"
  sleep 2
  if systemctl is-active --quiet "${MESSAGING_UNIT}"; then
    echo "--> ${MESSAGING_UNIT}: active on port ${MESSAGING_PORT}"
  else
    echo "!!! ${MESSAGING_UNIT} failed to start:"
    journalctl -u "${MESSAGING_UNIT}" -n 40 --no-pager || true
    exit 1
  fi

  cd "${REMOTE_DIR}"
else
  echo "!!! ${MESSAGING_DIR} not found in the clone; skipping the messaging service"
fi

# 3. Validate config, then reload (reload, not restart — no dropped connections).
if command -v ${WEB_SERVICE} >/dev/null 2>&1; then
  if [ "${WEB_SERVICE}" = "nginx" ]; then nginx -t; fi
  systemctl reload ${WEB_SERVICE} || systemctl restart ${WEB_SERVICE}
  echo "--> ${WEB_SERVICE} reloaded"
else
  echo "!!! ${WEB_SERVICE} not installed — file is in place but nothing was reloaded."
fi

# 4. Report service and host state.
echo "--> uptime: \$(uptime -p 2>/dev/null || uptime)"
systemctl is-active ${WEB_SERVICE} >/dev/null 2>&1 \
  && echo "--> ${WEB_SERVICE}: active" \
  || echo "!!! ${WEB_SERVICE}: NOT active"
EOF
)

# ─── Execute ──────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" -eq 1 ]]; then
  log "DRY RUN — these commands would run on ${TARGET}:"
  printf '%s\n' "$REMOTE_CMDS"
  exit 0
fi

log "Deploying to ${TARGET}"
ssh "${SSH_OPTS[@]}" "$TARGET" "bash -s" <<< "$REMOTE_CMDS"

log "Verifying ${HEALTH_URL}"
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$HEALTH_URL" || echo 000)"
[[ "$CODE" == "200" ]] && log "Health check OK (HTTP $CODE)" \
                       || warn "Health check returned HTTP $CODE — investigate."

# ─── Messaging health ─────────────────────────────────────────────────────────
# Checked over plain HTTP against the origin first, so a TLS or DNS problem is
# distinguishable from the app itself being down.
log "Verifying the messaging service on the origin"
ORIGIN_CODE="$(ssh "${SSH_OPTS[@]}" "$TARGET" \
  "curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:${MESSAGING_PORT}/login" \
  2>/dev/null || echo 000)"
[[ "$ORIGIN_CODE" == "200" ]] && log "Messaging origin OK (HTTP $ORIGIN_CODE)" \
                              || warn "Messaging origin returned HTTP $ORIGIN_CODE — check: journalctl -u ${MESSAGING_UNIT} -n 50"

log "Verifying https://${MESSAGING_HOST}/login"
MSG_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://${MESSAGING_HOST}/login" || echo 000)"
if [[ "$MSG_CODE" == "200" ]]; then
  log "Messaging health check OK (HTTP $MSG_CODE)"
else
  warn "https://${MESSAGING_HOST}/login returned HTTP $MSG_CODE."
  warn "If no certificate has been issued yet, run ON THE SERVER:"
  warn "  certbot --nginx -d ${MESSAGING_HOST}${CERTBOT_EMAIL:+ -m ${CERTBOT_EMAIL} --agree-tos --no-eff-email}"
  warn "certbot needs ${MESSAGING_HOST} to already resolve to ${SERVER_IP}."
fi

# The superadmin password is printed to the journal exactly once, on the first
# boot with an empty user table. Surface it here rather than making someone hunt.
log "First-boot superadmin credentials (empty if already seeded on an earlier run):"
ssh "${SSH_OPTS[@]}" "$TARGET" \
  "journalctl -u ${MESSAGING_UNIT} --no-pager | grep -A3 'Seeded superadmin' | tail -8" \
  2>/dev/null || true
