import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z, ZodError } from 'zod';
import { config } from '../../config.js';
import { AppConflictError, type AppsService } from '../apps/apps.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { SettingsService } from '../settings/settings.service.js';

type BackupFile = {
  path: string;
  encoding: 'base64';
  content: string;
  size: number;
  mode?: number;
  uid?: number;
  gid?: number;
};

type DockerMountArchive = {
  deployment: string;
  container: string;
  origin: 'the_containers' | 'registered_app' | 'compose' | 'docker';
  type: 'bind' | 'volume';
  name: string | null;
  source: string;
  destination: string;
  files: BackupFile[];
  skipped: Array<{
    path: string;
    reason: string;
    size?: number;
  }>;
};

type DockerProjectFile = BackupFile & {
  absolutePath: string;
  project: string | null;
  container: string;
};

type DockerMount = {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
};

type DockerInspectContainer = {
  Id?: string;
  Name?: string;
  Config?: {
    Image?: string;
    Labels?: Record<string, string>;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  Mounts?: DockerMount[];
};

const maxBackupFileSize = 1024 * 1024;
const maxBackupFilesTotalSize = 5 * 1024 * 1024;
const maxDockerDataFileSize = Number(process.env.BACKUP_DOCKER_DATA_MAX_FILE_BYTES ?? 25 * 1024 * 1024);
const maxDockerDataTotalSize = Number(process.env.BACKUP_DOCKER_DATA_MAX_TOTAL_BYTES ?? 256 * 1024 * 1024);
// Base64 expansion for deployment files, project files and Docker data, plus
// 16 MiB for JSON keys, paths, app/settings records and archive metadata.
const restoreBodyLimit = Math.ceil((2 * maxBackupFilesTotalSize + maxDockerDataTotalSize) / 3) * 4 + 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function safeRelativePath(value: string) {
  return (
    value &&
    !path.isAbsolute(value) &&
    !value.includes('\0') &&
    !value.split(/[\\/]+/).includes('..')
  );
}

async function collectDeploymentFiles() {
  const files: BackupFile[] = [];
  let totalSize = 0;

  async function walk(dir: string, prefix = '') {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relativePath = path.posix.join(prefix, entry.name);
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const stat = await fs.stat(fullPath);

      if (stat.size > maxBackupFileSize || totalSize + stat.size > maxBackupFilesTotalSize) {
        continue;
      }

      const content = await fs.readFile(fullPath);
      totalSize += stat.size;
      files.push({
        path: relativePath,
        encoding: 'base64',
        content: content.toString('base64'),
        size: stat.size,
        mode: stat.mode & 0o777,
        uid: stat.uid,
        gid: stat.gid
      });
    }
  }

  await walk(config.deploymentsPath);
  return files;
}

async function runDocker(args: string[]) {
  return execFileAsync(config.dockerBin, args, {
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024
  });
}

async function inspectDockerContainer(name: string) {
  const { stdout } = await runDocker(['inspect', name]);
  const parsed = JSON.parse(stdout) as DockerInspectContainer[];
  return parsed[0] ?? null;
}

