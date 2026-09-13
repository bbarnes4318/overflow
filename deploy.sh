#!/usr/bin/env bash
#
# deploy.sh — publish netenroll_platform_app.html and the NetEnroll Messaging
# service to the Hetzner box.
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

REMOTE_DIR="/opt/netenroll"              # where the clone lives
WEB_ROOT="/var/www/netenroll.com"        # what the static vhost serves
APP_FILE="index.html"
INDEX_NAME="index.html"
WEB_SERVICE="nginx"                      # <PLACEHOLDER> nginx | caddy | apache2
HEALTH_URL="https://netenroll.com"       # URL to verify after deploy
# The static site answers on the apex and www; both need a certificate.
SITE_HOSTS=("netenroll.com" "www.netenroll.com")

# ─── Messaging app ────────────────────────────────────────────────────────────
# The Node service that lives in messaging/ inside this repo.
MESSAGING_DIR="${REMOTE_DIR}/messaging"          # the app inside the clone
MESSAGING_UNIT="netenroll-messaging"             # systemd unit name
MESSAGING_PORT="3100"
MESSAGING_HOST="messaging.netenroll.com"
# The SQLite file lives OUTSIDE the clone on purpose: a deploy pulls (and on a
# first run clones) over ${REMOTE_DIR}, so a database inside it would be one
# bad checkout from gone.
MESSAGING_STATE="/var/lib/netenroll-messaging"
CERTBOT_EMAIL="jimbosky35@gmail.com"     # receives certificate expiry notices
# One flag or the other, never both: ${VAR:-default} substitutes the VALUE when
# set, which previously emitted the address twice.
if [[ -n "$CERTBOT_EMAIL" ]]; then
  CERTBOT_EMAIL_ARG="--email ${CERTBOT_EMAIL}"
else
  CERTBOT_EMAIL_ARG="--register-unsafely-without-email"
fi
NODE_MAJOR="22"                          # Ubuntu 24.04 ships Node 18; the app needs >= 20

# ─── Host key ─────────────────────────────────────────────────────────────────
# PROVENANCE, stated plainly because it matters:
#
# This fingerprint was PINNED ON FIRST CONNECTION on 2026-09-04. It was NOT
# verified out-of-band against the Hetzner web console.
#
# The earlier known_hosts entries did not match it. The accepted explanation is
# that they were captured while the server was in Hetzner rescue mode, which
# generates its own throwaway host keys, so they never described the normal
# system. Those stale entries were removed (ssh-keygen -R 178.156.198.66) and
# this key recorded in their place.
#
# That explanation is available exactly once. Because StrictHostKeyChecking=yes
# below, any future change stops the deploy - and a second unexplained change
# must be treated as a compromise, not re-pinned.
#
# To upgrade this to a real verification, read the console and compare:
#   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
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

if [[ -z "$EXPECTED_HOSTKEY" ]]; then
  die "EXPECTED_HOSTKEY is not set.
  Read the ED25519 fingerprint from the Hetzner web console (NOT over the
  network - that is what made the old check circular) and put it in the CONFIG
  block above:
      ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
fi

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

# StrictHostKeyChecking=yes, not accept-new: a host whose key has CHANGED must
# stop the deploy, not be adopted silently. accept-new only protects a host that
# is entirely unknown, which is the one case that does not matter here.
SSH_OPTS=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10
          -o StrictHostKeyChecking=yes)
TARGET="${DEPLOY_USER}@${SERVER_IP}"

