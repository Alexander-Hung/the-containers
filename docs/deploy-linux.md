# Deploy The Containers on a Linux Mini PC

This guide assumes Debian or Ubuntu. Adjust package commands for other distributions.

## Fast Path

```bash
git clone https://github.com/Alexander-Hung/the-containers /opt/the-containers
cd /opt/the-containers
./install.sh
./start.sh
```

`install.sh` installs system packages on Debian/Ubuntu, installs Node.js 22 when needed, installs Caddy when missing, runs `npm ci`, builds the app, prepares `/etc/the-containers/the-containers.env`, and reloads Caddy. If `apt` cannot locate `caddy`, the script adds Caddy's official apt repository and retries.

`start.sh` loads `/etc/the-containers/the-containers.env`, verifies build output, starts Caddy if systemd is available, and starts The Containers.

For systemd autostart and Docker permissions, use `./deploy/setup-autostart.sh`.
It generates a random `ADMIN_TOKEN` when the env file has no token, prints the
new token once, and preserves an existing token on reruns. Save the generated
token securely and enter it in the admin UI. The env directory is owned by
`root:<service group>` with mode `0750`, and env files use the same ownership
with mode `0640` on every run. Reruns normalize existing permissions, including
`0700` directories and service-owned `0600` files, so the service user can source
the root-owned file through its service group while other users have no access.

The basic `install.sh` path and manual installation require you to set a token
before using the admin API from a non-loopback host.

## Manual Install

## 1. Install runtime dependencies

```bash
sudo apt update
sudo apt install -y git curl build-essential caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

`better-sqlite3` is a native dependency, so `build-essential` is required during install.

## 2. Download and build

```bash
sudo mkdir -p /opt/the-containers
sudo chown "$USER":"$USER" /opt/the-containers
git clone https://github.com/Alexander-Hung/the-containers /opt/the-containers
cd /opt/the-containers
npm ci
npm run build
```

## 3. Configure The Containers

```bash
sudo useradd --system --home /opt/the-containers --shell /usr/sbin/nologin the-containers
sudo mkdir -p /etc/the-containers /opt/the-containers/data
sudo cp .env.example /etc/the-containers/the-containers.env
sudo chown root:the-containers /etc/the-containers /etc/the-containers/the-containers.env
sudo chmod 0750 /etc/the-containers
sudo chmod 0640 /etc/the-containers/the-containers.env
sudo chown -R the-containers:the-containers /opt/the-containers/data
```

Edit `/etc/the-containers/the-containers.env`:

```env
HOST=0.0.0.0
PORT=3001
ADMIN_TOKEN=
DASHBOARD_AUTH_REQUIRED=false
CORS_ORIGIN=
DATABASE_PATH=/opt/the-containers/data/the-containers.sqlite
WEB_DIST_PATH=/opt/the-containers/apps/web/dist
CADDY_ADMIN_URL=http://127.0.0.1:2019
CADDY_SYNC_ENABLED=true
CADDY_LISTEN=:80
THE_CONTAINERS_DASHBOARD_TARGET_URL=http://127.0.0.1:3001
```

Set `ADMIN_TOKEN` to a strong random value before starting the service. Admin
operations include deployment, create, edit, delete, import, export, reorder,
and proxy sync. With an empty token and a non-loopback `HOST` (including the
default `0.0.0.0`), protected API routes return `503` until a token is configured.
With a token configured, missing or incorrect credentials return `401`. Set
`DASHBOARD_AUTH_REQUIRED=true` to protect the read-only dashboard list too.
Health remains public; the read-only dashboard list remains public unless
dashboard auth is required. Required dashboard auth returns `503` if no token
is configured, even on loopback.

Leave tokens empty only for trusted local development with `HOST=127.0.0.1`
(other `127.x.x.x` addresses, `::1`, and `localhost` are also supported).
Do not proxy a tokenless loopback API through a LAN-facing Caddy listener or a
tunnel: the guard checks the configured bind host, not proxy exposure.
`CORS_ORIGIN` can be left
empty for same-origin dashboard usage, set to `*` for permissive development, or
set to a comma-separated list of allowed origins.

## 4. Enable Caddy Admin API

Create or update `/etc/caddy/Caddyfile`:

```caddyfile
{
	admin 127.0.0.1:2019 {
		origins localhost:2019 127.0.0.1:2019 [::1]:2019
	}
}

:80 {
	reverse_proxy 127.0.0.1:3001
}
```

Then reload Caddy:

```bash
sudo systemctl reload caddy
```

## 5. Run as a systemd service

```bash
sudo cp deploy/the-containers.service /etc/systemd/system/the-containers.service
sudo systemctl daemon-reload
sudo systemctl enable --now the-containers.service
```

The service is ordered after `caddy.service`, and The Containers also syncs the saved
SQLite app routes back into Caddy on startup with retries.

Check status:

```bash
systemctl status the-containers
systemctl status caddy
curl http://127.0.0.1:3001/api/health
```

Open:

```txt
http://<MINI_PC_IP>
```

Caddy listens on port `80` and forwards The Containers dashboard traffic to the Node service on `3001`, so you do not need to type a port in the browser.

After adding a subdomain app such as `jellyfin.lab.home`, point that name to the mini PC IP in your router DNS, Pi-hole, AdGuard Home, or local DNS server.

Subdomains are written app-first. For Homebridge, use:

```txt
homebridge.lab.home
```

Do not use:

```txt
lab.home.homebridge
```

If your local DNS only has `lab.home -> <MINI_PC_IP>`, that only covers the dashboard host. Add either:

```txt
homebridge.lab.home -> <MINI_PC_IP>
```

or a wildcard record:

```txt
*.lab.home -> <MINI_PC_IP>
```

## Notes

- Subdomain mode is recommended.
- Use LAN target URL origins like `http://192.168.1.20:8096`, without path,
  query, or hash components.
- Use the Admin page local service scan to discover software already listening
  on the host running The Containers and prefill app targets from those ports.
- Managed Docker and Docker Compose apps can be started, stopped, restarted,
  inspected through logs, pulled, redeployed, checked for drift, and repaired
  from the Admin app details view.
- Keep Caddy Admin API bound to `127.0.0.1`.
- If you use port `80` for proxied apps, keep The Containers itself on `3001`.
- Back up `/opt/the-containers/data/the-containers.sqlite`, the deployment data
  under `DEPLOYMENTS_PATH`, and any Docker volumes or bind mount directories used
  by your apps. The Admin backup export includes app records, settings, managed
  deployment records, redeploy metadata, managed deployment files such as
  Compose project files, and readable Docker bind mount or named volume data.
  Review skipped files in the exported backup and separately back up unreadable
  Docker Desktop VM volumes, skipped large files, external databases, DNS
  records, and router rules.
- See [migration-checklist.md](migration-checklist.md) before moving The
  Containers to a new host.