async function composeContainerNames(projectName: string) {
  const { stdout } = await runDocker([
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${projectName}`,
    '--format',
    '{{.Names}}'
  ]);

  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function allDockerContainerNames() {
  const { stdout } = await runDocker([
    'ps',
    '-a',
    '--format',
    '{{.Names}}'
  ]);

  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function appTargetPorts(apps: Array<{ targetUrl?: string }>) {
  const ports = new Set<number>();

  for (const app of apps) {
    if (!app.targetUrl) {
      continue;
    }

    try {
      const url = new URL(app.targetUrl);
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        ports.add(port);
      }
    } catch {
      // Ignore legacy or partial target URLs in imported backups.
    }
  }

  return ports;
}

function containerHostPorts(container: DockerInspectContainer) {
  const ports = new Set<number>();

  for (const bindings of Object.values(container.NetworkSettings?.Ports ?? {})) {
    for (const binding of bindings ?? []) {
      const port = Number(binding.HostPort);

      if (Number.isInteger(port) && port >= 1 && port <= 65535) {
        ports.add(port);
      }
    }
  }

  return ports;
}

function containerName(container: DockerInspectContainer) {
  return container.Name?.replace(/^\//, '') || container.Id || 'unknown-container';
}

function containerComposeProject(container: DockerInspectContainer) {
  return container.Config?.Labels?.['com.docker.compose.project'] ?? null;
}

function containerComposeConfigFiles(container: DockerInspectContainer) {
  const raw = container.Config?.Labels?.['com.docker.compose.project.config_files'];

  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((file) => file.trim())
    .filter((file) => path.isAbsolute(file));
}

function originForContainer(
  container: DockerInspectContainer,
  managedNames: Set<string>,
  registeredPorts: Set<number>
): DockerMountArchive['origin'] {
  const name = containerName(container);

  if (managedNames.has(name) || (containerComposeProject(container) && managedNames.has(containerComposeProject(container) ?? ''))) {
    return 'the_containers';
  }

  for (const port of containerHostPorts(container)) {
    if (registeredPorts.has(port)) {
      return 'registered_app';
    }
  }

  return containerComposeProject(container) ? 'compose' : 'docker';
}

async function collectFilesFromPath(
  root: string,
  options: {
    maxFileSize: number;
    remainingBytes: () => number;
    consumeBytes: (bytes: number) => void;
  }
) {
  const files: BackupFile[] = [];
  const skipped: DockerMountArchive['skipped'] = [];
  const resolvedRoot = path.resolve(root);

  async function walk(dir: string, prefix = '') {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;

    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skipped.push({ path: prefix || '.', reason: 'unreadable' });
      return;
    }

    for (const entry of entries) {
      const relativePath = path.posix.join(prefix, entry.name);
      const fullPath = path.join(dir, entry.name);
      const resolvedPath = path.resolve(fullPath);

      if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`) && resolvedPath !== resolvedRoot) {
        skipped.push({ path: relativePath, reason: 'outside-root' });
        continue;
      }

      if (entry.isSymbolicLink()) {
        skipped.push({ path: relativePath, reason: 'symlink' });
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
        continue;
      }

      if (!entry.isFile()) {
        skipped.push({ path: relativePath, reason: 'not-file' });
        continue;
      }

      const stat = await fs.stat(fullPath);

      if (stat.size > options.maxFileSize) {
        skipped.push({ path: relativePath, reason: 'file-too-large', size: stat.size });
        continue;
      }

      if (stat.size > options.remainingBytes()) {
        skipped.push({ path: relativePath, reason: 'bundle-size-limit', size: stat.size });
        continue;
      }

      const content = await fs.readFile(fullPath);
      options.consumeBytes(stat.size);
      files.push({
        path: relativePath,
        encoding: 'base64',
        content: content.toString('base64'),
        size: stat.size,
        mode: stat.mode & 0o777,
        uid: stat.uid,
        gid: stat.gid
      });
    }
  }

  await walk(resolvedRoot);
  return { files, skipped };
}

async function discoverBackupContainers(
  deployments: Array<{ provider: string; resourceName: string }>,
  apps: Array<{ targetUrl?: string }>
) {
  const backupScope = (process.env.BACKUP_DOCKER_SCOPE ?? 'all').toLowerCase();
  const managedNames = new Set(deployments.map((deployment) => deployment.resourceName));
  const registeredPorts = appTargetPorts(apps);
  const containersByName = new Map<string, DockerInspectContainer>();

  for (const deployment of deployments) {
    try {
      if (deployment.provider === 'docker_compose') {
        const names = await composeContainerNames(deployment.resourceName);

        for (const name of names) {
          const container = await inspectDockerContainer(name);

          if (container) {
            containersByName.set(containerName(container), container);
          }
        }
      } else {
        const container = await inspectDockerContainer(deployment.resourceName);

        if (container) {
          containersByName.set(containerName(container), container);
        }
      }
    } catch {
      continue;
    }
  }

  if (backupScope !== 'managed') {
    try {
      const names = await allDockerContainerNames();

      for (const name of names) {
        if (containersByName.has(name)) {
          continue;
        }

        const container = await inspectDockerContainer(name);

        if (container) {
          containersByName.set(containerName(container), container);
        }
      }
    } catch {
      // Docker may be unavailable on development machines. The app backup still remains useful.
    }
  }

  return [...containersByName.values()].map((container) => ({
    container,
    origin: originForContainer(container, managedNames, registeredPorts)
  }));
}

