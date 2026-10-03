# The Containers

The Containers is a lightweight homelab dashboard, reverse proxy controller, and self-host deployment manager. It gives users one place to register existing services, deploy Docker-based apps and local binary services, assign ports, bind routes, check health, and keep Caddy reverse proxy configuration in sync.

The project is designed for mini PCs, NAS boxes, Raspberry Pi hosts, home servers, and small cloud machines. It treats services as plain HTTP upstreams, so Docker, Docker Compose, bare-metal processes, NAS apps, and LAN devices can all appear in the same dashboard.

## Current Status

Available now:

- App dashboard with categories, tags, favorites, ordering, and health status.
- Admin panel for app CRUD, import/export, backup/restore, settings, audits, diagnostics, and proxy sync.
- Caddy Admin API integration for generated reverse proxy configuration.
- Subdomain and subpath routing modes. Subdomain mode is recommended.
- Local service discovery for ports already listening on the host running The Containers.
- DNS diagnostics for route and public domain checks.
- Docker run deployments with command parsing, automatic port assignment, permission checks, and managed cleanup.
- Docker Compose deployments with YAML parsing, web service selection, port inference, bind mount checks, host network handling, and managed cleanup.
- Static site deployments for already-built folders, served through a managed nginx container with read-only mounts.
- Binary/service deployments for local HTTP services, installed as user systemd services on Linux or launchd agents on macOS.
- Host permission panel for Docker CLI, Docker daemon, Compose runtime, bind mounts, privileged containers, capabilities, devices, host networking, Docker socket mounts, public domain DNS, and Caddy sync.
- Managed deployment records. Apps deployed by The Containers are marked as managed and are cleaned up when deleted.
- Managed deployment controls for start, stop, restart, logs, image pull, redeploy, and redeploy safety preview.
- Deployment drift checks for missing containers, stopped containers, missing Compose files, port mismatches, and missing redeploy metadata.
- Drift repair actions for starting stopped deployments, redeploying missing resources, and updating app targets from runtime ports.
- Backup and restore for apps, settings, managed deployment records, and redeploy metadata.

Planned:

- GitHub auto-detect deployments.
- Static site build steps from source repositories.
- Node.js app deployments.
- Python app deployments.
- Advanced custom command deployments.
- Multi-host or agent-based management.

## Stack

- Web: React, Vite, TailwindCSS
- API: Node.js, Fastify
- Database: SQLite
- Reverse proxy: Caddy Admin API
- Deploy runtime: Docker CLI, Docker Compose, user systemd, and launchd

## Development

```bash
npm install
npm run dev
```

Default development URLs:

- Web: `http://localhost:5173`
- API: `http://localhost:3001`

## Production Build

```bash
npm ci
npm run build
npm start
```

The production API serves both `/api/*` and the built web dashboard.

## Linux Deployment

See [docs/deploy-linux.md](docs/deploy-linux.md) for the Debian/Ubuntu mini PC deployment path using Node.js, SQLite, Caddy, and systemd.

Fast path after cloning the repository:

```bash
./install.sh
./start.sh
```

For a new Linux server where you want Docker permissions repaired and The Containers started automatically on boot, run:

```bash
./deploy/setup-autostart.sh
```

The autostart script installs missing Debian/Ubuntu packages when `apt-get` is available, adds the service user to the `docker` group, detects rootless Docker sockets when present, writes `/etc/the-containers/the-containers.env`, builds the app, installs the Caddyfile, and creates `the-containers.service`.

If you want the service to run as a specific user:

```bash
THE_CONTAINERS_SERVICE_USER=alexander ./deploy/setup-autostart.sh
```

## Environment

