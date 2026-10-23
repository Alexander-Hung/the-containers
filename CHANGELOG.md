# Changelog

All notable changes to The Containers will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/) while it is public-facing. During `0.x`, breaking changes may still happen, but they should be documented clearly in release notes.

## [Unreleased]

## [0.5.0] - 2026-10-23

### Security

- Protected API routes now fail closed. With an empty `ADMIN_TOKEN` and a non-loopback `HOST` (including the default `0.0.0.0`), admin requests return `503` instead of being allowed, so a fresh install no longer lets any device on the network deploy containers or service commands. Tokenless access remains only for an API bound to `127.x.x.x`, `::1` or `localhost`.
- `deploy/setup-autostart.sh` generates a random `ADMIN_TOKEN` when the env file has none, prints it once and keeps existing tokens. The env file is now `0640` and its directory `0750`, both owned by `root:<service group>`, so other local users can no longer read the token.

### Added

- Static site deployment for already-built folders through a managed nginx container with read-only static file mounts.
- Custom Caddy routes setting: a JSON array of Caddy route objects, placed ahead of the app routes when Caddy syncs.
- Binary/service deployments can use an existing system service managed by `systemctl`. Deleting such a deployment removes only its route and record; the service stays installed.
- Restore preview. `POST /api/backup/restore/preview` lists every host file and named-volume destination and returns a confirmation that expires after ten minutes. The Admin UI shows the preview before restoring.

### Changed

- **Breaking:** `POST /api/backup/restore` requires the preview's confirmation in the `X-Backup-Confirmation` header.
- **Breaking:** an app import that omits a managed app is rejected without changing the app list. Retained app IDs are updated in place, so their deployment records survive the import.
- **Breaking:** `PUT /api/settings` syncs Caddy after saving and returns `{ settings, proxySync }` instead of the bare settings object.
- Port mappings that The Containers adds for a deployment, when the command or Compose file did not publish the web port, bind to `127.0.0.1`, which Caddy dials.
- Restore preview and restore accept request bodies sized to the export budgets, so exports above 1 MiB restore. Compose project file exports share a 5 MiB total budget.
- New backups record file mode, UID and GID. Restore applies modes, keeps executable bits and reports ownership it cannot apply as warnings. Files from older backups restore with mode `0600`.

### Fixed

- Rewriting a deployment's ports keeps each published port's host IP and protocol, so `-p 127.0.0.1:18080:80` stays loopback-only and `-p 5353:53/udp` stays UDP, in `docker run` and in short and long Compose port forms. Docker run plans keep every original mapping and remap only the selected web port, and automatic port allocation skips ports those mappings use.
- Re-importing an app export no longer deletes every app and, with them, the managed deployment records.
- Backup restore keeps each deployment's provider, so `binary_service` deployments no longer come back as `docker`. Missing or unknown providers are rejected.
- Restore validates the whole backup before changing the database or any file. Files may land only under the deployments directory, discovered Compose project directories or declared bind mounts; path traversal, symbolic links, hard links and conflicting destinations are refused.
- Restore stages host and named-volume files, keeps the originals until the database transaction commits and rolls back on file or database failure. Partial results are reported with `rollbackErrors`, and only one restore runs at a time.
- Docker run redeploy no longer removes anonymous volumes. It reattaches the original container's volumes, starts the replacement before removing the original, and restores the original's name and running state if a step fails. The redeploy preview lists attached volumes.
- Binary/service deployments check that the service listens on the selected web port and explain how to fix a mismatch.
- When `sudo systemctl` needs a password, Binary/service deployment adopts an existing system service that already listens on the configured port, and otherwise explains that the API cannot answer sudo prompts.
- Deploy commands accept shell line continuations (a backslash at the end of a line).
- The Binary/service deploy form no longer carries fields over from other deploy methods, and runs its automatic host check once each time the dialog opens.

## [0.4.1] - 2026-05-14

### Fixed

- Binary/service systemd user commands now set `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` explicitly and report missing user-bus setup during doctor checks.

## [0.4.0] - 2026-05-14

### Added

- Binary/service deployment method for local HTTP services started from user-provided commands.
- Managed service installation for Binary/service deployments through user systemd on Linux and launchd agents on macOS.
- Binary/service lifecycle controls for start, stop, restart, logs, redeploy preview, drift checks, and managed cleanup.
- Binary/service host permission checks for executable availability, service manager availability, and local web port readiness.

### Changed

- Local service deployment ports are now strict for Binary/service deployments. The selected port must be the port the service command listens on, so occupied or privileged ports are blocked instead of auto-remapped.
- Deployment records now support a `binary_service` provider for managed local services.

### Fixed

- launchd restart now uses `launchctl kickstart -k` for loaded agents.
- launchd cleanup now targets `gui/<uid>/<label>` so managed agents unload correctly when stopped or deleted.

## [0.3.0] - 2026-05-14

### Added

- Backup bundle discovery for all local Docker containers by default, including Dockge-managed Compose stacks and manually started containers.
- Backup and restore support for discovered Docker Compose project files.
- Named Docker volume restore through Docker when host volume paths are not directly writable.
- Linux autostart setup script that installs missing platform packages, repairs Docker permissions, detects rootless Docker sockets, configures Caddy, and creates a systemd service.

### Changed

- Version control documentation now uses `develop` for normal development and version-line release branches instead of `feature/*` branches.

## [0.2.0] - 2026-05-13

### Added

- Docker run deployment flow with command parsing, automatic port assignment, host permission checks, and managed cleanup.
- Docker Compose deployment flow with YAML parsing, web service selection, port inference, bind mount checks, host network handling, and managed cleanup.
- Host permission panel for Docker runtime, Compose runtime, bind mounts, privileged containers, capabilities, devices, host networking, Docker socket mounts, public domain DNS, and Caddy sync.
- Public domain plus reverse proxy deploy mode.
- Managed deployment records for self-hosted apps.
- Managed deployment controls for start, stop, restart, logs, image pull, redeploy, and redeploy safety preview.
- Deployment drift checks for missing containers, stopped containers, missing Compose files, port mismatches, and missing redeploy metadata.
- Deployment drift repair actions for starting stopped deployments, redeploying missing managed resources, and updating app targets from runtime ports.
- Backup and restore support for managed deployment records and redeploy metadata.
- Backup bundle support for managed deployment files, readable Docker bind mount and named volume data, plus compatibility handling for older or differently shaped app export files.
- Migration checklist for moving The Containers to a new host.

### Changed

- README now describes The Containers as a dashboard, reverse proxy controller, and self-host deployment manager.
- Backup export format version is now `2` and includes deployment metadata.

## [0.1.0] - 2026-05-13

### Added

- Initial homelab dashboard and reverse proxy controller.
- App management with categories, tags, favorites, ordering, import/export, backup/restore, audit logs, and health checks.
- Caddy Admin API sync.
- Local service discovery and DNS diagnostics.
- Linux deployment guide.