async function collectDockerProjectFiles(
  containers: Array<{ container: DockerInspectContainer; origin: DockerMountArchive['origin'] }>
) {
  const files: DockerProjectFile[] = [];
  const seen = new Set<string>();
  let totalSize = 0;

  for (const { container } of containers) {
    for (const filePath of containerComposeConfigFiles(container)) {
      const resolved = path.resolve(filePath);

      if (seen.has(resolved)) {
        continue;
      }

      seen.add(resolved);

      try {
        const stat = await fs.stat(resolved);

        if (!stat.isFile() || stat.size > maxBackupFileSize || totalSize + stat.size > maxBackupFilesTotalSize) {
          continue;
        }

        const content = await fs.readFile(resolved);

        totalSize += stat.size;
        files.push({
          path: path.basename(resolved),
          absolutePath: resolved,
          project: containerComposeProject(container),
          container: containerName(container),
          encoding: 'base64',
          content: content.toString('base64'),
          size: stat.size,
          mode: stat.mode & 0o777,
          uid: stat.uid,
          gid: stat.gid
        });
      } catch {
        continue;
      }
    }
  }

  return files;
}

async function collectDockerDataArchives(
  containers: Array<{ container: DockerInspectContainer; origin: DockerMountArchive['origin'] }>
) {
  const archives: DockerMountArchive[] = [];
  let totalSize = 0;
  const seenMounts = new Set<string>();

  for (const { container, origin } of containers) {
    const name = containerName(container);
    const deployment = containerComposeProject(container) ?? name;

    for (const mount of container.Mounts ?? []) {
      if (
        mount.Type !== 'bind' &&
        mount.Type !== 'volume'
      ) {
        continue;
      }

      if (!mount.Source || !mount.Destination) {
        continue;
      }

      const mountKey = `${mount.Type}:${mount.Name ?? mount.Source}`;

      if (seenMounts.has(mountKey)) {
        continue;
      }

      seenMounts.add(mountKey);

      const { files, skipped } = await collectFilesFromPath(mount.Source, {
        maxFileSize: maxDockerDataFileSize,
        remainingBytes: () => Math.max(0, maxDockerDataTotalSize - totalSize),
        consumeBytes: (bytes) => {
          totalSize += bytes;
        }
      });

      archives.push({
        deployment,
        container: name,
        origin,
        type: mount.Type,
        name: mount.Name ?? null,
        source: mount.Source,
        destination: mount.Destination,
        files,
        skipped
      });
    }
  }

  return archives;
}

class InvalidBackupError extends Error {}

function hasControlCharacters(value: string) {
  return [...value].some((character) => character.charCodeAt(0) < 32);
}

const backupFileSchema = z.object({
  path: z.string().min(1).refine((value) => Boolean(safeRelativePath(value)) && value !== '.' && !hasControlCharacters(value)),
  encoding: z.literal('base64'),
  content: z.string().refine((value) => Buffer.from(value, 'base64').toString('base64') === value, 'Invalid base64 content'),
  size: z.number().int().nonnegative(),
  mode: z.number().int().min(0).max(0o777).optional(),
  uid: z.number().int().min(0).max(0xfffffffe).optional(),
  gid: z.number().int().min(0).max(0xfffffffe).optional()
}).refine((file) => Buffer.byteLength(file.content, 'base64') === file.size, 'File size does not match content');
const absolutePathSchema = z.string().refine((value) => path.isAbsolute(value) && !hasControlCharacters(value));
const restoreManifestSchema = z.object({
  apps: z.array(z.unknown()),
  deployments: z.array(z.unknown()).optional(),
  settings: z.unknown().optional(),
  deploymentFiles: z.array(backupFileSchema).default([]),
  dockerProjectFiles: z.array(z.object({
    absolutePath: absolutePathSchema,
    // File validation is shared with deployment and mount entries.
  }).passthrough().and(backupFileSchema)).default([]),
  dockerDataArchives: z.array(z.object({
    type: z.enum(['bind', 'volume']),
    source: absolutePathSchema,
    name: z.string().nullable().optional(),
    files: z.array(backupFileSchema)
  }).refine((archive) => archive.type !== 'volume' || Boolean(archive.name?.match(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)), 'Invalid volume name')).default([])
});
type RestoreManifest = z.infer<typeof restoreManifestSchema>;

