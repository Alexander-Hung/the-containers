# Changelog

All notable changes to The Containers will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/) while it is public-facing. During `0.x`, breaking changes may still happen, but they should be documented clearly in release notes.

## [Unreleased]

### Added

- Static site deployment for already-built folders through a managed nginx container with read-only static file mounts.

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
