#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="the-containers.service"
SERVICE_USER="${THE_CONTAINERS_SERVICE_USER:-${SUDO_USER:-${USER:-}}}"
ENV_DIR="${THE_CONTAINERS_ENV_DIR:-${NAVIPROXY_ENV_DIR:-/etc/the-containers}}"
ENV_FILE="${THE_CONTAINERS_ENV_FILE:-${NAVIPROXY_ENV_FILE:-$ENV_DIR/the-containers.env}}"
DATA_DIR="${THE_CONTAINERS_DATA_DIR:-${NAVIPROXY_DATA_DIR:-$ROOT_DIR/data}}"
DOCKER_HOST_VALUE="${DOCKER_HOST:-}"

log() {
  printf '\n[the-containers setup] %s\n' "$1"
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif need_cmd sudo; then
    sudo "$@"
  else
    log "This step needs root privileges. Install sudo or run this script as root."
    exit 1
  fi
}

run_as_service_user() {
  if [ "$(id -un)" = "$SERVICE_USER" ]; then
    "$@"
  elif [ "$(id -u)" -eq 0 ]; then
    runuser -u "$SERVICE_USER" -- "$@"
  else
    sudo -H -u "$SERVICE_USER" "$@"
  fi
}

user_home() {
  getent passwd "$SERVICE_USER" | cut -d: -f6
}

user_primary_group() {
  id -gn "$SERVICE_USER"
}

node_major() {
  if need_cmd node; then
    node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

ensure_linux() {
  if [ "$(uname -s)" != "Linux" ]; then
    log "This script configures Linux systemd autostart. On macOS/Windows, Docker group is not used; run ./install.sh and configure autostart with your platform service manager."
    exit 0
  fi

  if ! need_cmd systemctl; then
    log "systemctl was not found, so I cannot create a systemd autostart service on this platform."
    exit 1
  fi

  if [ -z "$SERVICE_USER" ] || ! id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Service user '$SERVICE_USER' does not exist. Set THE_CONTAINERS_SERVICE_USER to an existing user and rerun."
    exit 1
  fi
}

install_debian_packages() {
  log "Installing base packages with apt..."
  run_root apt-get update
  run_root apt-get install -y ca-certificates curl git build-essential gnupg lsb-release

  if [ "$(node_major)" -lt 22 ]; then
    log "Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | run_root bash -
    run_root apt-get install -y nodejs
  fi

  if ! need_cmd docker; then
    log "Installing Docker CLI/daemon and Compose plugin..."
    run_root apt-get install -y docker.io docker-compose-plugin
  elif ! docker compose version >/dev/null 2>&1; then
    log "Installing Docker Compose plugin..."
    run_root apt-get install -y docker-compose-plugin || true
  fi

  if ! need_cmd caddy; then
    log "Installing Caddy..."
    if ! run_root apt-get install -y caddy; then
      log "Adding the official Caddy repository..."
      run_root apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | run_root gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | run_root tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      run_root apt-get update
      run_root apt-get install -y caddy
    fi
  fi
}

install_packages() {
  if need_cmd apt-get; then
    install_debian_packages
  else
    log "apt-get was not found. Please install Node.js 22, Docker, Docker Compose, Caddy, git, and build tools, then rerun this script."
  fi
}

ensure_docker_permissions() {
  if ! need_cmd docker; then
    log "Docker CLI is still missing after package installation. Skipping Docker permission repair."
    return
  fi

  if ! getent group docker >/dev/null 2>&1; then
    log "Creating docker group..."
    run_root groupadd docker
  fi

  if ! id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then
    log "Adding $SERVICE_USER to the docker group..."
    run_root usermod -aG docker "$SERVICE_USER"
  else
    log "$SERVICE_USER is already in the docker group."
  fi

  if systemctl list-unit-files docker.service >/dev/null 2>&1; then
    log "Enabling and starting Docker daemon..."
    run_root systemctl enable --now docker
  fi

  if run_as_service_user docker info >/dev/null 2>&1; then
    log "Docker daemon is reachable by $SERVICE_USER."
    return
  fi

  local uid rootless_socket
  uid="$(id -u "$SERVICE_USER")"
  rootless_socket="/run/user/$uid/docker.sock"
  if [ -S "$rootless_socket" ]; then
    DOCKER_HOST_VALUE="unix://$rootless_socket"
    log "Detected rootless Docker socket at $rootless_socket; it will be written to the environment file."
    return
  fi

  log "Docker is installed, but $SERVICE_USER still cannot reach the daemon yet. The systemd service will start with the docker group; if this remains after reboot, run: docker info"
}

replace_or_append_env() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(printf '%s' "$value" | sed 's/[&/]/\\&/g')"

  if run_root test -f "$ENV_FILE" && run_root grep -q "^$key=" "$ENV_FILE"; then
    run_root sed -i "s/^$key=.*/$key=$escaped/" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" | run_root tee -a "$ENV_FILE" >/dev/null
  fi
}