function withinRoot(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function validateHostTarget(target: string) {
  // Check every existing component, including the final file and the approved root.
  // Missing components are allowed, but links never establish an approved destination.
  let current = path.parse(target).root;
  const parts = target.slice(current.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) ||
        (index === parts.length - 1 && (!stat.isFile() || stat.nlink > 1))) {
      throw new InvalidBackupError(`Unsafe restore destination: ${current}`);
    }
  }
}

async function validateRestoreManifest(body: unknown, appsService: AppsService) {
  const manifest = restoreManifestSchema.parse(body);
  const roots = [path.resolve(config.deploymentsPath)];
  if (manifest.dockerProjectFiles.length) {
    const containers = await discoverBackupContainers(appsService.exportDeployments(), appsService.exportApps().apps);
    roots.push(...containers.flatMap(({ container }) => containerComposeConfigFiles(container).map((file) => path.dirname(file))));
  }
  // Declared bind roots are visible in the preview and require a separate confirmation.
  roots.push(...manifest.dockerDataArchives.filter((archive) => archive.type === 'bind').map((archive) => path.resolve(archive.source)));
  if (roots.some((root) => root === path.parse(root).root)) {
    throw new InvalidBackupError('A filesystem root cannot be a restore destination');
  }
  const destinations: string[] = [];
  const hostTargets = new Map<string, string>();
  async function addTarget(target: string, file: BackupFile) {
    const contents = JSON.stringify([file.content, file.mode, file.uid, file.gid]);
    // Managed compose files can legitimately appear in both export sections.
    if (hostTargets.get(target) === contents) return;
    if (hostTargets.has(target) || [...hostTargets.keys()].some((other) => withinRoot(other, target) || withinRoot(target, other))) {
      throw new InvalidBackupError(`Conflicting restore destination: ${target}`);
    }
    await validateHostTarget(target);
    hostTargets.set(target, contents);
    destinations.push(target);
  }
  for (const file of manifest.deploymentFiles) {
    const target = path.resolve(config.deploymentsPath, file.path);
    if (!withinRoot(config.deploymentsPath, target)) throw new InvalidBackupError(`Invalid deployment path: ${file.path}`);
    await addTarget(target, file);
  }
  for (const file of manifest.dockerProjectFiles) {
    const target = path.resolve(file.absolutePath);
    if (!roots.some((root) => withinRoot(root, target))) throw new InvalidBackupError(`Unapproved project destination: ${target}`);
    await addTarget(target, file);
  }
  const volumeTargets = new Set<string>();
  for (const archive of manifest.dockerDataArchives) {
    for (const file of archive.files) {
      const target = path.resolve(archive.source, file.path);
      if (!withinRoot(archive.source, target)) throw new InvalidBackupError(`Invalid mount path: ${file.path}`);
      if (archive.type === 'bind') await addTarget(target, file);
      else {
        const destination = `volume:${archive.name}/${path.posix.normalize(file.path)}`;
        if ([...volumeTargets].some((other) => other === destination || other.startsWith(`${destination}/`) || destination.startsWith(`${other}/`))) {
          throw new InvalidBackupError(`Conflicting volume destination: ${destination}`);
        }
        volumeTargets.add(destination);
        destinations.push(destination);
      }
    }
  }
  return { manifest, destinations };
}