Common production variables:

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
DOCKER_BIN=docker
DEPLOYMENTS_PATH=/opt/the-containers/data/deployments
HEALTH_CHECK_INTERVAL_SECONDS=0
THE_CONTAINERS_DASHBOARD_TARGET_URL=http://127.0.0.1:3001
```

For production, set a strong `ADMIN_TOKEN`. Set `DASHBOARD_AUTH_REQUIRED=true` if the read-only dashboard should also require authentication.

## Deployments

The Containers can deploy from:

- `docker run` commands
- Docker Compose YAML
- built static site folders
- Binary/service commands for local HTTP services

The deploy flow is:

1. Paste a Docker command, Compose file, static folder path, or Binary/service command.
2. The Containers auto-fills app name, route host, and ports when possible.
3. Review Host permission checks.
4. Preview the deployment plan.
5. Deploy.
6. The Containers creates the app route and saves a managed deployment record.

Binary/service deployments require the local web port where the service listens. The Containers does not auto-remap Binary/service ports because the user-provided command controls the listener. On Linux, Binary/service deployments are installed as user systemd services. On macOS, they are installed as launchd agents.

Linux Binary/service deployments require a working user systemd bus for the user running The Containers. If The Containers itself runs from a system service, enable linger for that user and make sure `user@UID.service` is running. The deploy doctor shows the exact `loginctl`, `systemctl`, `XDG_RUNTIME_DIR`, and `DBUS_SESSION_BUS_ADDRESS` commands for the current user.

When a managed app is deleted, The Containers attempts to remove the related Docker container, Compose project, or local service and free the route.

App imports replace the app list by ID, preserving managed deployment records for retained IDs. An import that omits a managed app is rejected without changing the app list; include that app in the import or delete it through the managed app delete flow first. Omitted unmanaged apps are removed. App imports do not restore deployment metadata; use backup restore for that. Backup restore accepts only `docker`, `docker_compose`, and `binary_service` deployment providers and rejects missing or unknown providers.

## Managed Deployment Operations

Apps deployed by The Containers receive a `Self-Host` badge and a managed deployment record. From the Admin app details view, managed apps can be:

- Started, stopped, and restarted.
- Inspected with runtime status, Compose container details, or local service status.
- Viewed through recent Docker, Docker Compose, journalctl, or launchd logs.
- Updated with image pull.
- Redeployed from saved deployment metadata.
- Checked for deployment drift.
- Repaired when a safe repair action is available.

Redeploy preview shows what will be pulled, recreated, preserved, and removed before the action runs, including attached Docker volumes and their destinations. Docker run redeploy reattaches anonymous volumes, creates a replacement before stopping the previous container, and retains the previous container until replacement startup and the deployment-record update succeed. Failures restore the previous container name and running state; container cleanup never deletes volumes during redeploy. Docker startup success does not establish application health. Docker run redeploy requires saved metadata, so older deployments may need to be deleted and deployed again once before safe redeploy is available.

Deployment drift checks can detect:

- Missing Docker containers or Compose project containers.
- Stopped managed deployments.
- Missing managed Compose files.
- Stopped managed local services.
- App target ports that no longer match saved deployment metadata or runtime ports.
- Docker run deployments that are missing redeploy metadata.

Backup exports include apps, settings, managed deployment records, redeploy metadata, managed deployment files, discovered Docker Compose project files, and readable Docker bind mount or named volume data. By default, the backup scans all local Docker containers so Dockge-managed stacks and manually started containers can be included in the same bundle. Set `BACKUP_DOCKER_SCOPE=managed` to only include deployments created by The Containers. See [docs/migration-checklist.md](docs/migration-checklist.md) before moving The Containers to a new host.

Restore first previews the exact host files and named-volume destinations for confirmation. It validates every file before changing records, rejects symbolic links and conflicting destinations, and limits project files to the configured deployments directory, locally discovered Compose directories, or declared bind mounts. On a new host, map project files into an approved directory before restoring. The confirmation expires after ten minutes; API clients must call `POST /api/backup/restore/preview` with the backup, then send the same backup to `POST /api/backup/restore` with the returned `confirmation` in the `X-Backup-Confirmation` header.

Restore stages all host and named-volume files before replacing destinations, keeps originals for rollback, and commits database changes after the files are applied. Failed file application or database transactions restore the originals. Responses include `restore.database` and `restore.files`; `restore.files: "partial"` includes `rollbackErrors` with retained-original locations for manual recovery. Cleanup failures are warnings after a successful commit. Only one restore runs at a time. Stop workloads that write to restored data before restoring: this rollback handles operation errors, not concurrent application writes or process/host crashes across filesystem and database changes.

New backups include file permission bits and numeric UID/GID. Restore attempts ownership without elevation and reports warnings when it is not permitted. Legacy backups without this metadata use mode `0600` and retain existing ownership (new files belong to the service user). Named-volume restores use `docker cp -a`; a failed volume restore never writes to its recorded host source as a fallback. File permissions cover `0777` bits; special bits and directory metadata are not archived.

Preview and restore accept the configured Docker data cap plus two 5 MiB file budgets, base64 expansion, and 16 MiB of JSON metadata. Other routes keep their normal body limit. Compose project file exports now share a 5 MiB total budget.

## Important Safety Model

The Containers automates common deployment work, but it does not bypass operating system permissions.

It can automatically:

- Allocate safe high ports.
- Create normal writable bind mount paths.
- Write managed Compose files.
- Write managed user systemd services or launchd agents for Binary/service deployments.
- Call Docker and Docker Compose.
- Sync Caddy routes.
- Remove managed containers, Compose projects, or local service files.
- Start, stop, restart, pull, and redeploy managed deployments.
- Export and restore managed deployment metadata.

It will not silently:

- Run `sudo`.
- Install root-level system services.
- Change Docker socket permissions.
- Modify router port forwarding.
- Change public DNS records.
- Expose Caddy Admin API to the public internet.
- Override protected host paths without user action.
- Guarantee that every app data file exists on a new host after restore. The backup restores readable Docker data and uses named Docker volumes when possible, but unreadable host paths, skipped large files, external databases, DNS records, and router rules may still require separate backup.

Host permission checks are shown before deploy so users can see what is ready, what The Containers can handle, and what needs manual host authorization.

## Validation

```bash
npm run lint
npm run typecheck
npm run build
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request guidelines.

Security reports should follow [SECURITY.md](SECURITY.md).

Release preparation is documented in [RELEASE.md](RELEASE.md), and user-facing changes are tracked in [CHANGELOG.md](CHANGELOG.md).

Branching and version control conventions are documented in [docs/version-control.md](docs/version-control.md).

## License

The Containers is released under the [MIT License](LICENSE).

## Notes for Maintainers

Public repository content should be written in English. Local personal planning notes under `docs/*.md` are ignored by git, except for `docs/deploy-linux.md`, which is the public Linux deployment guide.