ensure_admin_token() {
  # Do not source an operator's env file as root just to inspect its token.
  run_root node - "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const file = process.argv[2];
const contents = fs.readFileSync(file, 'utf8');
const assignments = [...contents.matchAll(/^ADMIN_TOKEN=(.*)$/gm)];
const value = assignments.at(-1)?.[1].trim() ?? '';
if (value && !/^(?:""|'')(?:\s+#.*)?$/.test(value) && !value.startsWith('#')) {
  process.exit(0);
}
const token = randomBytes(32).toString('hex');
const updated = assignments.length
  ? contents.replace(/^ADMIN_TOKEN=.*$/gm, `ADMIN_TOKEN=${token}`)
  : `${contents}${contents.endsWith('\n') ? '' : '\n'}ADMIN_TOKEN=${token}\n`;
fs.writeFileSync(file, updated);
console.log(`Generated ADMIN_TOKEN (save it now): ${token}`);
NODE
}

write_env() {
  local primary_group
  primary_group="$(user_primary_group)"

  log "Writing environment file at $ENV_FILE..."
  run_root mkdir -p -m 0750 "$ENV_DIR"
  run_root chown root:"$primary_group" "$ENV_DIR"
  run_root chmod 0750 "$ENV_DIR"
  run_root mkdir -p "$DATA_DIR"
  run_root chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"

  if ! run_root test -f "$ENV_FILE"; then
    run_root touch "$ENV_FILE"
    run_root chown root:"$primary_group" "$ENV_FILE"
    run_root chmod 0640 "$ENV_FILE"
    run_root tee "$ENV_FILE" >/dev/null <<EOF_ENV
HOST=0.0.0.0
PORT=3001
ADMIN_TOKEN=
DASHBOARD_AUTH_REQUIRED=false
CORS_ORIGIN=
DATABASE_PATH=$DATA_DIR/the-containers.sqlite
WEB_DIST_PATH=$ROOT_DIR/apps/web/dist
CADDY_ADMIN_URL=http://127.0.0.1:2019
CADDY_SYNC_ENABLED=true
CADDY_LISTEN=:80
DOCKER_BIN=docker
DEPLOYMENTS_PATH=$DATA_DIR/deployments
HEALTH_CHECK_INTERVAL_SECONDS=0
THE_CONTAINERS_DASHBOARD_TARGET_URL=http://127.0.0.1:3001
EOF_ENV
  fi

  # Remove public access before writing secrets, and always let the service
  # group read the file after changing its ownership to root.
  run_root chown root:"$primary_group" "$ENV_FILE"
  run_root chmod 0640 "$ENV_FILE"

  replace_or_append_env "DOCKER_BIN" "docker"
  replace_or_append_env "DATABASE_PATH" "$DATA_DIR/the-containers.sqlite"
  replace_or_append_env "WEB_DIST_PATH" "$ROOT_DIR/apps/web/dist"
  replace_or_append_env "DEPLOYMENTS_PATH" "$DATA_DIR/deployments"
  replace_or_append_env "THE_CONTAINERS_DASHBOARD_TARGET_URL" "http://127.0.0.1:3001"

  if [ -n "$DOCKER_HOST_VALUE" ]; then
    replace_or_append_env "DOCKER_HOST" "$DOCKER_HOST_VALUE"
  fi

  ensure_admin_token
  run_root chown root:"$primary_group" "$ENV_FILE"
}

install_node_app() {
  local primary_group path
  primary_group="$(user_primary_group)"

  log "Installing Node dependencies and building the app as $SERVICE_USER..."
  log "Repairing project ownership so npm can create workspace node_modules..."
  run_root chown -R "$SERVICE_USER":"$primary_group" "$ROOT_DIR"
  while IFS= read -r -d '' path; do
    run_root chown -R "$SERVICE_USER":"$primary_group" "$path"
  done < <(find "$ROOT_DIR" -path "$ROOT_DIR/.git" -prune -o \( \( -name node_modules -o -name dist \) -type d -print0 -prune \))

  cd "$ROOT_DIR"
  run_as_service_user npm ci
  run_as_service_user npm run build
}

configure_caddy() {
  if ! need_cmd caddy; then
    log "Caddy is not installed. Skipping Caddy configuration."
    return
  fi

  if [ -d /etc/caddy ]; then
    log "Installing Caddyfile and enabling Caddy..."
    run_root cp "$ROOT_DIR/caddy/Caddyfile" /etc/caddy/Caddyfile
    if systemctl list-unit-files caddy.service >/dev/null 2>&1; then
      run_root systemctl enable caddy >/dev/null 2>&1 || true
      run_root systemctl reload caddy >/dev/null 2>&1 || run_root systemctl restart caddy
    fi
  fi
}

write_systemd_service() {
  local home_dir primary_group
  home_dir="$(user_home)"
  primary_group="$(user_primary_group)"

  log "Creating systemd service $SERVICE_NAME..."
  run_root tee "/etc/systemd/system/$SERVICE_NAME" >/dev/null <<EOF_SERVICE
[Unit]
Description=The Containers dashboard and deployment manager
Wants=network-online.target docker.service caddy.service
After=network-online.target docker.service caddy.service

[Service]
Type=simple
User=$SERVICE_USER
Group=$primary_group
SupplementaryGroups=docker
WorkingDirectory=$ROOT_DIR
Environment=HOME=$home_dir
EnvironmentFile=$ENV_FILE
ExecStart=$ROOT_DIR/start.sh
Restart=on-failure
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF_SERVICE

  run_root systemctl daemon-reload
  run_root systemctl enable "$SERVICE_NAME"
  run_root systemctl restart "$SERVICE_NAME"
}

print_summary() {
  local host_ip
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [ -n "$host_ip" ] || host_ip="localhost"

  log "Setup complete."
  log "Service status: systemctl status $SERVICE_NAME --no-pager"
  log "Logs: journalctl -u $SERVICE_NAME -f"
  log "Open: http://$host_ip"
  log "If Docker still warns in the UI, reboot once so all long-running sessions pick up the docker group membership."
}

main() {
  ensure_linux
  log "Configuring autostart and Docker permissions for user: $SERVICE_USER"
  install_packages
  ensure_docker_permissions
  write_env
  install_node_app
  configure_caddy
  write_systemd_service
  print_summary
}

main "$@"