async function writeBackupFile(target: string, file: BackupFile, warnings: string[]) {
  await validateHostTarget(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await validateHostTarget(target);
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if ((await handle.stat()).nlink > 1) throw new InvalidBackupError(`Hard-linked restore destination: ${target}`);
    await handle.truncate(0);
    await handle.writeFile(Buffer.from(file.content, 'base64'));
    if (file.uid !== undefined && file.gid !== undefined) {
      try {
        await handle.chown(file.uid, file.gid);
      } catch (error) {
        warnings.push(`Could not restore ownership ${file.uid}:${file.gid} for ${target}: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
      }
    }
    // Apply permissions after ownership (chown can clear special mode bits).
    await handle.chmod(file.mode ?? 0o600);
  } finally {
    await handle.close();
  }
}

async function writeBackupFilesToRoot(root: string, files: BackupFile[], warnings: string[]) {
  for (const file of files) await writeBackupFile(path.resolve(root, file.path), file, warnings);
  return files.length;
}

async function restoreNamedVolume(name: string, files: BackupFile[], warnings: string[]) {
  const tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'the-containers-volume-restore-')));
  const helperName = `the-containers-restore-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeBackupFilesToRoot(tmpRoot, files, warnings);
    await runDocker(['volume', 'create', name]);
    try {
      await runDocker(['create', '--name', helperName, '-v', `${name}:/restore`, 'busybox:latest', 'sh']);
    } catch {
      await runDocker(['pull', 'busybox:latest']);
      await runDocker(['create', '--name', helperName, '-v', `${name}:/restore`, 'busybox:latest', 'sh']);
    }
    await runDocker(['cp', '-a', `${tmpRoot}${path.sep}.`, `${helperName}:/restore`]);
    return files.length;
  } finally {
    await runDocker(['rm', '-f', helperName]).catch(() => undefined);
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function restoreDockerDataArchives(archives: RestoreManifest['dockerDataArchives'], warnings: string[]) {
  let restored = 0;
  for (const archive of archives) {
    if (!archive.files.length) continue;
    // Never fall back from a named volume to an arbitrary host source path.
    restored += archive.type === 'volume'
      ? await restoreNamedVolume(archive.name!, archive.files, warnings)
      : await writeBackupFilesToRoot(archive.source, archive.files, warnings);
  }
  return restored;
}

function extractBackupBody(input: unknown) {
  if (Array.isArray(input)) {
    return { apps: input };
  }

  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : {};
  const payload = record.payload && typeof record.payload === 'object'
    ? record.payload as Record<string, unknown>
    : {};

  return {
    ...record,
    apps: record.apps ?? data.apps ?? payload.apps ?? record.items ?? data.items ?? payload.items,
    deployments: record.deployments ?? data.deployments ?? payload.deployments,
    deploymentFiles:
      record.deploymentFiles ??
      record.deployment_files ??
      data.deploymentFiles ??
      data.deployment_files ??
      payload.deploymentFiles ??
      payload.deployment_files,
    dockerDataArchives:
      record.dockerDataArchives ??
      record.docker_data_archives ??
      data.dockerDataArchives ??
      data.docker_data_archives ??
      payload.dockerDataArchives ??
      payload.docker_data_archives,
    dockerProjectFiles:
      record.dockerProjectFiles ??
      record.docker_project_files ??
      data.dockerProjectFiles ??
      data.docker_project_files ??
      payload.dockerProjectFiles ??
      payload.docker_project_files,
    settings: record.settings ?? data.settings ?? payload.settings
  };
}

export async function registerBackupRoutes(
  app: FastifyInstance,
  appsService: AppsService,
  settingsService: SettingsService,
  auditService: AuditService
) {
  app.get('/api/backup', async () => {
    const deploymentFiles = await collectDeploymentFiles();
    const deployments = appsService.exportDeployments();
    const apps = appsService.exportApps().apps;
    const dockerContainers = await discoverBackupContainers(deployments, apps);
    const dockerProjectFiles = await collectDockerProjectFiles(dockerContainers);
    const dockerDataArchives = await collectDockerDataArchives(dockerContainers);

    return {
      exportedAt: new Date().toISOString(),
      version: 6,
      kind: 'the-containers-backup',
      apps,
      deployments,
      deploymentFiles,
      dockerProjectFiles,
      dockerDataArchives,
      notes: [
        'This backup includes The Containers configuration, managed deployment files, discovered Docker Compose project files, and readable Docker bind mount or named volume data.',
        'By default BACKUP_DOCKER_SCOPE=all scans all local Docker containers, including Dockge-managed stacks and manually started containers. Set BACKUP_DOCKER_SCOPE=managed to only include The Containers managed deployments.',
        'External databases, DNS records, router rules, unreadable host paths, skipped large files, and files outside Docker mounts may still need separate backup.'
      ],
      settings: settingsService.getAll()
    };
  });

  const confirmations = new Map<string, { digest: string; expires: number }>();
  const digest = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

  app.post('/api/backup/restore/preview', { bodyLimit: restoreBodyLimit }, async (request, reply) => {
    try {
      const body = extractBackupBody(request.body);
      const { destinations } = await validateRestoreManifest(body, appsService);
      for (const [token, entry] of confirmations) {
        if (entry.expires < Date.now()) confirmations.delete(token);
      }
      if (confirmations.size >= 20) confirmations.delete(confirmations.keys().next().value!);
      const confirmation = randomBytes(32).toString('hex');
      confirmations.set(confirmation, { digest: digest(body), expires: Date.now() + 10 * 60_000 });
      return { destinations, confirmation };
    } catch (error) {
      if (error instanceof ZodError || error instanceof InvalidBackupError) {
        return reply.code(400).send({ message: error.message });
      }
      throw error;
    }
  });

  app.post('/api/backup/restore', { bodyLimit: restoreBodyLimit }, async (request, reply) => {
    const rawBody = extractBackupBody(request.body);
    try {
      const { manifest: body, destinations } = await validateRestoreManifest(rawBody, appsService);
      if (destinations.length) {
        const token = request.headers['x-backup-confirmation'];
        const confirmation = typeof token === 'string' ? confirmations.get(token) : undefined;
        if (!confirmation || confirmation.expires < Date.now() || confirmation.digest !== digest(rawBody)) {
          throw new InvalidBackupError('Preview and confirm this backup before restoring files');
        }
        confirmations.delete(token as string);
      }
      const result = await appsService.restoreBackup({
        apps: body.apps,
        deployments: body.deployments,
        settings: body.settings,
        settingsService,
        adminTokenConfigured: Boolean(config.adminToken)
      });
      const warnings: string[] = [];
      const allFiles = [...body.deploymentFiles, ...body.dockerProjectFiles, ...body.dockerDataArchives.flatMap((archive) => archive.files)];
      if (allFiles.some((file) => file.mode === undefined || file.uid === undefined || file.gid === undefined)) {
        warnings.push('Some files have no permission or ownership metadata (legacy backup); missing modes default to 0600 and missing ownership is unchanged (new files belong to the service user).');
      }
      const deploymentFiles = await writeBackupFilesToRoot(config.deploymentsPath, body.deploymentFiles, warnings);
      for (const file of body.dockerProjectFiles) await writeBackupFile(path.resolve(file.absolutePath), file, warnings);
      const dockerProjectFiles = body.dockerProjectFiles.length;
      const dockerDataFiles = await restoreDockerDataArchives(body.dockerDataArchives, warnings);
      auditService.record({
        action: 'backup.restore',
        targetType: 'backup',
        summary: `Restored ${body.apps.length} apps, ${deploymentFiles} deployment files, ${dockerProjectFiles} Docker project files, and ${dockerDataFiles} Docker data files`,
        sourceIp: request.ip
      });

      return {
        ...result,
        deploymentFiles,
        dockerProjectFiles,
        dockerDataFiles,
        warnings
      };
    } catch (error) {
      if (error instanceof InvalidBackupError) {
        return reply.code(400).send({ message: error.message });
      }
      if (error instanceof ZodError) {
        return reply.code(400).send({
          message: 'Invalid backup input',
          issues: error.issues
        });
      }

      if (error instanceof AppConflictError) {
        return reply.code(409).send({ message: error.message });
      }

      throw error;
    }
  });

  app.get('/api/backup/snapshots', async () => appsService.listBackupSnapshots());
}
