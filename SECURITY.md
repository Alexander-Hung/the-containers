# Security Policy

## Supported Versions

The Containers is currently pre-1.0. Security fixes are applied to the main branch until formal release channels are established.

| Version | Supported |
| --- | --- |
| main | Yes |
| 0.x | Best effort |

## Reporting a Vulnerability

Please do not open a public issue for sensitive security reports.

Report security concerns by contacting the maintainer through the repository owner profile, or by creating a private advisory if GitHub Security Advisories are enabled for the repository.

When reporting, include:

- Affected version or commit.
- Operating system and deployment mode.
- Steps to reproduce.
- Impact.
- Whether Docker, Caddy, or exposed public domains are involved.
- Any relevant logs with secrets removed.

## Security Model

The Containers can call Docker and Docker Compose on the host. This is powerful and must be treated as host-level access.

Protected API routes require `ADMIN_TOKEN` when `HOST` is not loopback. An empty
token on the default `HOST=0.0.0.0` returns `503` for admin requests; configured
tokens return `401` for missing or incorrect credentials. Health checks and the
read-only app list remain public unless dashboard authentication is required
for the app list. Required dashboard authentication fails closed with `503`
when no token is configured.

Tokenless access is supported only for trusted local development bound to
`127.x.x.x`, `::1`, or `localhost`. Do not expose a tokenless loopback API through
Caddy or a tunnel; the guard uses the configured `HOST` and cannot determine
whether a reverse proxy exposes it elsewhere.

`deploy/setup-autostart.sh` generates a random admin token when the env file has
none and prints it once. Existing tokens are preserved. The env directory and
file belong to `root:<service group>`, with modes `0750` and `0640`
respectively on every run. Reruns normalize existing permissions, including
`0700` directories and `0600` files, so the service group can traverse the
directory and read the file while other users have no access.
The basic `install.sh` and manual install paths require an explicitly configured
token for non-loopback admin access.

The Containers will not silently:

- Run `sudo`.
- Change Docker socket permissions.
- Modify router port forwarding.
- Change public DNS records.
- Expose Caddy Admin API to the public internet.
- Override protected host paths without user action.

The Host permission panel is designed to show users which deploy inputs require explicit host-level review, including:

- Privileged containers.
- Host networking.
- Host PID or IPC namespaces.
- Linux capabilities.
- Host devices.
- Docker socket mounts.
- Bind mounts in protected paths.

## Recommended Production Practices

- Set a strong `ADMIN_TOKEN`.
- Set `DASHBOARD_AUTH_REQUIRED=true` when the dashboard is not fully private.
- Keep Caddy Admin API bound to `127.0.0.1`.
- Do not expose Docker socket to untrusted containers.
- Review images before deploying privileged containers.
- Back up SQLite data before upgrades.
- Keep Docker, Caddy, Node.js, and the host OS patched.