# ─── Remote deploy script ─────────────────────────────────────────────────────
# The public site is static HTML, one stylesheet and one script. There is no
# build step — deploying means copying the files into WEB_ROOT and reloading
# the web server. The licensing tool keeps its React/Babel runtime from CDNs.
REMOTE_CMDS=$(cat <<EOF
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# 0. Provision prerequisites.
#
# The server was found bare: no web server, no node, no certbot. Every step
# below is a no-op once satisfied, so a second deploy installs nothing.
NEED_APT_UPDATE=1
apt_install() {
  if [ "\$NEED_APT_UPDATE" = "1" ]; then
    echo "--> apt-get update"
    apt-get update -qq
    NEED_APT_UPDATE=0
  fi
  echo "--> installing: \$*"
  apt-get install -y -qq "\$@"
}

MISSING=""
command -v git      >/dev/null 2>&1 || MISSING="\$MISSING git"
command -v nginx    >/dev/null 2>&1 || MISSING="\$MISSING nginx"
command -v certbot  >/dev/null 2>&1 || MISSING="\$MISSING certbot python3-certbot-nginx"
command -v curl     >/dev/null 2>&1 || MISSING="\$MISSING curl"
# better-sqlite3 falls back to compiling from source if no prebuild matches.
dpkg -s build-essential >/dev/null 2>&1 || MISSING="\$MISSING build-essential"

if [ -n "\$MISSING" ]; then
  apt_install \$MISSING
else
  echo "--> base packages already present"
fi

# Node. Ubuntu 24.04's own package is 18.x and the app declares >= 20, so a
# too-old node is replaced from NodeSource rather than left to fail at runtime.
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  CURRENT_MAJOR="\$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [ "\$CURRENT_MAJOR" -ge 20 ] 2>/dev/null; then
    echo "--> node \$(node --version) is new enough"
    NODE_OK=1
  else
    echo "--> node \$(node --version) is too old (need >= 20)"
  fi
fi
if [ "\$NODE_OK" = "0" ]; then
  echo "--> installing Node ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null
  rm -f /tmp/nodesource_setup.sh
  apt-get install -y -qq nodejs
  echo "--> node \$(node --version) / npm \$(npm --version)"
fi

systemctl enable --now nginx >/dev/null 2>&1 || true

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

# The other public routes and everything the pages reference by path. Each is
# served at /<name> (or /<name> minus .html) through nginx's try_files rule.
for asset in aca-agent-recruiting.html licensing-value.html site.css site.js \
             favicon.svg favicon.png apple-touch-icon.png \
             og-final-expense.png og-recruiting.png \
             netenroll-logo.png netenroll-logo-dark.png robots.txt sitemap.xml; do
  install -m 0644 "${REMOTE_DIR}/\${asset}" "${WEB_ROOT}/\${asset}"
done
# The old single-file app was published as index.html and is now replaced by
# the static index.html above; nothing else to remove.


# Terms, Privacy and TCPA are standalone HTML served by path, not tabs inside
# the app. They go in the web root flat, so nginx's \$uri.html rule resolves
# /terms, /privacy and /tcpa-compliance without a redirect.
for doc in terms.html privacy.html tcpa-compliance.html legal.css; do
  install -m 0644 "${REMOTE_DIR}/legal/\${doc}" "${WEB_ROOT}/\${doc}"
done


# The /licensing-value tool fetches this at runtime. It is the only source of
# fee and population figures on the page, so a deploy that skips it leaves the
# tool showing its "could not be loaded" notice rather than stale numbers.
install -m 0644 "${REMOTE_DIR}/src/data/licensing-fees.json" "${WEB_ROOT}/licensing-fees.json"
echo "--> Published \$(wc -c < "${WEB_ROOT}/${INDEX_NAME}") bytes to ${WEB_ROOT}/${INDEX_NAME}"
echo "--> Published legal documents: terms.html privacy.html tcpa-compliance.html legal.css"

# Password-gated pages. Each is one static file served at /<name> through the
# same \$uri.html rule as the legal documents; the gate is inside the file
# (AES-encrypted body, unlocked in the browser), so nginx needs nothing extra.
# Rebuild after editing the .src.html - see tools/gate-page.mjs.
for gated in cpa-model.html; do
  install -m 0644 "${REMOTE_DIR}/protected/\${gated}" "${WEB_ROOT}/\${gated}"
done
echo "--> Published gated pages: cpa-model.html"

# 2a. The static site's own vhost. Written once, then left alone so certbot's
# in-place TLS rewrite is not undone by the next deploy.
if [ "${WEB_SERVICE}" = "nginx" ]; then
  if [ ! -f "/etc/nginx/sites-available/${SITE_HOSTS[0]}" ]; then
    install -m 0644 "${REMOTE_DIR}/deploy/nginx-site.conf" \
                    "/etc/nginx/sites-available/${SITE_HOSTS[0]}"
    ln -sfn "/etc/nginx/sites-available/${SITE_HOSTS[0]}" \
            "/etc/nginx/sites-enabled/${SITE_HOSTS[0]}"
    echo "--> installed nginx vhost for ${SITE_HOSTS[*]}"
  else
    echo "--> nginx vhost for ${SITE_HOSTS[0]} already present, left as-is"
  fi

  # A location block added to nginx-site.conf AFTER the vhost was first
  # installed never reaches the live file, because the live file is certbot's
  # rewrite and is left alone above. Splice each missing block in, once,
  # ahead of the vhost's access_log line - which sits in the server block
  # certbot upgraded to 443 - and leave it alone on every later run.
  # The marker is the block's first line, matched literally.
  VHOST="/etc/nginx/sites-available/${SITE_HOSTS[0]}"
  splice_location() {
    if grep -qF "\$1" "\$VHOST"; then return; fi
    BLOCK_FILE="\$(mktemp)"
    awk -v m="\$1" 'index(\$0, m) { on = 1 } on { print } on && /^    }/ { exit }' \
        "${REMOTE_DIR}/deploy/nginx-site.conf" > "\$BLOCK_FILE"
    if [ -s "\$BLOCK_FILE" ]; then
      echo >> "\$BLOCK_FILE"
      awk -v f="\$BLOCK_FILE" '
        /access_log \/var\/log\/nginx\/netenroll.access.log;/ && !done {
          while ((getline line < f) > 0) print line
          done = 1
        }
        { print }' "\$VHOST" > "\$VHOST.new" && mv "\$VHOST.new" "\$VHOST"
      echo "--> added to the live vhost: \$1"
    fi
    rm -f "\$BLOCK_FILE"
  }
  splice_location 'location = /api/recruiting-inquiry'
  splice_location 'location ~ ^/(aca-agent-recruiting|licensing-value|site\.css|site\.js)$'
  # Ubuntu's stock catch-all would otherwise answer for these names.
  rm -f /etc/nginx/sites-enabled/default
fi

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
                    /etc/nginx/conf.d/netenroll-upgrade-map.conf

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

# 3b. TLS. Issued once for all three names in a single certificate; certbot
# rewrites both vhosts in place to add the listener and the :80 redirect.
# Skipped entirely once a certificate exists, so a redeploy neither reissues
# nor trips Let's Encrypt rate limits.
if command -v certbot >/dev/null 2>&1; then
  if [ -d "/etc/letsencrypt/live/${SITE_HOSTS[0]}" ]; then
    echo "--> certificate for ${SITE_HOSTS[0]} already present; renewal is handled by the certbot timer"
    certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains|Expiry' || true
  else
    echo "--> requesting a certificate for ${SITE_HOSTS[0]}, ${SITE_HOSTS[1]}, ${MESSAGING_HOST}"
    certbot --nginx --non-interactive --agree-tos --redirect       -d "${SITE_HOSTS[0]}" -d "${SITE_HOSTS[1]}" -d "${MESSAGING_HOST}"       ${CERTBOT_EMAIL_ARG}       || echo "!!! certbot failed - the sites remain on plain HTTP. Check that all three names resolve to this host."
    nginx -t && systemctl reload nginx || true
  fi
else
  echo "!!! certbot not installed; skipping TLS"
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
  warn "  certbot --nginx -d ${SITE_HOSTS[0]} -d ${SITE_HOSTS[1]} -d ${MESSAGING_HOST}${CERTBOT_EMAIL:+ -m ${CERTBOT_EMAIL} --agree-tos --no-eff-email}"
  warn "certbot needs all three names to already resolve to ${SERVER_IP}."
fi

# The superadmin password is printed to the journal exactly once, on the first
# boot with an empty user table. Surface it here rather than making someone hunt.
log "First-boot superadmin credentials (empty if already seeded on an earlier run):"
ssh "${SSH_OPTS[@]}" "$TARGET" \
  "journalctl -u ${MESSAGING_UNIT} --no-pager | grep -A3 'Seeded superadmin' | tail -8" \
  2>/dev/null || true
