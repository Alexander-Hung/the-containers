import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { config } from '../../config.js';
import type { ContainersDatabase } from '../../db/database.js';
import type { AppsService } from '../apps/apps.service.js';
import { DeploymentsRepo } from './deployments.repo.js';

const execFileAsync = promisify(execFile);

const deployInputSchema = z.object({
  method: z.enum([
    'docker_run',
    'docker_compose',
    'github_auto',
    'static_site',
    'node_app',
    'python_app',
    'binary_service',
    'custom_command'
  ]).default('docker_run'),
  command: z.string().trim().min(1).max(8000),
  publishMode: z.enum(['reverse_proxy', 'public_domain_reverse_proxy']).default('reverse_proxy'),
  name: z.string().trim().min(1).max(80).optional(),
  publicHost: z.string().trim().min(1).max(253),
  routeMode: z.enum(['subdomain', 'subpath']).default('subdomain'),
  publicPath: z.string().trim().max(120).nullable().optional(),
  hostPort: z.number().int().min(1).max(65535).nullable().optional(),
  containerPort: z.number().int().min(1).max(65535).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
  favorite: z.boolean().default(false),
  enabled: z.boolean().default(true)
});

type ParsedDeployInput = z.infer<typeof deployInputSchema>;

type PublishedPort = {
  hostIp: string | null;
  hostPort: number | null;
  containerPort: number;
  protocol: string;
};

type DockerRunPlan = {
  method: 'docker_run' | 'docker_compose' | 'static_site' | 'binary_service';
  containerName: string;
  image: string;
  publishMode: 'reverse_proxy' | 'public_domain_reverse_proxy';
  hostPort: number | null;
  containerPort: number;
  protocol: string;
  targetUrl: string;
  hostMounts: HostMount[];
  composeFilePath?: string;
  composeProjectDir?: string;
  composeContent?: string;
  appPayload: {
    name: string;
    iconType: 'builtin';
    iconValue: string | null;
    targetUrl: string;
    routeMode: 'subdomain' | 'subpath';
    publicHost: string;
    publicPath: string | null;
    enabled: boolean;
    sortOrder: number;
    category: string | null;
    tags: string[];
    favorite: boolean;
  };
  dockerArgs: string[];
  processCommand?: string;
  processArgs?: string[];
  serviceArgs?: string[];
  serviceName?: string;
  serviceFilePath?: string;
  serviceKind?: 'systemd_user' | 'systemd_system' | 'launchd_user' | 'process';
  systemctlAction?: 'start' | 'restart';
  systemctlUsesSudo?: boolean;
  warnings: string[];
  resolvedDeployInput: ParsedDeployInput & Record<string, unknown>;
};

type DockerInspectPort = Array<{
  HostIp: string;
  HostPort: string;
}> | null;

type DockerInspectContainer = {
  Id: string;
  Name: string;
  Config?: {
    Image?: string;
  };
  State?: {
    Running?: boolean;
    Status?: string;
  };
  Mounts?: Array<{ Type?: string; Name?: string; Destination?: string; RW?: boolean }>;
  NetworkSettings?: {
    Ports?: Record<string, DockerInspectPort>;
  };
};

type HostMount = {
  source: string;
  target: string | null;
  baseDir?: string;
};

type JsonRecord = Record<string, unknown>;

type ComposeConfig = {
  config: JsonRecord;
  services: Array<[string, JsonRecord]>;
};

type ComposeServiceSelection = {
  name: string;
  service: JsonRecord;
  image: string;
  containerName: string | null;
  port: PublishedPort | null;
  exposePort: number | null;
  hostNetwork: boolean;
};

type DeployDoctorCheck = {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
};

type DeployPermissionRequirement = {
  id: string;
  label: string;
  status: 'ready' | 'auto' | 'needs_user' | 'blocked';
  userHelpRequired: boolean;
  detail: string;
  commands: string[];
};

type DeployDoctorGrantStep = {
  title: string;
  description: string;
  commands: string[];
};

type DeploymentDriftCheck = {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
};

type DeploymentRepairAction = {
  id: 'start' | 'redeploy' | 'update_target_from_runtime';
  label: string;
  detail: string;
  severity: 'safe' | 'review';
};

const deployDoctorInputSchema = z.object({
  method: z.enum([
    'docker_run',
    'docker_compose',
    'github_auto',
    'static_site',
    'node_app',
    'python_app',
    'binary_service',
    'custom_command'
  ]).default('docker_run'),
  command: z.string().trim().max(8000).optional(),
  name: z.string().trim().max(80).optional(),
  publishMode: z.enum(['reverse_proxy', 'public_domain_reverse_proxy']).default('reverse_proxy'),
  publicHost: z.string().trim().max(253).optional(),
  hostPort: z.number().int().min(1).max(65535).nullable().optional(),
  containerPort: z.number().int().min(1).max(65535).nullable().optional()
}).passthrough();

const optionValueNames = new Set([
  '--add-host',
  '--attach',
  '--blkio-weight',
  '--cap-add',
  '--cap-drop',
  '--cgroup-parent',
  '--cidfile',
  '--cpuset-cpus',
  '--cpuset-mems',
  '--cpu-period',
  '--cpu-quota',
  '--cpu-rt-period',
  '--cpu-rt-runtime',
  '--cpu-shares',
  '--dns',
  '--dns-option',
  '--dns-search',
  '--entrypoint',
  '--env',
  '--env-file',
  '--expose',
  '--group-add',
  '--health-cmd',
  '--health-interval',
  '--health-retries',
  '--health-start-period',
  '--health-timeout',
  '--hostname',
  '--ip',
  '--ip6',
  '--label',
  '--label-file',
  '--log-driver',
  '--log-opt',
  '--memory',
  '--memory-reservation',
  '--memory-swap',
  '--mount',
  '--name',
  '--network',
  '--network-alias',
  '--platform',
  '--publish',
  '--restart',
  '--shm-size',
  '--stop-signal',
  '--stop-timeout',
  '--tmpfs',
  '--ulimit',
  '--user',
  '--volume',
  '--volumes-from',
  '--workdir'
]);

const shortOptionsWithValues = new Set([
  'a',
  'c',
  'e',
  'h',
  'l',
  'm',
  'p',
  'u',
  'v',
  'w'
]);

export class DeployInputError extends Error {}
export class DeployExecutionError extends Error {}
export class DeployRuntimeUnavailableError extends Error {}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function commandDetail(error: unknown) {
  return error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
    ? error.stderr.trim()
    : error instanceof Error
      ? error.message
      : String(error);
}

function isDockerDaemonUnavailable(message: string) {
  return /Cannot connect to the Docker daemon/i.test(message);
}

function resolvedDeployInput(parsed: ParsedDeployInput, plan: {
  method: 'docker_run' | 'docker_compose' | 'static_site' | 'binary_service';
  hostPort: number | null;
  containerPort: number;
  appPayload: DockerRunPlan['appPayload'];
}) {
  return {
    ...parsed,
    method: plan.method,
    name: plan.appPayload.name,
    publicHost: plan.appPayload.publicHost,
    publicPath: plan.appPayload.publicPath,
    routeMode: plan.appPayload.routeMode,
    hostPort: plan.hostPort,
    containerPort: plan.containerPort,
    category: plan.appPayload.category,
    tags: plan.appPayload.tags,
    favorite: plan.appPayload.favorite,
    enabled: plan.appPayload.enabled
  };
}

function targetPort(targetUrl: string) {
  try {
    const url = new URL(targetUrl);

    if (url.port) {
      return Number(url.port);
    }

    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function targetUrlForPort(port: number) {
  return `http://127.0.0.1:${port}`;
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isDockerPermissionDenied(message: string) {
  return /permission denied/i.test(message) && /(docker\.sock|Docker daemon|unix:\/\/|connect)/i.test(message);
}

function isCredentialHelperUnavailable(message: string) {
  return /error getting credentials/i.test(message) && /docker-credential-.+?(not found|executable file not found)/i.test(message);
}

function pointsToColima(message: string) {
  return /\.colima|context:\s+colima|colima/i.test(message);
}

function isContainerNameConflict(message: string) {
  return /container name ".+?" is already in use/i.test(message);
}

function isDockerComposeUnavailable(message: string) {
  return (
    /unknown command: docker compose/i.test(message) ||
    /unknown shorthand flag: 'p' in -p/i.test(message) ||
    /Invalid Plugins:[\s\S]*compose/i.test(message) ||
    /docker-compose: executable file not found/i.test(message)
  );
}

async function commandExists(command: string) {
  try {
    await execFileAsync(command, ['--version'], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    return true;
  } catch {
    return false;
  }
}

async function legacyDockerComposeExists() {
  return commandExists('docker-compose');
}

async function commandOutput(command: string, args: string[], timeout = 10_000) {
  const { stdout } = await execFileAsync(command, args, {
    timeout,
    maxBuffer: 1024 * 1024
  });

  return stdout.trim();
}

async function resolveCommandPath(command: string) {
  if (command.includes('/') || command.includes('\\')) {
    return command;
  }

  try {
    return await commandOutput(process.platform === 'win32' ? 'where' : 'which', [command]);
  } catch {
    return command;
  }
}

async function currentGroupNames() {
  if (process.platform === 'win32') {
    return [];
  }

  try {
    return (await commandOutput('id', ['-Gn'])).split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

function dockerPermissionGrantSteps(message: string): DeployDoctorGrantStep[] {
  const username = os.userInfo().username || '$USER';
  const steps: DeployDoctorGrantStep[] = [];

  if (process.platform === 'linux') {
    steps.push({
      title: 'Allow this user to use Docker',
      description: 'Add the user that runs The Containers to the docker group, then restart the shell or service.',
      commands: [
        `sudo usermod -aG docker ${username}`,
        'newgrp docker',
        'sudo systemctl enable --now docker'
      ]
    });
    steps.push({
      title: 'If The Containers runs as a systemd service',
      description: 'Make sure the service process also joins the docker group, then restart the service.',
      commands: [
        'sudo systemctl edit the-containers',
        '[Service]',
        'SupplementaryGroups=docker',
        'sudo systemctl daemon-reload',
        'sudo systemctl restart the-containers'
      ]
    });
    return steps;
  }

  if (process.platform === 'darwin') {
    steps.push({
      title: 'Use Colima with the same user as The Containers',
      description: 'Start Colima and launch The Containers from a shell that points Docker at the Colima socket.',
      commands: [
        'colima start',
        'export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock',
        'export DOCKER_BIN=$(command -v docker)',
        'npm run dev'
      ]
    });
    steps.push({
      title: 'Use Docker Desktop',
      description: 'Open Docker Desktop once and allow its privileged helper, then restart The Containers.',
      commands: [
        'open -a Docker',
        'docker info',
        'npm run dev'
      ]
    });
    return steps;
  }

  if (process.platform === 'win32') {
    steps.push({
      title: 'Start Docker Desktop for Windows',
      description: 'The Containers needs Docker Desktop or another Docker daemon reachable from this Windows user.',
      commands: [
        'Start-Process "Docker Desktop"',
        'docker info'
      ]
    });
    steps.push({
      title: 'Point The Containers at Docker on Windows',
      description: 'If Docker is installed in a custom location, start The Containers with the full docker.exe path.',
      commands: [
        'where docker',
        '$env:DOCKER_BIN="C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"',
        'npm run dev'
      ]
    });
    return steps;
  }

  steps.push({
    title: 'Grant Docker access to the process running The Containers',
    description: 'Run The Containers as a user that can execute Docker and access the Docker daemon socket.',
    commands: [
      'docker info',
      'DOCKER_BIN=/full/path/to/docker npm run dev'
    ]
  });

  if (message) {
    steps.push({
      title: 'Current Docker error',
      description: message,
      commands: []
    });
  }

  return steps;
}

async function recoverColimaRuntime() {
  if (!(await commandExists('colima'))) {
    return false;
  }

  await execFileAsync('colima', ['start'], {
    timeout: 180_000,
    maxBuffer: 1024 * 1024
  }).catch(() => undefined);

  try {
    await execFileAsync(config.dockerBin, ['info'], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    return true;
  } catch {
    await execFileAsync('colima', ['restart'], {
      timeout: 240_000,
      maxBuffer: 1024 * 1024
    }).catch(() => undefined);
  }

  try {
    await execFileAsync(config.dockerBin, ['info'], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    return true;
  } catch {
    return false;
  }
}

async function dockerConfigWithoutCredentialHelpers() {
  const sourceDir =
    process.env.DOCKER_CONFIG ??
    (process.env.HOME ? path.join(process.env.HOME, '.docker') : null);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'the-containers-docker-'));
  let dockerConfig: Record<string, unknown> = {};

  if (sourceDir) {
    try {
      dockerConfig = JSON.parse(
        await fs.readFile(path.join(sourceDir, 'config.json'), 'utf8')
      ) as Record<string, unknown>;
    } catch {
      dockerConfig = {};
    }
  }

  delete dockerConfig.credsStore;
  delete dockerConfig.credHelpers;

  await fs.writeFile(
    path.join(tempDir, 'config.json'),
    `${JSON.stringify(dockerConfig, null, 2)}\n`,
    { mode: 0o600 }
  );

  return tempDir;
}

async function execDocker(args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  return execFileAsync(config.dockerBin, args, {
    timeout: options.timeout ?? 120_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      ...options.env
    }
  });
}

async function runDockerCommand(args: string[], options: { timeout?: number } = {}) {
  try {
    return await execDocker(args, options);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new DeployRuntimeUnavailableError(
        `Docker CLI was not found at "${config.dockerBin}". Install Docker or set DOCKER_BIN to the full docker binary path.`
      );
    }

    if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
      throw new DeployRuntimeUnavailableError(
        `Docker CLI at "${config.dockerBin}" is not executable by this process. Fix the binary permissions or set DOCKER_BIN to an executable Docker binary.`
      );
    }

    const detail = commandDetail(error);

    if (isCredentialHelperUnavailable(detail)) {
      let dockerConfig: string | null = null;

      try {
        dockerConfig = await dockerConfigWithoutCredentialHelpers();
        return await execDocker(args, {
          ...options,
          env: {
            DOCKER_CONFIG: dockerConfig
          }
        });
      } catch (retryError) {
        throw new DeployExecutionError(
          `${commandDetail(retryError) || detail} The Containers also tried a sanitized Docker config without the missing credential helper.`
        );
      } finally {
        if (dockerConfig) {
          await fs.rm(dockerConfig, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }

    if (isDockerPermissionDenied(detail)) {
      throw new DeployRuntimeUnavailableError(
        `${detail} The Containers cannot change Docker socket permissions safely. Start Docker with permissions for this user, or run The Containers as a user that can access Docker.`
      );
    }

    if (isDockerDaemonUnavailable(detail)) {
      const recovered = pointsToColima(detail) ? await recoverColimaRuntime() : false;

      if (recovered) {
        try {
          return await execDocker(args, options);
        } catch (retryError) {
          throw new DeployExecutionError(commandDetail(retryError) || 'Docker run failed.');
        }
      }

      const recoveryNote = pointsToColima(detail)
        ? ' The Containers tried to start or restart Colima automatically, but Docker is still unavailable.'
        : ' Start Docker, or point DOCKER_HOST/DOCKER_BIN at a running Docker runtime.';

      throw new DeployRuntimeUnavailableError(`${detail}${recoveryNote}`);
    }

    throw new DeployExecutionError(detail || 'Docker run failed.');
  }
}

async function runDockerComposeCommand(args: string[], options: { timeout?: number } = {}) {
  try {
    return await runDockerCommand(['compose', ...args], options);
  } catch (error) {
    const detail = commandDetail(error);

    if (!isDockerComposeUnavailable(detail)) {
      throw error;
    }

    if (await legacyDockerComposeExists()) {
      try {
        return await execFileAsync('docker-compose', args, {
          timeout: options.timeout ?? 240_000,
          maxBuffer: 1024 * 1024,
          env: process.env
        });
      } catch (legacyError) {
        throw new DeployExecutionError(commandDetail(legacyError) || 'Docker Compose failed.');
      }
    }

    throw new DeployRuntimeUnavailableError(
      'Docker Compose is not available. Install the Docker Compose plugin so "docker compose version" works, or install legacy docker-compose. If Docker Desktop was removed, also remove broken ~/.docker/cli-plugins/docker-compose symlinks.'
    );
  }
}

async function dockerComposeRuntimeStatus() {
  try {
    const { stdout } = await runDockerCommand(['compose', 'version'], { timeout: 30_000 });

    return {
      available: true,
      detail: stdout.trim() || 'docker compose is available'
    };
  } catch (error) {
    const detail = commandDetail(error);

    if (isDockerComposeUnavailable(detail) && await legacyDockerComposeExists()) {
      return {
        available: true,
        detail: 'Legacy docker-compose is available.'
      };
    }

    return {
      available: false,
      detail: isDockerComposeUnavailable(detail)
        ? 'Docker Compose plugin was not found or is broken, and legacy docker-compose was not found.'
        : detail
    };
  }
}

async function inspectContainer(containerName: string) {
  const { stdout } = await runDockerCommand(['inspect', containerName]);
  const parsed = JSON.parse(stdout) as DockerInspectContainer[];
  const container = parsed[0];

  if (!container) {
    throw new DeployExecutionError(`Docker container ${containerName} was not found.`);
  }

  return container;
}

// Walk Docker options only: command arguments after the image must remain literal.
function replacementCreateArgs(plan: DockerRunPlan, name: string, container: DockerInspectContainer | null) {
  const volumes = new Map((container?.Mounts ?? [])
    .filter((mount) => mount.Type === 'volume' && mount.Name && mount.Destination)
    .map((mount) => [mount.Destination!, mount]));
  const args = ['create', '--name', name];
  const options = plan.dockerArgs.slice(4); // run -d --name <name>
  for (let index = 0; index < options.length; index++) {
    const token = options[index];
    if (!token.startsWith('-')) {
      for (const [destination, mount] of volumes) {
        args.push('-v', `${mount.Name}:${destination}:${mount.RW === false ? 'ro' : 'rw'}`);
      }
      args.push(...options.slice(index));
      break;
    }
    const option = optionName(token);
    const inline = optionInlineValue(token);
    const takesValue = optionValueNames.has(option) ||
      (token.length === 2 && shortOptionsWithValues.has(token[1]));
    const value = inline ?? (takesValue ? options[++index] : undefined);
    if ((option === '-v' || option === '--volume') && value) {
      const parts = value.split(':');
      // Anonymous syntax is /destination[:options]; named and bind syntax has a source.
      const anonymous = parts.length === 1 || (parts.length === 2 && !parts[1].startsWith('/'));
      const destination = anonymous ? parts[0] : parts[1];
      const mount = volumes.get(destination);
      args.push(option, anonymous && mount ? `${mount.Name}:${value}` : value);
      volumes.delete(destination);
    } else if (option === '--mount' && value) {
      const fields = value.split(',');
      const destination = fields.find((field) => /^(target|dst|destination)=/.test(field))?.split('=')[1];
      const mount = destination ? volumes.get(destination) : undefined;
      const anonymous = !fields.some((field) => /^(source|src)=/.test(field)) &&
        !fields.some((field) => /^type=(?!volume$)/.test(field));
      args.push(option, anonymous && mount ? `${value},source=${mount.Name}` : value);
      if (destination) volumes.delete(destination);
    } else {
      args.push(token);
      if (inline === null && takesValue) args.push(value!);
    }
  }
  return args;
}

function firstPublishedPort(container: DockerInspectContainer, containerPort: number) {
  const ports = container.NetworkSettings?.Ports ?? {};
  const preferred = ports[`${containerPort}/tcp`]?.[0]?.HostPort;

  if (preferred) {
    return Number(preferred);
  }

  for (const bindings of Object.values(ports)) {
    const hostPort = bindings?.[0]?.HostPort;

    if (hostPort) {
      return Number(hostPort);
    }
  }

  return null;
}

function planWithExistingContainer(
  plan: DockerRunPlan,
  container: DockerInspectContainer
): DockerRunPlan {
  const hostPort = firstPublishedPort(container, plan.containerPort);

  if (!hostPort || !Number.isInteger(hostPort)) {
    throw new DeployExecutionError(
      `Existing container ${plan.containerName} does not publish a TCP port The Containers can route to.`
    );
  }

  const targetUrl = `http://127.0.0.1:${hostPort}`;

  return {
    ...plan,
    hostPort,
    targetUrl,
    appPayload: {
      ...plan.appPayload,
      targetUrl
    },
    warnings: [
      ...plan.warnings,
      `Adopted existing Docker container ${plan.containerName}.`
    ]
  };
}

function tokenizeShellCommand(command: string) {
  const normalizedCommand = command.replace(/\\[ \t]*\r?\n/g, ' ');
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of normalizedCommand) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (
      char === '\\' &&
      quote !== "'" &&
      !/^[A-Za-z]:/.test(current) &&
      !/[=,][A-Za-z]:/.test(current) &&
      !current.startsWith('\\') &&
      current !== ''
    ) {
      escaped = true;
      continue;
    }

    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }

    if (quote === char) {
      quote = null;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += '\\';
  }

  if (quote) {
    throw new DeployInputError('Command contains an unterminated quote.');
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function trimDockerPrefix(tokens: string[]) {
  const sudoIndex = tokens[0] === 'sudo' ? 1 : 0;

  if (tokens[sudoIndex] !== 'docker' || tokens[sudoIndex + 1] !== 'run') {
    throw new DeployInputError('Only docker run commands are supported in this deployer.');
  }

  return tokens.slice(sudoIndex + 2);
}

function parsePortSpec(raw: string): PublishedPort | null {
  const [withoutProtocol, protocol = 'tcp', extra] = raw.split('/');
  const ipv6 = withoutProtocol.match(/^\[([^\]]+)\]:(.*)$/);
  const segments = (ipv6 ? ipv6[2] : withoutProtocol).split(':');
  const hostIp = ipv6 ? ipv6[1] : segments.length === 3 ? segments.shift()! : null;
  const containerPart = segments.at(-1);

  if (
    extra !== undefined ||
    !['tcp', 'udp', 'sctp'].includes(protocol) ||
    segments.length > 2 ||
    (ipv6 && segments.length !== 2) ||
    (hostIp !== null && net.isIP(hostIp) === 0) ||
    !containerPart || !/^\d+$/.test(containerPart)
  ) {
    return null;
  }

  const containerPort = Number(containerPart);

  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    return null;
  }

  const hostPart = segments.length >= 2 ? segments.at(-2) : null;
  if (hostPart && !/^\d+$/.test(hostPart)) {
    return null;
  }
  const hostPort = hostPart ? Number(hostPart) : null;

  if (hostPort !== null && (hostPort < 1 || hostPort > 65535)) {
    return null;
  }

  return {
    hostIp,
    hostPort,
    containerPort,
    protocol
  };
}

function formatPublishedPort(port: PublishedPort) {
  const hostIp = port.hostIp?.includes(':') ? `[${port.hostIp}]` : port.hostIp;
  const host = hostIp ? `${hostIp}:${port.hostPort ?? ''}:` : port.hostPort !== null ? `${port.hostPort}:` : '';
  return `${host}${port.containerPort}/${port.protocol}`;
}

function publishedPortTargetUrl(hostIp: string | null | undefined, port: number) {
  const host = !hostIp || hostIp === '0.0.0.0' ? '127.0.0.1' : hostIp === '::' ? '::1' : hostIp;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function looksLikeHostPath(value: string) {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function expandHostPath(value: string, baseDir = process.cwd()) {
  const expanded = value === '~'
    ? os.homedir()
    : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2))
      : value;

  return path.resolve(baseDir, expanded);
}

function splitDockerVolumeSpec(value: string) {
  const windowsDriveSource = value.match(/^([A-Za-z]:[\\/][^:]*):(.+)$/);

  if (windowsDriveSource) {
    const rest = windowsDriveSource[2];

    return {
      source: windowsDriveSource[1],
      target: rest.match(/^[A-Za-z]:[\\/]/)
        ? rest.replace(/:ro$|:rw$|:z$|:Z$/, '')
        : rest.split(':')[0] ?? null
    };
  }

  const segments = value.split(':');

  if (segments.length < 2) {
    return null;
  }

  return {
    source: segments[0],
    target: segments[1] ?? null
  };
}

function parseVolumeMount(value: string): HostMount | null {
  const parsed = splitDockerVolumeSpec(value);

  if (!parsed) {
    return null;
  }

  const { source, target } = parsed;

  if (!source || !looksLikeHostPath(source)) {
    return null;
  }

  return {
    source,
    target
  };
}

function parseMountPairs(value: string) {
  const pairs = new Map<string, string>();

  for (const segment of value.split(',')) {
    const separator = segment.indexOf('=');

    if (separator === -1) {
      continue;
    }

    pairs.set(segment.slice(0, separator), segment.slice(separator + 1));
  }

  return pairs;
}

function parseBindMount(value: string): HostMount | null {
  const pairs = parseMountPairs(value);
  const type = pairs.get('type');
  const source = pairs.get('source') ?? pairs.get('src');
  const target = pairs.get('target') ?? pairs.get('destination') ?? pairs.get('dst') ?? null;

  if (!source || (type && type !== 'bind') || !looksLikeHostPath(source)) {
    return null;
  }

  return {
    source,
    target
  };
}

function hostMountFromOption(name: string, value: string) {
  if (name === '-v' || name === '--volume') {
    return parseVolumeMount(value);
  }

  if (name === '--mount') {
    return parseBindMount(value);
  }

  return null;
}

function likelyFileMount(mount: HostMount) {
  const sourceName = path.basename(mount.source);
  const targetName = mount.target ? path.posix.basename(mount.target) : '';

  return Boolean(path.extname(sourceName) || path.extname(targetName));
}

async function ensureHostMountsWritable(mounts: HostMount[]) {
  const uniqueSources = Array.from(new Map(mounts.map((mount) => [mount.source, mount])).values());

  for (const mount of uniqueSources) {
    const source = expandHostPath(mount.source, mount.baseDir);

    try {
      await fs.access(source, fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        if (likelyFileMount(mount)) {
          await fs.mkdir(path.dirname(source), { recursive: true });
          await fs.writeFile(source, '', { flag: 'wx', mode: 0o600 });
        } else {
          await fs.mkdir(source, { recursive: true, mode: 0o755 });
        }

        continue;
      }

      if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
        throw new DeployRuntimeUnavailableError(
          `Docker bind mount path "${source}" is not readable and writable by The Containers. Move the app data to a writable path or fix permissions before deploying.`
        );
      }

      throw error;
    }
  }
}

function shellQuote(value: string) {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isDockerSocketMount(mount: HostMount) {
  const source = expandHostPath(mount.source, mount.baseDir);

  return source === '/var/run/docker.sock' || source.endsWith('/docker.sock');
}

function isProtectedHostPath(source: string) {
  const resolved = expandHostPath(source);
  const protectedRoots = (() => {
    if (process.platform === 'win32') {
      const systemDrive = process.env.SystemDrive ?? 'C:';

      return [
        `${systemDrive}\\Windows`,
        `${systemDrive}\\Program Files`,
        `${systemDrive}\\Program Files (x86)`,
        `${systemDrive}\\ProgramData`
      ].map((root) => path.resolve(root).toLowerCase());
    }

    if (process.platform === 'darwin') {
      return ['/System', '/Library', '/private', '/usr', '/bin', '/sbin', '/etc', '/var'];
    }

    return ['/boot', '/dev', '/etc', '/proc', '/root', '/run', '/sys', '/usr', '/var'];
  })();

  if (process.platform === 'win32') {
    const normalized = resolved.toLowerCase();

    return protectedRoots.some((root) => normalized === root || normalized.startsWith(`${root}\\`));
  }

  return protectedRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
}

function createPathCommands(source: string) {
  const quotedSource = shellQuote(source);
  const username = os.userInfo().username;

  if (process.platform === 'win32') {
    return [
      `New-Item -ItemType Directory -Force -Path ${quotedSource}`,
      `icacls ${quotedSource} /grant "$env:USERNAME:(OI)(CI)M" /T`
    ];
  }

  return [
    `sudo mkdir -p ${quotedSource}`,
    `sudo chown -R ${shellQuote(username)} ${quotedSource}`
  ];
}

function fixPathPermissionCommands(source: string) {
  const quotedSource = shellQuote(source);
  const username = os.userInfo().username;

  if (process.platform === 'win32') {
    return [
      `icacls ${quotedSource} /grant "$env:USERNAME:(OI)(CI)M" /T`
    ];
  }

  return [
    `sudo chown -R ${shellQuote(username)} ${quotedSource}`,
    `chmod u+rwX ${quotedSource}`
  ];
}

function inspectDeviceCommand(device: string) {
  const source = device.split(':')[0] ?? device;

  if (process.platform === 'win32') {
    return `Get-Item ${shellQuote(source)}`;
  }

  return `ls -l ${shellQuote(source)}`;
}

async function mountRequirement(mount: HostMount): Promise<DeployPermissionRequirement> {
  const source = expandHostPath(mount.source, mount.baseDir);

  if (isDockerSocketMount(mount)) {
    return {
      id: `mount-docker-socket-${source}`,
      label: 'Docker socket mount',
      status: 'needs_user',
      userHelpRequired: true,
      detail: `${source} gives the container control over Docker on this host. User confirmation is required.`,
      commands: []
    };
  }

  try {
    await fs.access(source, fsConstants.R_OK | fsConstants.W_OK);

    return {
      id: `mount-ready-${source}`,
      label: `Bind mount ${mount.source}`,
      status: 'ready',
      userHelpRequired: false,
      detail: `${source} is readable and writable by The Containers.`,
      commands: []
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      if (!isProtectedHostPath(source)) {
        return {
          id: `mount-auto-${source}`,
          label: `Bind mount ${mount.source}`,
          status: 'auto',
          userHelpRequired: false,
          detail: `${source} does not exist yet. The Containers will create it before Docker starts.`,
          commands: []
        };
      }

      return {
        id: `mount-create-${source}`,
        label: `Bind mount ${mount.source}`,
        status: 'blocked',
        userHelpRequired: true,
        detail: `${source} is in a protected system location. Create it and grant ownership to the user running The Containers first.`,
        commands: createPathCommands(source)
      };
    }

    if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
      return {
        id: `mount-permission-${source}`,
        label: `Bind mount ${mount.source}`,
        status: 'blocked',
      userHelpRequired: true,
      detail: `${source} exists but The Containers cannot read and write it.`,
      commands: fixPathPermissionCommands(source)
    };
  }

    return {
      id: `mount-unknown-${source}`,
      label: `Bind mount ${mount.source}`,
      status: 'blocked',
      userHelpRequired: true,
      detail: commandDetail(error),
      commands: []
    };
  }
}

function staticSiteRootFromCommand(command: string) {
  const value = command.trim();

  if (!value) {
    throw new DeployInputError('Enter the built static site folder.');
  }

  const unquoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value;

  return expandHostPath(unquoted);
}

function staticSiteNameFromRoot(siteRoot: string) {
  const leaf = path.basename(siteRoot);
  const parent = path.basename(path.dirname(siteRoot));

  return ['build', 'dist', 'html', 'out', 'public', 'site', 'www'].includes(leaf.toLowerCase())
    ? parent || leaf || 'Static site'
    : leaf || 'Static site';
}

async function resolveStaticSiteRoot(command: string) {
  const root = staticSiteRootFromCommand(command);

  try {
    const stat = await fs.stat(root);

    if (!stat.isDirectory()) {
      throw new DeployInputError(`Static site path must be a directory: ${root}`);
    }

    await fs.access(root, fsConstants.R_OK);
    return root;
  } catch (error) {
    if (error instanceof DeployInputError) {
      throw error;
    }

    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new DeployInputError(`Static site folder was not found: ${root}`);
    }

    if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
      throw new DeployRuntimeUnavailableError(
        `Static site folder "${root}" is not readable by The Containers.`
      );
    }

    throw error;
  }
}

async function staticSiteRequirement(command: string): Promise<DeployPermissionRequirement> {
  const root = staticSiteRootFromCommand(command);

  try {
    const stat = await fs.stat(root);

    if (!stat.isDirectory()) {
      return {
        id: `static-site-not-directory-${root}`,
        label: 'Static site folder',
        status: 'blocked',
        userHelpRequired: true,
        detail: `${root} exists, but it is not a directory.`,
        commands: [`ls -la ${shellQuote(root)}`]
      };
    }

    await fs.access(root, fsConstants.R_OK);

    return {
      id: `static-site-ready-${root}`,
      label: 'Static site folder',
      status: 'ready',
      userHelpRequired: false,
      detail: `${root} is readable and will be mounted read-only into nginx.`,
      commands: []
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        id: `static-site-missing-${root}`,
        label: 'Static site folder',
        status: 'blocked',
        userHelpRequired: true,
        detail: `${root} does not exist. Build the site first, then point Static site deployment at the output folder.`,
        commands: [`ls -la ${shellQuote(path.dirname(root))}`]
      };
    }

    if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
      return {
        id: `static-site-permission-${root}`,
        label: 'Static site folder',
        status: 'blocked',
        userHelpRequired: true,
        detail: `${root} exists but The Containers cannot read it.`,
        commands: fixPathPermissionCommands(root)
      };
    }

    return {
      id: `static-site-unknown-${root}`,
      label: 'Static site folder',
      status: 'blocked',
      userHelpRequired: true,
      detail: commandDetail(error),
      commands: []
    };
  }
}

async function portRequirement(port: number | null): Promise<DeployPermissionRequirement> {
  if (!port) {
    return {
      id: 'port-auto',
      label: 'Host port',
      status: 'auto',
      userHelpRequired: false,
      detail: 'No host port was requested. The Containers will assign a free port automatically.',
      commands: []
    };
  }

  if (needsPrivilegedPortRemap(port)) {
    return {
      id: `port-privileged-${port}`,
      label: `Host port ${port}`,
      status: 'auto',
      userHelpRequired: false,
      detail: `Port ${port} normally needs elevated system privileges. The Containers will route through an automatically assigned high port instead.`,
      commands: []
    };
  }

  if (!(await checkPortAvailable(port))) {
    return {
      id: `port-used-${port}`,
      label: `Host port ${port}`,
      status: 'auto',
      userHelpRequired: false,
      detail: `Port ${port} is already in use. The Containers will assign another free port automatically.`,
      commands: []
    };
  }

  return {
    id: `port-ready-${port}`,
    label: `Host port ${port}`,
    status: 'ready',
    userHelpRequired: false,
    detail: `Port ${port} is available.`,
    commands: []
  };
}

async function binaryServicePortRequirement(port: number | null): Promise<DeployPermissionRequirement> {
  if (!port) {
    return {
      id: 'service-port',
      label: 'Service port',
      status: 'blocked',
      userHelpRequired: true,
      detail: 'Enter the local port where this service exposes its web UI before deploying.',
      commands: []
    };
  }

  if (needsPrivilegedPortRemap(port)) {
    return {
      id: `service-port-privileged-${port}`,
      label: `Service port ${port}`,
      status: 'blocked',
      userHelpRequired: true,
      detail: `Port ${port} requires elevated privileges. Configure the service to listen on an unprivileged local port and route through the reverse proxy.`,
      commands: []
    };
  }

  if (!(await checkPortAvailable(port))) {
    return {
      id: `service-port-used-${port}`,
      label: `Service port ${port}`,
      status: 'blocked',
      userHelpRequired: true,
      detail: `Port ${port} is already in use. Binary/service cannot auto-remap it because the service command controls which port it listens on.`,
      commands: []
    };
  }

  return {
    id: `service-port-ready-${port}`,
    label: `Service port ${port}`,
    status: 'ready',
    userHelpRequired: false,
    detail: `Port ${port} is available.`,
    commands: []
  };
}

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address);
}

function normalizeHost(value: string) {
  return value.toLowerCase().replace(/\.$/, '');
}

async function resolveHostAddresses(host: string) {
  const addresses = new Set<string>();

  await Promise.all([
    dns.resolve4(host).then((items) => items.forEach((item) => addresses.add(item))).catch(() => undefined),
    dns.resolve6(host).then((items) => items.forEach((item) => addresses.add(item))).catch(() => undefined)
  ]);

  return [...addresses];
}

async function publicDomainRequirements(
  input: z.infer<typeof deployDoctorInputSchema>
): Promise<DeployPermissionRequirement[]> {
  if (input.publishMode !== 'public_domain_reverse_proxy') {
    return [];
  }

  const host = normalizeHost(input.publicHost ?? '');

  if (!host) {
    return [
      {
        id: 'public-domain-missing',
        label: 'Public domain',
        status: 'blocked',
        userHelpRequired: true,
        detail: 'Enter a public domain before deploying with public domain binding.',
        commands: []
      }
    ];
  }

  const addresses = await resolveHostAddresses(host);
  const local = localAddresses();
  const matchesLocal = addresses.some((address) => local.includes(address));

  return [
    {
      id: 'public-domain-dns',
      label: `DNS for ${host}`,
      status: addresses.length > 0 ? (matchesLocal ? 'ready' : 'needs_user') : 'needs_user',
      userHelpRequired: addresses.length === 0 || !matchesLocal,
      detail:
        addresses.length === 0
          ? `${host} does not resolve yet. Add an A/AAAA or CNAME record that points to this host before external clients can reach it.`
          : matchesLocal
            ? `${host} resolves to this machine: ${addresses.join(', ')}.`
            : `${host} resolves to ${addresses.join(', ')}, which does not match this machine's visible local addresses (${local.join(', ') || 'none'}).`,
      commands: [
        `dig +short ${host}`,
        `nslookup ${host}`
      ]
    },
    {
      id: 'reverse-proxy-sync',
      label: 'Reverse proxy sync',
      status: config.caddySyncEnabled ? 'ready' : 'needs_user',
      userHelpRequired: !config.caddySyncEnabled,
      detail: config.caddySyncEnabled
        ? 'Caddy sync is enabled, so The Containers will bind this domain in the reverse proxy config.'
        : 'Caddy sync is disabled. The app will be saved, but the public domain will not be applied to Caddy automatically.',
      commands: config.caddySyncEnabled
        ? []
        : [
            'CADDY_SYNC_ENABLED=true npm run dev',
            'npm run dev'
          ]
    },
    {
      id: 'public-ports',
      label: 'Public HTTP/HTTPS ports',
      status: 'needs_user',
      userHelpRequired: true,
      detail: 'Your router/firewall must forward public traffic to Caddy on this machine. Use port 80 for HTTP and port 443 when Caddy HTTPS is enabled.',
      commands: []
    }
  ];
}

async function commandPermissionRequirements(input: unknown) {
  const parsedInput = deployDoctorInputSchema.parse(input ?? {});
  const command = parsedInput.command?.trim();
  const requirements: DeployPermissionRequirement[] = [
    ...(await publicDomainRequirements(parsedInput))
  ];

  if (!command) {
    return requirements;
  }

  try {
    if (parsedInput.method === 'docker_compose') {
      if (!looksLikeComposeYaml(command)) {
        requirements.push({
          id: 'compose-input',
          label: 'Compose file',
          status: 'blocked',
          userHelpRequired: true,
          detail: 'Paste docker-compose.yml or compose.yml content.',
          commands: []
        });
        return requirements;
      }

      const service = selectComposeService(command);
      const selectedPublishedPort = service.port;
      const hostNetwork = service.hostNetwork;
      const image = service.image;
      const serviceName = service.name;
      const containerName =
        slugify(service.containerName ?? serviceName ?? nameFromImage(image)) ||
        'compose-app';
      const projectDir = path.join(config.deploymentsPath, containerName);
      const containerPort =
        parsedInput.containerPort ??
        selectedPublishedPort?.containerPort ??
        inferComposeContainerPort(command, image, serviceName);
      const requestedHostPort =
        hostNetwork
          ? parsedInput.hostPort ?? selectedPublishedPort?.hostPort ?? containerPort
          : parsedInput.hostPort ?? selectedPublishedPort?.hostPort ?? null;

      requirements.push(await portRequirement(requestedHostPort));

      const uniqueMounts = Array.from(
        new Map(composeHostMounts(command, projectDir).map((mount) => [mount.source, mount])).values()
      );
      const mountRequirements = await Promise.all(uniqueMounts.map(mountRequirement));
      requirements.push(...mountRequirements);
      requirements.push({
        id: 'compose-project',
        label: 'Compose project',
        status: 'auto',
        userHelpRequired: false,
        detail: 'The Containers will create a managed Compose project directory and run docker compose up -d.',
        commands: []
      });
      if (composeUsesHostNetwork(command)) {
        requirements.push({
          id: 'compose-host-network',
          label: 'Host network',
          status: 'needs_user',
          userHelpRequired: true,
          detail: 'This Compose file uses network_mode: host. The Containers will not inject ports; it will route to the inferred host port directly.',
          commands: []
        });
      }
      requirements.push(...composeSecurityRequirements(command));
      return requirements;
    }

    if (parsedInput.method === 'binary_service') {
      const parsedCommand = parseBinaryServiceCommand(command);
      const systemctlService = parseSystemctlServiceCommand(command);
      const webPort = parsedInput.hostPort ?? parsedInput.containerPort ?? null;

      if (!webPort) {
        requirements.push({
          id: 'service-port',
          label: 'Service port',
          status: 'blocked',
          userHelpRequired: true,
          detail: 'Enter the local port where this service exposes its web UI before deploying.',
          commands: []
        });
        return requirements;
      }

      const serviceKind = binaryServiceKind();
      const executableName = path.basename(parsedCommand.executable).replace(/\.[^.]+$/, '');
      const baseName = parsedInput.name ?? (systemctlService?.serviceName.replace(/\.service$/i, '') || executableName);
      const serviceName = systemctlService?.serviceName ?? binaryServiceName(slugify(baseName) || slugify(executableName) || 'binary-service');

      if (!systemctlService) {
        requirements.push(await binaryServicePortRequirement(webPort));
      }
      requirements.push({
        id: 'binary-service-command',
        label: 'Service command',
        status: 'auto',
        userHelpRequired: false,
        detail: systemctlService
          ? `The Containers will run ${systemctlService.usesSudo ? 'sudo ' : ''}systemctl ${systemctlService.action} ${systemctlService.serviceName} and route to port ${webPort}.`
          : `The Containers will install ${parsedCommand.executable} ${parsedCommand.args.join(' ')} as a binary service and route to port ${webPort}.`,
        commands: []
      });
      requirements.push({
        id: 'service-manager',
        label: 'Service manager',
        status: systemctlService ? 'needs_user' : serviceKind === 'process' ? 'needs_user' : 'auto',
        userHelpRequired: Boolean(systemctlService) || serviceKind === 'process',
        detail: systemctlService
          ? `This uses an existing system service. Make sure ${systemctlService.usesSudo ? 'sudo -n systemctl' : 'systemctl'} ${systemctlService.action} ${serviceName} can run without an interactive password prompt, or keep the service already running on port ${webPort}.`
          : serviceKind === 'systemd_user'
          ? `The Containers will install and enable user systemd service ${serviceName}.service using ${systemdUserContext().busAddress}.`
          : serviceKind === 'launchd_user'
            ? `The Containers will install and bootstrap launchd agent ${serviceName}.`
            : 'This platform is not supported for service installation; The Containers can only start the process directly.',
        commands: systemctlService
          ? [
              `${systemctlService.usesSudo ? 'sudo ' : ''}systemctl status ${serviceName}`,
              `${systemctlService.usesSudo ? 'sudo -n ' : ''}systemctl ${systemctlService.action} ${serviceName}`
            ]
          : serviceKind === 'systemd_user'
          ? [
              ...systemdUserGrantCommands(),
              `XDG_RUNTIME_DIR=${systemdUserContext().runtimeDir} DBUS_SESSION_BUS_ADDRESS=${systemdUserContext().busAddress} systemctl --user status ${serviceName}.service`
            ]
          : serviceKind === 'launchd_user'
            ? ['launchctl print gui/$(id -u)']
            : []
      });
      return requirements;
    }

    if (parsedInput.method === 'static_site') {
      const containerPort = parsedInput.containerPort ?? 80;
      const requestedHostPort = parsedInput.hostPort ?? null;

      requirements.push(await portRequirement(requestedHostPort));
      requirements.push(await staticSiteRequirement(command));
      requirements.push({
        id: 'static-site-container',
        label: 'Static web server',
        status: 'auto',
        userHelpRequired: false,
        detail: `The Containers will run nginx and serve the selected folder on container port ${containerPort}.`,
        commands: []
      });
      return requirements;
    }

    if (parsedInput.method !== 'docker_run') {
      requirements.push({
        id: 'deploy-method',
        label: 'Deploy method',
        status: 'blocked',
        userHelpRequired: true,
        detail: `${parsedInput.method} deployment is not available yet.`,
        commands: []
      });
      return requirements;
    }

    const dockerRun = parseDockerRun(trimDockerPrefix(tokenizeShellCommand(command)));
    const selectedPublishedPort =
      dockerRun.ports.find((port) => port.protocol === 'tcp') ?? dockerRun.ports[0];
    const requestedHostPort =
      dockerRun.hostNetwork
        ? parsedInput.hostPort ??
          selectedPublishedPort?.hostPort ??
          parsedInput.containerPort ??
          selectedPublishedPort?.containerPort ??
          null
        : parsedInput.hostPort ?? selectedPublishedPort?.hostPort ?? null;

    requirements.push(await portRequirement(requestedHostPort));

    const uniqueMounts = Array.from(
      new Map(dockerRun.hostMounts.map((mount) => [mount.source, mount])).values()
    );
    const mountRequirements = await Promise.all(uniqueMounts.map(mountRequirement));
    requirements.push(...mountRequirements);

    if (dockerRun.privileged) {
      requirements.push({
        id: 'privileged',
        label: 'Privileged container',
        status: 'needs_user',
        userHelpRequired: true,
        detail: '--privileged gives the container broad host access. Review this image before deploying.',
        commands: []
      });
    }

    if (dockerRun.hostNetwork) {
      requirements.push({
        id: 'host-network',
        label: 'Host network',
        status: 'needs_user',
        userHelpRequired: true,
        detail: '--network host shares the host network namespace. The container can bind host ports directly.',
        commands: []
      });
    }

    if (dockerRun.hostPid || dockerRun.hostIpc) {
      requirements.push({
        id: 'host-namespace',
        label: 'Host namespace',
        status: 'needs_user',
        userHelpRequired: true,
        detail: 'This command shares a host PID or IPC namespace. Review the image and host exposure before deploying.',
        commands: []
      });
    }

    if (dockerRun.devices.length > 0) {
      requirements.push({
        id: 'devices',
        label: 'Host devices',
        status: 'needs_user',
      userHelpRequired: true,
      detail: `This command passes host devices to the container: ${dockerRun.devices.join(', ')}`,
      commands: dockerRun.devices.map(inspectDeviceCommand)
    });
  }

    if (dockerRun.capabilities.length > 0) {
      requirements.push({
        id: 'capabilities',
        label: 'Linux capabilities',
        status: 'needs_user',
        userHelpRequired: true,
        detail: `This command adds capabilities: ${dockerRun.capabilities.join(', ')}`,
        commands: []
      });
    }
  } catch (error) {
    requirements.push({
      id: 'command-parse',
      label: 'Command requirements',
      status: 'blocked',
      userHelpRequired: true,
      detail: error instanceof Error ? error.message : String(error),
      commands: []
    });
  }

  return requirements;
}

function optionName(token: string) {
  return token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
}

function optionInlineValue(token: string) {
  return token.includes('=') ? token.slice(token.indexOf('=') + 1) : null;
}

function expandShortOptionGroup(token: string) {
  if (!/^-[A-Za-z]{2,}$/.test(token)) {
    return [token];
  }

  const flags = token.slice(1).split('');
  const firstValueFlag = flags.findIndex((flag) => shortOptionsWithValues.has(flag));

  if (firstValueFlag === -1) {
    return flags.map((flag) => `-${flag}`);
  }

  if (firstValueFlag === flags.length - 1) {
    return [
      ...flags.slice(0, firstValueFlag).map((flag) => `-${flag}`),
      `-${flags[firstValueFlag]}`
    ];
  }

  return [token];
}

function normalizeDockerRunTokens(tokens: string[]) {
  return tokens.flatMap(expandShortOptionGroup);
}

function parseDockerRun(tokens: string[]) {
  tokens = normalizeDockerRunTokens(tokens);
  let containerName: string | null = null;
  const ports: PublishedPort[] = [];
  const hostMounts: HostMount[] = [];
  const devices: string[] = [];
  const capabilities: string[] = [];
  const cleanedArgs: string[] = [];
  let image: string | null = null;
  const warnings: string[] = [];
  let privileged = false;
  let hostNetwork = false;
  let hostPid = false;
  let hostIpc = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!image && token.startsWith('-')) {
      const name = optionName(token);
      const inlineValue = optionInlineValue(token);

      if (name === '-d' || name === '--detach') {
        continue;
      }

      if (name === '--rm') {
        warnings.push('Removed --rm so the deployed container keeps running after restart.');
        continue;
      }

      if (name === '--privileged') {
        privileged = true;
        cleanedArgs.push(token);
        continue;
      }

      if (name === '-p' || name === '--publish') {
        const value = inlineValue ?? tokens[index + 1];

        if (!value) {
          throw new DeployInputError(`${name} requires a port mapping value.`);
        }

        const parsed = parsePortSpec(value);

        if (!parsed) {
          throw new DeployInputError(`Unsupported Docker port mapping: ${value}`);
        }

        ports.push(parsed);

        if (!inlineValue) {
          index += 1;
        }
        continue;
      }

      if (token.startsWith('-p') && token.length > 2) {
        const value = token.slice(2);
        const parsed = parsePortSpec(value);

        if (!parsed) {
          throw new DeployInputError(`Unsupported Docker port mapping: ${value}`);
        }

        ports.push(parsed);
        continue;
      }

      if (name === '--network' || name === '--net') {
        const value = inlineValue ?? tokens[index + 1];

        if (!value) {
          throw new DeployInputError(`${name} requires a value.`);
        }

        if (value === 'host') {
          hostNetwork = true;
        }

        cleanedArgs.push(token);

        if (inlineValue) {
          continue;
        }

        cleanedArgs.push(value);
        index += 1;
        continue;
      }

      if (name === '--pid' || name === '--ipc') {
        const value = inlineValue ?? tokens[index + 1];

        if (!value) {
          throw new DeployInputError(`${name} requires a value.`);
        }

        if (name === '--pid' && value === 'host') {
          hostPid = true;
        }

        if (name === '--ipc' && value === 'host') {
          hostIpc = true;
        }

        cleanedArgs.push(token);

        if (inlineValue) {
          continue;
        }

        cleanedArgs.push(value);
        index += 1;
        continue;
      }

      if (name === '--device' || name === '--cap-add') {
        const value = inlineValue ?? tokens[index + 1];

        if (!value) {
          throw new DeployInputError(`${name} requires a value.`);
        }

        if (name === '--device') {
          devices.push(value);
        } else {
          capabilities.push(value);
        }

        cleanedArgs.push(token);

        if (inlineValue) {
          continue;
        }

        cleanedArgs.push(value);
        index += 1;
        continue;
      }

      if (name === '--name') {
        const value = inlineValue ?? tokens[index + 1];

        if (!value) {
          throw new DeployInputError('--name requires a value.');
        }

        containerName = value;

        if (!inlineValue) {
          index += 1;
        }
        continue;
      }

      if (name === '-v' || name === '--volume' || name === '--mount') {
        const value = inlineValue ?? tokens[index + 1];

        if (!value) {
          throw new DeployInputError(`${name} requires a value.`);
        }

        const hostMount = hostMountFromOption(name, value);

        if (hostMount) {
          hostMounts.push(hostMount);
        }

        cleanedArgs.push(token);

        if (inlineValue) {
          continue;
        }

        cleanedArgs.push(value);
        index += 1;
        continue;
      }

      if (token.startsWith('-v') && token.length > 2) {
        const value = token.slice(2);
        const hostMount = hostMountFromOption('-v', value);

        if (hostMount) {
          hostMounts.push(hostMount);
        }

        cleanedArgs.push('-v', value);
        continue;
      }

      cleanedArgs.push(token);

      if (inlineValue) {
        continue;
      }

      if (optionValueNames.has(name)) {
        if (!tokens[index + 1]) {
          throw new DeployInputError(`${name} requires a value.`);
        }
        cleanedArgs.push(tokens[index + 1]);
        index += 1;
        continue;
      }

      if (
        token.startsWith('-') &&
        !token.startsWith('--') &&
        token.length === 2 &&
        shortOptionsWithValues.has(token[1])
      ) {
        if (!tokens[index + 1]) {
          throw new DeployInputError(`${token} requires a value.`);
        }
        cleanedArgs.push(tokens[index + 1]);
        index += 1;
      }

      continue;
    }

    if (!image) {
      image = token;
    }

    cleanedArgs.push(token);
  }

  if (!image) {
    throw new DeployInputError('Could not find the Docker image in this command.');
  }

  return {
    containerName,
    ports,
    hostMounts,
    devices,
    capabilities,
    privileged,
    hostNetwork,
    hostPid,
    hostIpc,
    cleanedArgs,
    image,
    warnings
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function nameFromImage(image: string) {
  const withoutDigest = image.split('@')[0];
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  const withoutTag =
    lastColon > lastSlash
      ? withoutDigest.slice(0, lastColon)
      : withoutDigest;

  return withoutTag.split('/').at(-1) || 'self-hosted-app';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseComposeConfig(compose: string): ComposeConfig {
  let parsed: unknown;

  try {
    parsed = parseYaml(compose);
  } catch (error) {
    throw new DeployInputError(`Compose YAML could not be parsed: ${commandDetail(error)}`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.services)) {
    throw new DeployInputError('Compose file must contain a services: map.');
  }

  const services = Object.entries(parsed.services)
    .filter((entry): entry is [string, JsonRecord] => isRecord(entry[1]));

  if (services.length === 0) {
    throw new DeployInputError('Compose file must contain at least one service.');
  }

  return {
    config: parsed,
    services
  };
}

function tryParseComposeConfig(compose: string) {
  try {
    return parseComposeConfig(compose);
  } catch {
    return null;
  }
}

function looksLikeComposeYaml(value: string) {
  return /(^|\n)\s*services\s*:/i.test(value);
}

function composeServiceImage(service: JsonRecord) {
  const image = service.image;

  return typeof image === 'string' && image.trim() ? image.trim() : 'Docker Compose';
}

function composeServiceContainerName(service: JsonRecord) {
  const containerName = service.container_name;

  return typeof containerName === 'string' && containerName.trim()
    ? containerName.trim()
    : null;
}

function composeServiceUsesHostNetwork(service: JsonRecord) {
  return service.network_mode === 'host' || service.network === 'host';
}

function composeUsesHostNetwork(compose: string) {
  return selectComposeService(compose).hostNetwork;
}

function parsePortNumber(value: unknown) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 1 && value <= 65535 ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^(\d+)(?:\/tcp)?$/);

  if (!match) {
    return null;
  }

  const port = Number(match[1]);

  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function composePortFromObject(value: JsonRecord): PublishedPort | null {
  const containerPort = parsePortNumber(value.target);
  const hostPort = parsePortNumber(value.published);
  const protocol = typeof value.protocol === 'string' ? value.protocol : 'tcp';

  if (!containerPort) {
    return null;
  }

  return {
    hostIp: typeof value.host_ip === 'string' ? value.host_ip : null,
    hostPort,
    containerPort,
    protocol
  };
}

function composePortFromValue(value: unknown): PublishedPort | null {
  if (typeof value === 'string') {
    return parsePortSpec(value);
  }

  if (typeof value === 'number') {
    const containerPort = parsePortNumber(value);

    return containerPort
      ? {
          hostIp: null,
          hostPort: null,
          containerPort,
          protocol: 'tcp'
        }
      : null;
  }

  return isRecord(value) ? composePortFromObject(value) : null;
}

function firstComposePortIndex(ports: unknown[]) {
  const parsed = ports.map(composePortFromValue);
  const tcpIndex = parsed.findIndex((port) => port?.protocol === 'tcp');
  return tcpIndex >= 0 ? tcpIndex : parsed.findIndex((port) => port !== null);
}

function firstComposePortForService(service: JsonRecord): PublishedPort | null {
  const ports = service.ports;

  if (!Array.isArray(ports)) {
    return null;
  }

  return composePortFromValue(ports[firstComposePortIndex(ports)]);
}

function firstComposeExposePortForService(service: JsonRecord) {
  const expose = service.expose;
  const values = Array.isArray(expose) ? expose : [expose];

  for (const value of values) {
    const port = parsePortNumber(value);

    if (port) {
      return port;
    }
  }

  return null;
}

function firstComposeExposePort(compose: string) {
  return selectComposeService(compose).exposePort;
}

function isDatabaseLikeService(text: string) {
  return /postgres|postgis|mysql|mariadb|redis|valkey|mongo|clickhouse|meili|qdrant|elastic|opensearch|rabbitmq|nats/i.test(text);
}

function isWebLikeService(text: string) {
  return /web|app|api|server|frontend|backend|ui|admin|dashboard|http|nginx|caddy|apache|httpd|traefik|whoami|grafana|prometheus|upsnap|uptime-kuma|homeassistant|home-assistant|jellyfin|plex|portainer/i.test(text);
}

function isLikelyWebPort(port: number | null | undefined) {
  return Boolean(
    port &&
      (port === 80 ||
        port === 443 ||
        port === 3000 ||
        port === 3001 ||
        port === 5000 ||
        port === 5173 ||
        (port >= 8000 && port <= 8999) ||
        port === 9000)
  );
}

function composeServiceScore(selection: ComposeServiceSelection, index: number) {
  const text = `${selection.name} ${selection.image} ${selection.containerName ?? ''}`;
  const databaseLike = isDatabaseLikeService(text);
  const webLike = isWebLikeService(text);

  return (
    (databaseLike ? -100 : 0) +
    (webLike ? 90 : 0) +
    (isLikelyWebPort(selection.port?.containerPort) ? 70 : 0) +
    (isLikelyWebPort(selection.exposePort) ? 50 : 0) +
    (selection.port ? 30 : 0) +
    (selection.exposePort ? 15 : 0) -
    index
  );
}

function selectComposeServiceFromConfig(parsed: ComposeConfig): ComposeServiceSelection {
  const selections = parsed.services.map(([name, service]) => ({
    name,
    service,
    image: composeServiceImage(service),
    containerName: composeServiceContainerName(service),
    port: firstComposePortForService(service),
    exposePort: firstComposeExposePortForService(service),
    hostNetwork: composeServiceUsesHostNetwork(service)
  }));

  const ranked = selections
    .map((selection, index) => ({
      selection,
      score: composeServiceScore(selection, index)
    }))
    .sort((left, right) => right.score - left.score);

  const selection = ranked[0]?.selection ?? selections[0];

  if (!selection) {
    throw new DeployInputError('Compose file must contain at least one service.');
  }

  return selection;
}

function selectComposeService(compose: string) {
  return selectComposeServiceFromConfig(parseComposeConfig(compose));
}

function inferKnownContainerPort(image: string, name: string | null) {
  const text = `${image} ${name ?? ''}`.toLowerCase();
  const knownPorts: Array<[RegExp, number]> = [
    [/postgres|postgis/, 5432],
    [/mysql|mariadb/, 3306],
    [/redis|valkey/, 6379],
    [/mongo/, 27017],
    [/clickhouse/, 8123],
    [/grafana/, 3000],
    [/prometheus/, 9090],
    [/upsnap/, 8090],
    [/uptime-kuma/, 3001],
    [/homeassistant|home-assistant/, 8123],
    [/jellyfin/, 8096],
    [/plex/, 32400],
    [/portainer/, 9000],
    [/traefik|nginx|caddy|apache|httpd|whoami|web|app/, 80]
  ];

  return knownPorts.find(([pattern]) => pattern.test(text))?.[1] ?? 80;
}

function inferComposeContainerPort(compose: string, image: string, serviceName: string | null) {
  const explicit = firstComposeExposePort(compose);

  if (explicit) {
    return explicit;
  }

  return inferKnownContainerPort(image, serviceName);
}

function composeHostMounts(compose: string, baseDir?: string) {
  const mounts: HostMount[] = [];
  const config = tryParseComposeConfig(compose);

  if (!config) {
    return mounts;
  }

  for (const [, service] of config.services) {
    const volumes = service.volumes;

    if (!Array.isArray(volumes)) {
      continue;
    }

    for (const volume of volumes) {
      const mount =
        typeof volume === 'string'
          ? parseVolumeMount(volume)
          : isRecord(volume) &&
              (!volume.type || volume.type === 'bind') &&
              typeof volume.source === 'string' &&
              looksLikeHostPath(volume.source)
            ? {
                source: volume.source,
                target: typeof volume.target === 'string' ? volume.target : null
              }
            : null;

      if (mount) {
        mounts.push({
          ...mount,
          baseDir
        });
      }
    }
  }

  return mounts;
}

function composeStringList(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        return String(item);
      }

      if (isRecord(item)) {
        const source = item.source ?? item.path ?? item.host_path;
        const target = item.target ?? item.container_path;

        return [source, target].filter((part) => typeof part === 'string').join(':');
      }

      return '';
    })
    .filter(Boolean);
}

function composeSecurityRequirements(compose: string): DeployPermissionRequirement[] {
  const parsed = tryParseComposeConfig(compose);

  if (!parsed) {
    return [];
  }

  const privilegedServices: string[] = [];
  const hostNamespaceServices: string[] = [];
  const capabilities: string[] = [];
  const devices: string[] = [];

  for (const [name, service] of parsed.services) {
    if (service.privileged === true) {
      privilegedServices.push(name);
    }

    if (service.pid === 'host' || service.ipc === 'host') {
      hostNamespaceServices.push(name);
    }

    for (const capability of composeStringList(service.cap_add)) {
      capabilities.push(`${name}:${capability}`);
    }

    for (const device of composeStringList(service.devices)) {
      devices.push(`${name}:${device}`);
    }
  }

  return [
    ...(privilegedServices.length
      ? [
          {
            id: 'compose-privileged',
            label: 'Privileged Compose service',
            status: 'needs_user' as const,
            userHelpRequired: true,
            detail: `These services run privileged: ${privilegedServices.join(', ')}. Review the images before deploying.`,
            commands: []
          }
        ]
      : []),
    ...(hostNamespaceServices.length
      ? [
          {
            id: 'compose-host-namespace',
            label: 'Host namespace',
            status: 'needs_user' as const,
            userHelpRequired: true,
            detail: `These services share host PID or IPC namespaces: ${hostNamespaceServices.join(', ')}.`,
            commands: []
          }
        ]
      : []),
    ...(capabilities.length
      ? [
          {
            id: 'compose-capabilities',
            label: 'Linux capabilities',
            status: 'needs_user' as const,
            userHelpRequired: true,
            detail: `Compose adds capabilities: ${capabilities.join(', ')}`,
            commands: []
          }
        ]
      : []),
    ...(devices.length
      ? [
          {
            id: 'compose-devices',
            label: 'Host devices',
            status: 'needs_user' as const,
            userHelpRequired: true,
            detail: `Compose passes host devices: ${devices.join(', ')}`,
            commands: devices.map((device) => inspectDeviceCommand(device.split(':').slice(1).join(':') || device))
          }
        ]
      : [])
  ];
}

function injectComposePort(compose: string, hostPort: number, containerPort: number) {
  if (composeUsesHostNetwork(compose)) {
    return compose;
  }

  const parsed = parseComposeConfig(compose);
  const service = selectComposeServiceFromConfig(parsed).service;

  if (!service) {
    return compose;
  }

  if (Array.isArray(service.ports)) {
    const index = firstComposePortIndex(service.ports);

    if (index >= 0) {
      const original = service.ports[index];
      const port = composePortFromValue(original)!;
      service.ports[index] = isRecord(original)
        ? { ...original, published: String(hostPort), target: containerPort }
        : formatPublishedPort({ ...port, hostPort, containerPort });
    } else {
      service.ports.unshift(`127.0.0.1:${hostPort}:${containerPort}/tcp`);
    }
  } else {
    service.ports = [`127.0.0.1:${hostPort}:${containerPort}/tcp`];
  }

  return stringifyYaml(parsed.config);
}

async function writeComposeFile(projectName: string, compose: string) {
  const projectDir = path.join(config.deploymentsPath, projectName);
  const composeFilePath = path.join(projectDir, 'compose.yml');

  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(composeFilePath, compose, { mode: 0o600 });

  return {
    projectDir,
    composeFilePath
  };
}

async function removeComposeProjectContainers(projectName: string) {
  const { stdout } = await runDockerCommand([
    'ps',
    '-aq',
    '--filter',
    `label=com.docker.compose.project=${projectName}`
  ]);
  const containerIds = stdout.split('\n').map((line) => line.trim()).filter(Boolean);

  if (containerIds.length === 0) {
    return;
  }

  await runDockerCommand(['rm', '-fv', ...containerIds]);
}

async function listComposeProjectContainers(projectName: string) {
  const { stdout } = await runDockerCommand([
    'ps',
    '-a',
    '--filter',
    `label=com.docker.compose.project=${projectName}`,
    '--format',
    '{{json .}}'
  ]);

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as {
          ID?: string;
          Names?: string;
          State?: string;
          Status?: string;
          Image?: string;
          Ports?: string;
        };

        return [{
          id: parsed.ID ?? '',
          name: parsed.Names ?? '',
          state: parsed.State ?? 'unknown',
          status: parsed.Status ?? 'unknown',
          image: parsed.Image ?? '',
          ports: parsed.Ports ?? ''
        }];
      } catch {
        return [];
      }
    });
}

function checkPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

async function allocatePort(preferredPort: number | null, reservedPorts: number[] = []) {
  if (preferredPort) {
    if (await checkPortAvailable(preferredPort)) {
      return preferredPort;
    }

    throw new DeployInputError(`Port ${preferredPort} is already in use.`);
  }

  for (let port = 18080; port <= 19000; port += 1) {
    if (!reservedPorts.includes(port) && await checkPortAvailable(port)) {
      return port;
    }
  }

  throw new DeployInputError('No free port was found in the 18080-19000 range.');
}

function needsPrivilegedPortRemap(port: number) {
  return (
    port < 1024 &&
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    process.getuid() !== 0
  );
}

async function resolveHostPort(requestedHostPort: number | null, warnings: string[], reservedPorts: number[] = []) {
  if (!requestedHostPort) {
    return allocatePort(null, reservedPorts);
  }

  if (needsPrivilegedPortRemap(requestedHostPort)) {
    const allocated = await allocatePort(null, reservedPorts);
    warnings.push(
      `Host port ${requestedHostPort} needs elevated system privileges, so The Containers assigned ${allocated} instead.`
    );
    return allocated;
  }

  if (await checkPortAvailable(requestedHostPort)) {
    return requestedHostPort;
  }

  const allocated = await allocatePort(null, reservedPorts);
  warnings.push(
    `Host port ${requestedHostPort} is already in use, so The Containers assigned ${allocated} instead.`
  );
  return allocated;
}

function parseBinaryServiceCommand(command: string) {
  const tokens = tokenizeShellCommand(command);
  const sudoIndex = tokens[0] === 'sudo' ? 1 : 0;
  const executable = tokens[sudoIndex];

  if (!executable) {
    throw new DeployInputError('Enter the command that starts this service.');
  }

  const args = tokens.slice(sudoIndex + 1);

  return {
    executable,
    args,
    serviceArgs: args
  };
}

function parseSystemctlServiceCommand(command: string) {
  const tokens = tokenizeShellCommand(command);
  const sudoIndex = tokens[0] === 'sudo' ? 1 : 0;
  const executable = tokens[sudoIndex];

  if (!executable || path.basename(executable) !== 'systemctl') {
    return null;
  }

  const args = tokens.slice(sudoIndex + 1);

  if (args.includes('--user')) {
    return null;
  }

  const actionIndex = args.findIndex((arg) => ['start', 'restart'].includes(arg));
  const action = args[actionIndex] as 'start' | 'restart' | undefined;
  const serviceName = action ? args[actionIndex + 1] : undefined;

  if (!action || !serviceName || serviceName.startsWith('-')) {
    return null;
  }

  return {
    action,
    serviceName,
    usesSudo: sudoIndex === 1
  };
}

function binaryServiceName(resourceName = 'binary-service') {
  return `the-containers-${slugify(resourceName) || 'binary-service'}`;
}

function systemdUserServicePath(serviceName: string) {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${serviceName}.service`);
}

function launchdPlistPath(serviceName: string) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${serviceName}.plist`);
}

function binaryServiceKind(): DockerRunPlan['serviceKind'] {
  if (process.platform === 'linux') {
    return 'systemd_user';
  }

  if (process.platform === 'darwin') {
    return 'launchd_user';
  }

  return 'process';
}

function systemdUserContext() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo().uid;
  const username = os.userInfo().username || String(uid);
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${path.join(runtimeDir, 'bus')}`;

  return {
    uid,
    username,
    runtimeDir,
    busAddress,
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: busAddress
    }
  };
}

function systemdUserGrantCommands() {
  const context = systemdUserContext();

  return [
    `sudo loginctl enable-linger ${context.username}`,
    `sudo systemctl start user@${context.uid}.service`,
    `XDG_RUNTIME_DIR=${context.runtimeDir} DBUS_SESSION_BUS_ADDRESS=${context.busAddress} systemctl --user status`
  ];
}

function isSystemdUserBusError(detail: string) {
  return /DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|Failed to connect to user scope bus|No medium found|No such file or directory/i.test(detail);
}

function systemdUserUnavailableError(error: unknown) {
  const detail = commandDetail(error);
  const context = systemdUserContext();

  return new DeployRuntimeUnavailableError(
    isSystemdUserBusError(detail)
      ? `${detail} User systemd is not available for ${context.username}. Enable linger and start user@${context.uid}.service, then retry.`
      : detail
  );
}

async function runSystemctlUser(args: string[], options: { timeout?: number } = {}) {
  try {
    return await execFileAsync('systemctl', ['--user', ...args], {
      env: systemdUserContext().env,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    throw systemdUserUnavailableError(error);
  }
}

async function systemctlUserOutput(args: string[], options: { timeout?: number } = {}) {
  const { stdout } = await runSystemctlUser(args, options);
  return stdout.trim();
}

async function runSystemctlSystem(
  args: string[],
  options: { timeout?: number; sudo?: boolean } = {}
) {
  const command = options.sudo ? 'sudo' : 'systemctl';
  const commandArgs = options.sudo ? ['-n', 'systemctl', ...args] : args;

  return execFileAsync(command, commandArgs, {
    timeout: options.timeout ?? 30_000,
    maxBuffer: 1024 * 1024
  });
}

async function systemctlSystemOutput(
  args: string[],
  options: { timeout?: number; sudo?: boolean } = {}
) {
  const { stdout } = await runSystemctlSystem(args, options);
  return stdout.trim();
}

function isSudoAuthenticationError(error: unknown) {
  return /sudo:.*(terminal is required|password is required|a password is required|no tty present)|a terminal is required to authenticate/i.test(commandDetail(error));
}

function systemctlSudoUnavailableError(error: unknown, serviceName: string, action: string) {
  const username = os.userInfo().username || 'the-containers';

  return new DeployRuntimeUnavailableError(
    `${commandDetail(error)} The Containers cannot answer sudo password prompts because the API runs without an interactive terminal. ` +
      `Either keep ${serviceName} already running on its service port, remove sudo if this process can run systemctl directly, or grant passwordless sudo for this service, for example: ` +
      `${username} ALL=(root) NOPASSWD: /bin/systemctl ${action} ${serviceName}, /bin/systemctl start ${serviceName}, /bin/systemctl stop ${serviceName}, /bin/systemctl status ${serviceName}`
  );
}

function binaryProcessName(resourceName: string, deployInput?: unknown) {
  if (deployInput && typeof deployInput === 'object' && 'processCommand' in deployInput) {
    const processCommand = (deployInput as { processCommand?: unknown }).processCommand;

    if (typeof processCommand === 'string' && processCommand.trim()) {
      return processCommand;
    }
  }

  return resourceName;
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdServiceContent(plan: DockerRunPlan) {
  const command = plan.processCommand ?? plan.containerName;
  const args = plan.serviceArgs ?? [];
  const execStart = [command, ...args].map(shellQuote).join(' ');

  return `[Unit]
Description=The Containers managed service ${plan.appPayload.name}
After=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function launchdServiceContent(plan: DockerRunPlan) {
  const command = plan.processCommand ?? plan.containerName;
  const args = plan.serviceArgs ?? [];
  const serviceName = plan.serviceName ?? binaryServiceName(plan.containerName);
  const logDir = path.join(config.deploymentsPath, plan.containerName, 'logs');
  const stdoutPath = path.join(logDir, 'stdout.log');
  const stderrPath = path.join(logDir, 'stderr.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(serviceName)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(command)}</string>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

function binaryProcessPattern(resourceName = 'binary-service') {
  return resourceName.replace(/[\\[\]().*+?^${}|]/g, '\\$&');
}

async function findBinaryServicePids(resourceName = 'binary-service') {
  if (process.platform === 'win32') {
    return [];
  }

  try {
    const output = await commandOutput('pgrep', ['-f', binaryProcessPattern(resourceName)]);
    return output
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

async function waitForPort(port: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await canConnectToLocalPort(port)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

function canConnectToLocalPort(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });

    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function ensureBinaryServicePortListening(plan: DockerRunPlan, timeoutMs = 15_000) {
  const port = plan.hostPort ?? plan.containerPort;

  if (await waitForPort(port, timeoutMs)) {
    return;
  }

  throw new DeployExecutionError(
    `Binary/service started, but nothing is listening on ${targetUrlForPort(port)}. ` +
      'Set the service command or service configuration to use this exact web port, or change the Binary/service port to the port it actually listens on.'
  );
}

async function startBinaryServiceProcess(plan: DockerRunPlan) {
  const command = plan.processCommand ?? plan.containerName;
  const args = plan.processArgs ?? [];
  const existingPids = await findBinaryServicePids(command);

  if (existingPids.length > 0) {
    return existingPids.join(',');
  }

  await execFileAsync(command, args, {
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  await ensureBinaryServicePortListening(plan);
  return (await findBinaryServicePids(plan.containerName)).join(',') || command;
}

async function stopBinaryServiceProcess(resourceName = 'binary-service') {
  const pids = await findBinaryServicePids(resourceName);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The process may have exited between pgrep and kill.
    }
  }

  return pids;
}

async function installAndStartBinaryService(plan: DockerRunPlan) {
  if (plan.serviceKind === 'systemd_system' && plan.serviceName) {
    const action = plan.systemctlAction ?? 'restart';
    try {
      await runSystemctlSystem([action, plan.serviceName], {
        sudo: plan.systemctlUsesSudo,
        timeout: 60_000
      });
    } catch (error) {
      if (plan.systemctlUsesSudo && isSudoAuthenticationError(error)) {
        if (await waitForPort(plan.hostPort ?? plan.containerPort, 1_500)) {
          return `systemd:${plan.serviceName}`;
        }
        throw systemctlSudoUnavailableError(error, plan.serviceName, action);
      }
      throw error;
    }
    await ensureBinaryServicePortListening(plan, 60_000);
    return `systemd:${plan.serviceName}`;
  }

  if (plan.serviceKind === 'systemd_user' && plan.serviceName && plan.serviceFilePath) {
    await fs.mkdir(path.dirname(plan.serviceFilePath), { recursive: true });
    await fs.writeFile(plan.serviceFilePath, systemdServiceContent(plan), 'utf8');
    await runSystemctlUser(['daemon-reload'], { timeout: 15_000 });
    await runSystemctlUser(['enable', '--now', `${plan.serviceName}.service`], { timeout: 30_000 });
    await ensureBinaryServicePortListening(plan);
    return plan.serviceFilePath;
  }

  if (plan.serviceKind === 'launchd_user' && plan.serviceName && plan.serviceFilePath) {
    await fs.mkdir(path.dirname(plan.serviceFilePath), { recursive: true });
    await fs.mkdir(path.join(config.deploymentsPath, plan.containerName, 'logs'), { recursive: true });
    await fs.writeFile(plan.serviceFilePath, launchdServiceContent(plan), 'utf8');
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    await execFileAsync('launchctl', ['bootout', `${domain}/${plan.serviceName}`], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    }).catch(() => undefined);
    await execFileAsync('launchctl', ['bootstrap', domain, plan.serviceFilePath], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    await ensureBinaryServicePortListening(plan);
    return plan.serviceFilePath;
  }

  return startBinaryServiceProcess(plan);
}

async function binaryServiceStatus(resourceName: string, deployInput?: unknown) {
  const serviceName =
    deployInput && typeof deployInput === 'object' && 'serviceName' in deployInput
      ? String((deployInput as { serviceName?: unknown }).serviceName ?? binaryServiceName(resourceName))
      : binaryServiceName(resourceName);
  const serviceKind =
    deployInput && typeof deployInput === 'object' && 'serviceKind' in deployInput
      ? (deployInput as { serviceKind?: DockerRunPlan['serviceKind'] }).serviceKind
      : binaryServiceKind();
  if (serviceKind === 'systemd_system') {
    try {
      const active = await systemctlSystemOutput(['is-active', serviceName]);
      const enabled = await systemctlSystemOutput(['is-enabled', serviceName]).catch(() => 'disabled');

      return {
        running: active === 'active',
        state: `${active}${enabled ? `, ${enabled}` : ''}`,
        serviceName,
        serviceKind,
        pids: await findBinaryServicePids(binaryProcessName(resourceName, deployInput))
      };
    } catch {
      return {
        running: false,
        state: 'inactive',
        serviceName,
        serviceKind,
        pids: await findBinaryServicePids(binaryProcessName(resourceName, deployInput))
      };
    }
  }

  if (serviceKind === 'systemd_user') {
    try {
      const active = await systemctlUserOutput(['is-active', `${serviceName}.service`]);
      const enabled = await systemctlUserOutput(['is-enabled', `${serviceName}.service`]).catch(() => 'disabled');

      return {
        running: active === 'active',
        state: `${active}${enabled ? `, ${enabled}` : ''}`,
        serviceName,
        serviceKind,
        pids: await findBinaryServicePids(binaryProcessName(resourceName, deployInput))
      };
    } catch {
      return {
        running: false,
        state: 'inactive',
        serviceName,
        serviceKind,
        pids: await findBinaryServicePids(binaryProcessName(resourceName, deployInput))
      };
    }
  }

  if (serviceKind === 'launchd_user') {
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    const running = await execFileAsync('launchctl', ['print', `${domain}/${serviceName}`], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    }).then(() => true).catch(() => false);

    return {
      running,
      state: running ? 'loaded' : 'unloaded',
      serviceName,
      serviceKind,
      pids: await findBinaryServicePids(binaryProcessName(resourceName, deployInput))
    };
  }

  const pids = await findBinaryServicePids(binaryProcessName(resourceName, deployInput));

  return {
    running: pids.length > 0,
    state: pids.length > 0 ? 'running' : 'stopped',
    serviceName,
    serviceKind: 'process' as const,
    pids
  };
}

async function controlBinaryService(
  action: 'start' | 'stop' | 'restart',
  resourceName: string,
  deployInput?: unknown
) {
  const plan = deployInput ? await buildBinaryServicePlanFromInput(deployInput) : null;
  const serviceName = plan?.serviceName ?? binaryServiceName(resourceName);
  const serviceKind = plan?.serviceKind ?? binaryServiceKind();

  if (serviceKind === 'systemd_system') {
    if (!plan?.serviceName) {
      throw new DeployInputError('This system service is missing service metadata.');
    }
    try {
      await runSystemctlSystem([action, plan.serviceName], {
        sudo: plan.systemctlUsesSudo,
        timeout: 60_000
      });
    } catch (error) {
      if (plan.systemctlUsesSudo && isSudoAuthenticationError(error)) {
        throw systemctlSudoUnavailableError(error, plan.serviceName, action);
      }
      throw error;
    }
    if (action !== 'stop') {
      await ensureBinaryServicePortListening(plan, 60_000);
    }
    return;
  }

  if (serviceKind === 'systemd_user') {
    await runSystemctlUser([action, `${serviceName}.service`], { timeout: 30_000 });
    if (plan && action !== 'stop') {
      await ensureBinaryServicePortListening(plan);
    }
    return;
  }

  if (serviceKind === 'launchd_user') {
    const serviceFilePath = plan?.serviceFilePath ?? launchdPlistPath(serviceName);
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;

    if (action === 'restart') {
      await execFileAsync('launchctl', ['kickstart', '-k', `${domain}/${serviceName}`], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      });
      if (plan) {
        await ensureBinaryServicePortListening(plan);
      }
      return;
    }

    if (action === 'stop') {
      await execFileAsync('launchctl', ['bootout', `${domain}/${serviceName}`], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      }).catch(() => undefined);
    }

    if (action === 'start') {
      await execFileAsync('launchctl', ['bootstrap', domain, serviceFilePath], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      });
      if (plan) {
        await ensureBinaryServicePortListening(plan);
      }
    }
    return;
  }

  if (action === 'stop' || action === 'restart') {
    await stopBinaryServiceProcess(binaryProcessName(resourceName, deployInput));
  }

  if (action === 'start' || action === 'restart') {
    if (!plan) {
      throw new DeployInputError('This binary service is missing start metadata.');
    }
    await startBinaryServiceProcess(plan);
  }
}

async function removeBinaryService(resourceName: string, deployInput?: unknown) {
  const plan = deployInput ? await buildBinaryServicePlanFromInput(deployInput) : null;
  const serviceName = plan?.serviceName ?? binaryServiceName(resourceName);
  const serviceKind = plan?.serviceKind ?? binaryServiceKind();
  const serviceFilePath = plan?.serviceFilePath ??
    (serviceKind === 'systemd_user' ? systemdUserServicePath(serviceName) : launchdPlistPath(serviceName));

  if (serviceKind === 'systemd_system') {
    return;
  }

  if (serviceKind === 'systemd_user') {
    await runSystemctlUser(['disable', '--now', `${serviceName}.service`], { timeout: 30_000 })
      .catch(() => undefined);
    await fs.rm(serviceFilePath, { force: true }).catch(() => undefined);
    await runSystemctlUser(['daemon-reload'], { timeout: 15_000 }).catch(() => undefined);
    return;
  }

  if (serviceKind === 'launchd_user') {
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    await execFileAsync('launchctl', ['bootout', `${domain}/${serviceName}`], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    }).catch(() => undefined);
    await fs.rm(serviceFilePath, { force: true }).catch(() => undefined);
    return;
  }

  await stopBinaryServiceProcess(binaryProcessName(resourceName, deployInput));
}

async function binaryServiceLogs(resourceName: string, deployInput?: unknown, tail = 200) {
  const plan = deployInput ? await buildBinaryServicePlanFromInput(deployInput) : null;
  const serviceName = plan?.serviceName ?? binaryServiceName(resourceName);
  const serviceKind = plan?.serviceKind ?? binaryServiceKind();

  if (serviceKind === 'systemd_system') {
    const result = await execFileAsync('journalctl', [
      '-u',
      serviceName,
      '-n',
      String(tail),
      '--no-pager'
    ], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    });
    return [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd();
  }

  if (serviceKind === 'systemd_user') {
    const result = await execFileAsync('journalctl', [
      '--user',
      '-u',
      `${serviceName}.service`,
      '-n',
      String(tail),
      '--no-pager'
    ], {
      env: systemdUserContext().env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    });
    return [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd();
  }

  if (serviceKind === 'launchd_user') {
    const logDir = path.join(config.deploymentsPath, resourceName, 'logs');
    const result = await execFileAsync('tail', ['-n', String(tail), path.join(logDir, 'stdout.log'), path.join(logDir, 'stderr.log')], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    }).catch(() => null);
    return result ? [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd() : 'No launchd logs returned yet.';
  }

  return 'This binary service is running as a direct process. Install it through systemd or launchd for managed logs.';
}

async function buildBinaryServicePlanFromInput(
  input: unknown,
  checkPort = false
): Promise<DockerRunPlan> {
  const parsed = deployInputSchema.parse(input);

  if (parsed.method !== 'binary_service') {
    throw new DeployInputError('Only Binary/service deployments can be managed as local services.');
  }

  const command = parsed.command;
  const binary = parseBinaryServiceCommand(command);
  const systemctlService = parseSystemctlServiceCommand(command);
  const executablePath = await resolveCommandPath(binary.executable);
  const webPort = parsed.hostPort ?? parsed.containerPort ?? null;

  if (!webPort) {
    throw new DeployInputError('Enter the local port where this service exposes its web UI before deploying.');
  }

  if (checkPort && !systemctlService) {
    const portCheck = await binaryServicePortRequirement(webPort);

    if (portCheck.status === 'blocked') {
      throw new DeployInputError(portCheck.detail);
    }
  }

  const executableName = path.basename(binary.executable).replace(/\.[^.]+$/, '');
  const baseName = parsed.name ?? (systemctlService?.serviceName.replace(/\.service$/i, '') || executableName);
  const containerName = slugify(baseName) || slugify(executableName) || 'binary-service';
  const serviceName = systemctlService?.serviceName ?? binaryServiceName(containerName);
  const serviceKind = systemctlService ? 'systemd_system' as const : binaryServiceKind();
  const serviceFilePath =
    serviceKind === 'systemd_user'
      ? systemdUserServicePath(serviceName)
      : serviceKind === 'launchd_user'
        ? launchdPlistPath(serviceName)
        : undefined;
  const routeMode = parsed.routeMode;
  const publicPath =
    routeMode === 'subpath'
      ? parsed.publicPath ?? `/${slugify(containerName) || 'app'}`
      : null;
  const targetUrl = targetUrlForPort(webPort);
  const appPayload = {
    name: baseName,
    iconType: 'builtin' as const,
    iconValue: null,
    targetUrl,
    routeMode,
    publicHost: parsed.publicHost,
    publicPath,
    enabled: parsed.enabled,
    sortOrder: 0,
    category: parsed.category ?? 'Self-hosted',
    tags: parsed.tags,
    favorite: parsed.favorite
  };

  return {
    method: 'binary_service',
    containerName,
    image: executableName,
    publishMode: parsed.publishMode,
    hostPort: webPort,
    containerPort: webPort,
    protocol: 'tcp',
    targetUrl,
    hostMounts: [],
    appPayload,
    dockerArgs: [executablePath, ...binary.args],
    processCommand: executablePath,
    processArgs: binary.args,
    serviceArgs: binary.serviceArgs,
    serviceName,
    serviceFilePath,
    serviceKind,
    systemctlAction: systemctlService?.action,
    systemctlUsesSudo: systemctlService?.usesSudo,
    resolvedDeployInput: {
      ...resolvedDeployInput(parsed, {
        method: 'binary_service',
        hostPort: webPort,
        containerPort: webPort,
        appPayload
      }),
      serviceName,
      serviceKind,
      serviceFilePath,
      processCommand: executablePath,
      processArgs: binary.args,
      serviceArgs: binary.serviceArgs,
      systemctlAction: systemctlService?.action,
      systemctlUsesSudo: systemctlService?.usesSudo
    },
    warnings: [
      serviceKind === 'systemd_system'
        ? `The Containers will run ${systemctlService?.usesSudo ? 'sudo ' : ''}systemctl ${systemctlService?.action ?? 'restart'} ${serviceName} and manage the public route for the existing system service.`
        : serviceKind === 'systemd_user'
        ? `The Containers will install and start a user systemd service at ${serviceFilePath}.`
        : serviceKind === 'launchd_user'
          ? `The Containers will install and start a launchd agent at ${serviceFilePath}.`
          : 'This platform does not expose systemd user services or launchd, so The Containers will fall back to direct process management.',
      serviceKind === 'systemd_system'
        ? 'If sudo cannot run without a password prompt, deployment can still adopt the service when the configured port is already listening. Deleting this managed deployment only removes The Containers route metadata; it does not uninstall or disable the existing system service.'
        : 'The service command should stay in the foreground so the service manager can track and restart it.',
      `The service must actually listen on ${targetUrl}. Binary/service does not rewrite the service's own port configuration.`,
      ...(parsed.publishMode === 'public_domain_reverse_proxy'
        ? [
            'Public domain mode requires DNS to point to this machine and Caddy to receive public traffic.'
          ]
        : [
            'Reverse proxy mode will bind the host in Caddy; DNS must resolve to this machine for clients to reach it.'
          ])
    ]
  };
}

export class DeployService {
  private readonly repo: DeploymentsRepo;

  constructor(
    db: ContainersDatabase,
    private readonly appsService: AppsService
  ) {
    this.repo = new DeploymentsRepo(db);
  }

  options() {
    return {
      methods: [
        {
          id: 'docker_run',
          name: 'Docker run',
          status: 'available',
          capabilities: [
            'paste-command',
            'auto-port',
            'reverse-proxy',
            'public-host',
            'public-domain'
          ]
        },
        {
          id: 'docker_compose',
          name: 'Docker Compose',
          status: 'available',
          capabilities: [
            'compose-yaml',
            'compose-file',
            'project-name',
            'managed-down',
            'reverse-proxy'
          ]
        },
        {
          id: 'github_auto',
          name: 'GitHub auto-detect',
          status: 'planned',
          capabilities: [
            'git-clone',
            'detect-compose',
            'detect-package-json',
            'detect-static-site',
            'detect-python',
            'detect-dockerfile'
          ]
        },
        {
          id: 'static_site',
          name: 'Static site build',
          status: 'available',
          capabilities: [
            'existing-dist-folder',
            'read-only-mount',
            'static-serve',
            'reverse-proxy'
          ]
        },
        {
          id: 'node_app',
          name: 'Node app',
          status: 'planned',
          capabilities: [
            'npm',
            'pnpm',
            'yarn',
            'bun',
            'process-manager',
            'reverse-proxy'
          ]
        },
        {
          id: 'python_app',
          name: 'Python app',
          status: 'planned',
          capabilities: [
            'requirements',
            'pyproject',
            'uv',
            'pip',
            'process-manager',
            'reverse-proxy'
          ]
        },
        {
          id: 'binary_service',
          name: 'Binary or system service',
          status: 'available',
          capabilities: [
            'local-binary',
            'daemon',
            'manual-port',
            'reverse-proxy'
          ]
        },
        {
          id: 'custom_command',
          name: 'Advanced custom command',
          status: 'planned',
          capabilities: [
            'user-provided-install',
            'user-provided-start',
            'manual-port',
            'reverse-proxy'
          ]
        },
        {
          id: 'existing_service',
          name: 'Existing local service',
          status: 'available-through-local-scan'
        }
      ]
    };
  }

  async doctor(input?: unknown) {
    const checks: DeployDoctorCheck[] = [];
    const grantSteps: DeployDoctorGrantStep[] = [];
    const parsedDoctorInput = deployDoctorInputSchema.safeParse(input ?? {});
    const doctorMethod = parsedDoctorInput.success ? parsedDoctorInput.data.method : 'docker_run';
    const requirements = await commandPermissionRequirements(input);
    const groups = await currentGroupNames();
    const dockerBin = config.dockerBin;

    checks.push({
      id: 'process-user',
      label: 'The Containers user',
      status: 'pass',
      detail: `${os.userInfo().username || 'unknown'} on ${process.platform}`
    });

    if (doctorMethod === 'binary_service') {
      const command = parsedDoctorInput.success
        ? parsedDoctorInput.data.command?.trim() || ''
        : '';

      if (!command) {
        checks.push({
          id: 'binary-command',
          label: 'Binary service command',
          status: 'fail',
          detail: 'Enter the command that starts this service.'
        });

        return {
          ok: false,
          dockerBin,
          dockerHost: process.env.DOCKER_HOST ?? null,
          dockerConfig: process.env.DOCKER_CONFIG ?? null,
          platform: process.platform,
          checks,
          requirements,
          userHelpRequired: true,
          grantSteps
        };
      }

      const parsedCommand = parseBinaryServiceCommand(command);
      const executablePath = await resolveCommandPath(parsedCommand.executable);

      try {
        await fs.access(executablePath, fsConstants.X_OK);
        checks.push({
          id: 'binary-command',
          label: 'Binary service command',
          status: 'pass',
          detail: executablePath
        });
      } catch (error) {
        checks.push({
          id: 'binary-command',
          label: 'Binary service command',
          status: 'fail',
          detail: commandDetail(error)
        });
        grantSteps.push({
          title: 'Install the service binary',
          description: 'Install the binary or provide a full executable path in the Binary/service command.',
          commands: process.platform === 'darwin'
            ? [`which ${path.basename(parsedCommand.executable)}`]
            : process.platform === 'linux'
              ? [`which ${path.basename(parsedCommand.executable)}`]
              : ['Install the service binary and provide its full path.']
        });
      }

      const serviceKind = binaryServiceKind();

      if (serviceKind === 'systemd_user') {
        try {
          const version = await commandOutput('systemctl', ['--version']);
          await runSystemctlUser(['show-environment'], { timeout: 15_000 });
          const context = systemdUserContext();
          checks.push({
            id: 'service-manager',
            label: 'User systemd',
            status: 'pass',
            detail: `${version.split('\n')[0] ?? 'systemctl is available'}; user bus ${context.busAddress}`
          });
        } catch (error) {
          checks.push({
            id: 'service-manager',
            label: 'User systemd',
            status: 'fail',
            detail: commandDetail(error)
          });
          grantSteps.push({
            title: 'Enable user systemd',
            description: 'Binary/service deployments install a user service so the process survives restarts.',
            commands: systemdUserGrantCommands()
          });
        }
      } else if (serviceKind === 'launchd_user') {
        try {
          await commandOutput('launchctl', ['help']);
          checks.push({
            id: 'service-manager',
            label: 'launchd',
            status: 'pass',
            detail: 'launchctl is available'
          });
        } catch (error) {
          checks.push({
            id: 'service-manager',
            label: 'launchd',
            status: 'fail',
            detail: commandDetail(error)
          });
        }
      } else {
        checks.push({
          id: 'service-manager',
          label: 'Service manager',
          status: 'warn',
          detail: 'No supported service manager was found for this platform; deploy will fall back to direct process management.'
        });
      }

      const commandBlocked = requirements.some((requirement) => requirement.status === 'blocked');
      const userHelpRequired =
        checks.some((check) => check.status === 'fail') ||
        requirements.some((requirement) => requirement.userHelpRequired);

      return {
        ok: checks.every((check) => check.status !== 'fail') && !commandBlocked,
        dockerBin,
        dockerHost: process.env.DOCKER_HOST ?? null,
        dockerConfig: process.env.DOCKER_CONFIG ?? null,
        platform: process.platform,
        checks,
        requirements,
        userHelpRequired,
        grantSteps
      };
    }

    if (doctorMethod === 'static_site') {
      const command = parsedDoctorInput.success
        ? parsedDoctorInput.data.command?.trim() || ''
        : '';

      if (!command) {
        checks.push({
          id: 'static-site-folder',
          label: 'Static site folder',
          status: 'fail',
          detail: 'Enter the built static site folder before checking deploy readiness.'
        });

        return {
          ok: false,
          dockerBin,
          dockerHost: process.env.DOCKER_HOST ?? null,
          dockerConfig: process.env.DOCKER_CONFIG ?? null,
          platform: process.platform,
          checks,
          requirements,
          userHelpRequired: true,
          grantSteps
        };
      }
    }

    checks.push({
      id: 'docker-bin-config',
      label: 'Docker binary setting',
      status: dockerBin ? 'pass' : 'fail',
      detail: dockerBin || 'DOCKER_BIN is empty'
    });

    try {
      const version = await commandOutput(dockerBin, ['--version']);
      checks.push({
        id: 'docker-cli',
        label: 'Docker CLI',
        status: 'pass',
        detail: version
      });
    } catch (error) {
      const detail =
        isNodeError(error) && error.code === 'ENOENT'
          ? `Docker CLI was not found at "${dockerBin}".`
          : commandDetail(error);

      checks.push({
        id: 'docker-cli',
        label: 'Docker CLI',
        status: 'fail',
        detail
      });
      grantSteps.push({
        title: 'Point The Containers at Docker',
        description: 'Install Docker or start The Containers with the full Docker binary path.',
        commands: [
          'which docker',
          'DOCKER_BIN=/full/path/to/docker npm run dev'
        ]
      });

      return {
        ok: false,
        dockerBin,
        dockerHost: process.env.DOCKER_HOST ?? null,
        dockerConfig: process.env.DOCKER_CONFIG ?? null,
        platform: process.platform,
        checks,
        requirements,
        userHelpRequired: true,
        grantSteps
      };
    }

    if (process.platform === 'linux') {
      checks.push({
        id: 'docker-group',
        label: 'Docker group',
        status: groups.includes('docker') ? 'pass' : 'warn',
        detail: groups.includes('docker')
          ? 'The process user running The Containers is in the docker group.'
          : 'The process user running The Containers is not in the docker group. Docker may still work through rootless Docker or DOCKER_HOST.'
      });
    }

    try {
      const info = await runDockerCommand(['info', '--format', '{{json .ServerVersion}}'], {
        timeout: 45_000
      });
      checks.push({
        id: 'docker-daemon',
        label: 'Docker daemon',
        status: 'pass',
        detail: `Docker server ${info.stdout.trim().replace(/^"|"$/g, '') || 'is reachable'}`
      });
    } catch (error) {
      const detail = commandDetail(error);

      checks.push({
        id: 'docker-daemon',
        label: 'Docker daemon',
        status: error instanceof DeployRuntimeUnavailableError ? 'fail' : 'warn',
        detail
      });
      grantSteps.push(...dockerPermissionGrantSteps(detail));
    }

    if (doctorMethod === 'docker_compose') {
      const compose = await dockerComposeRuntimeStatus();

      checks.push({
        id: 'docker-compose',
        label: 'Docker Compose',
        status: compose.available ? 'pass' : 'fail',
        detail: compose.detail
      });

      if (!compose.available) {
        grantSteps.push({
          title: 'Install Docker Compose',
          description: 'Docker Compose is required for Compose deployments.',
          commands: process.platform === 'darwin'
            ? [
                'brew install docker-compose',
                'docker compose version'
              ]
            : process.platform === 'linux'
              ? [
                  'sudo apt-get update && sudo apt-get install docker-compose-plugin',
                  'docker compose version'
                ]
              : [
                  'winget install Docker.DockerDesktop',
                  'docker compose version'
                ]
        });
      }
    }

    const commandBlocked = requirements.some((requirement) => requirement.status === 'blocked');
    const userHelpRequired =
      checks.some((check) => check.status === 'fail') ||
      requirements.some((requirement) => requirement.userHelpRequired);
    const ok = checks.every((check) => check.status !== 'fail') && !commandBlocked;

    return {
      ok,
      dockerBin,
      dockerHost: process.env.DOCKER_HOST ?? null,
      dockerConfig: process.env.DOCKER_CONFIG ?? null,
      platform: process.platform,
      checks,
      requirements,
      userHelpRequired,
      grantSteps
    };
  }

  async preview(input: unknown) {
    const plan = await this.buildPlan(input, true);
    this.appsService.validateCreate(plan.appPayload);
    return plan;
  }

  async deploy(input: unknown) {
    let plan = await this.buildPlan(input, true);

    this.appsService.validateCreate(plan.appPayload);

    let containerId = '';
    let adoptedExistingContainer = false;

    try {
      await ensureHostMountsWritable(plan.hostMounts);
      if (plan.method === 'docker_compose') {
        if (!plan.composeContent) {
          throw new DeployExecutionError('Compose content was not prepared.');
        }
        await writeComposeFile(plan.containerName, plan.composeContent);
      }
      if (plan.method === 'binary_service') {
        containerId = await installAndStartBinaryService(plan);
      } else {
        const { stdout } = plan.method === 'docker_compose'
        ? await runDockerComposeCommand(plan.dockerArgs.slice(1), {
            timeout: 240_000
          })
        : await runDockerCommand(plan.dockerArgs, {
            timeout: 240_000
          });
        containerId = plan.method === 'docker_compose'
          ? plan.composeProjectDir ?? plan.containerName
          : stdout.trim();
      }
    } catch (error) {
      const detail = commandDetail(error);

      if (
        (plan.method !== 'docker_run' && plan.method !== 'static_site') ||
        !isContainerNameConflict(detail)
      ) {
        if (plan.method === 'binary_service') {
          await removeBinaryService(plan.containerName, plan.resolvedDeployInput).catch(() => undefined);
        }
        throw error;
      }

      let existing = await inspectContainer(plan.containerName);

      if (!existing.State?.Running) {
        await runDockerCommand(['start', plan.containerName]);
        existing = await inspectContainer(plan.containerName);
      }

      containerId = existing.Id;
      plan = planWithExistingContainer(plan, existing);
      adoptedExistingContainer = true;
    }

    this.appsService.validateCreate(plan.appPayload);

    let created;

    try {
      created = await this.appsService.create(plan.appPayload);
      if (created.app) {
        this.repo.create({
          appId: created.app.id,
          provider: plan.method === 'docker_compose'
            ? 'docker_compose'
            : plan.method === 'binary_service'
              ? 'binary_service'
              : 'docker',
          resourceId: containerId,
          resourceName: plan.containerName,
          deployInput: plan.resolvedDeployInput
        });
        created = {
          ...created,
          app: {
            ...created.app,
            managedDeployment: true
          }
        };
      }
    } catch (error) {
      if (!adoptedExistingContainer) {
        if (plan.method === 'docker_compose') {
          await runDockerComposeCommand([
            '-p',
            plan.containerName,
            '-f',
            plan.composeFilePath ?? path.join(config.deploymentsPath, plan.containerName, 'compose.yml'),
            'down',
            '--volumes',
            '--remove-orphans'
          ]).catch(() => undefined);
        } else if (plan.method === 'binary_service') {
          await removeBinaryService(plan.containerName, plan.resolvedDeployInput).catch(() => undefined);
        } else {
          await runDockerCommand(['rm', '-fv', plan.containerName]).catch(() => undefined);
        }
      }

      if (created?.app) {
        await this.appsService.delete(created.app.id).catch(() => undefined);
      }

      throw error;
    }

    return {
      containerId,
      plan,
      app: created.app,
      proxySync: created.proxySync
    };
  }

  findManagedDeployment(appId: string) {
    return this.repo.findByAppId(appId);
  }

  async managedDeploymentStatus(appId: string) {
    const deployment = this.repo.findByAppId(appId);

    if (!deployment) {
      return null;
    }

    const publicDeployment = {
      appId: deployment.appId,
      provider: deployment.provider,
      resourceId: deployment.resourceId,
      resourceName: deployment.resourceName,
      createdAt: deployment.createdAt
    };

    if (deployment.provider === 'docker_compose') {
      const containers = await listComposeProjectContainers(deployment.resourceName);
      const composeFilePath = path.join(deployment.resourceId, 'compose.yml');

      return {
        ...publicDeployment,
        runtime: {
          kind: 'docker_compose' as const,
          running: containers.length > 0 && containers.some((container) => container.state === 'running'),
          state: containers.length > 0
            ? `${containers.filter((container) => container.state === 'running').length}/${containers.length} running`
            : 'missing',
          composeFilePath,
          containers
        }
      };
    }

    if (deployment.provider === 'binary_service') {
      const service = await binaryServiceStatus(deployment.resourceName, deployment.deployInput);

      return {
        ...publicDeployment,
        runtime: {
          kind: 'binary_service' as const,
          running: service.running,
          state: service.state,
          command: service.serviceName,
          pids: service.pids
        }
      };
    }

    try {
      const container = await inspectContainer(deployment.resourceName);

      return {
        ...publicDeployment,
        runtime: {
          kind: 'docker' as const,
          running: Boolean(container.State?.Running),
          state: container.State?.Status ?? (container.State?.Running ? 'running' : 'stopped'),
          containerId: container.Id,
          containerName: container.Name.replace(/^\//, '')
        }
      };
    } catch (error) {
      const detail = commandDetail(error);

      if (!/No such object|No such container|not found/i.test(detail)) {
        throw error;
      }

      return {
        ...publicDeployment,
        runtime: {
          kind: 'docker' as const,
          running: false,
          state: 'missing',
          containerId: deployment.resourceId,
          containerName: deployment.resourceName
        }
      };
    }
  }

  async manageDeployment(appId: string, action: 'start' | 'stop' | 'restart' | 'pull' | 'redeploy') {
    const deployment = this.repo.findByAppId(appId);

    if (!deployment) {
      return null;
    }

    if (action === 'pull') {
      if (deployment.provider === 'binary_service') {
        throw new DeployInputError('Pull is not available for local binary service deployments.');
      }

      if (deployment.provider === 'docker_compose') {
        await runDockerComposeCommand([
          '-p',
          deployment.resourceName,
          '-f',
          path.join(deployment.resourceId, 'compose.yml'),
          'pull'
        ]);
      } else {
        const container = await inspectContainer(deployment.resourceName);
        const image = container.Config?.Image;

        if (!image) {
          throw new DeployExecutionError(`Could not determine Docker image for ${deployment.resourceName}.`);
        }

        await runDockerCommand(['pull', image], { timeout: 240_000 });
      }

      return this.managedDeploymentStatus(appId);
    }

    if (action === 'redeploy') {
      if (deployment.provider === 'binary_service') {
        if (!deployment.deployInput) {
          throw new DeployInputError('This binary service deployment is missing redeploy metadata.');
        }

        const plan = await this.buildPlan(deployment.deployInput, false);
        await removeBinaryService(deployment.resourceName, deployment.deployInput);
        const resourceId = await installAndStartBinaryService(plan);
        this.repo.updateRuntime({
          appId,
          resourceId,
          resourceName: plan.containerName,
          deployInput: plan.resolvedDeployInput
        });
        return this.managedDeploymentStatus(appId);
      }

      if (deployment.provider === 'docker_compose') {
        await runDockerComposeCommand([
          '-p',
          deployment.resourceName,
          '-f',
          path.join(deployment.resourceId, 'compose.yml'),
          'pull'
        ], { timeout: 240_000 });
        await runDockerComposeCommand([
          '-p',
          deployment.resourceName,
          '-f',
          path.join(deployment.resourceId, 'compose.yml'),
          'up',
          '-d',
          '--remove-orphans'
        ], { timeout: 240_000 });
        return this.managedDeploymentStatus(appId);
      }

      if (!deployment.deployInput) {
        throw new DeployInputError(
          'This Docker deployment was created before redeploy metadata was saved. Delete and deploy it again to enable redeploy.'
        );
      }

      const plan = await this.buildPlan(deployment.deployInput, false);
      await ensureHostMountsWritable(plan.hostMounts);
      await runDockerCommand(['pull', plan.image], { timeout: 240_000 });
      let original: DockerInspectContainer | null = null;
      try {
        original = await inspectContainer(deployment.resourceName);
      } catch (error) {
        if (!/No such object|No such container|not found/i.test(commandDetail(error))) throw error;
      }
      const suffix = randomBytes(8).toString('hex');
      const replacementName = `${plan.containerName}-replacement-${suffix}`;
      const backupName = `${deployment.resourceName}-previous-${suffix}`;
      let replacementCreated = false;
      let originalRenamed = false;
      let replacementRenamed = false;
      try {
        const { stdout } = await runDockerCommand(replacementCreateArgs(plan, replacementName, original), { timeout: 240_000 });
        replacementCreated = true;
        if (original) {
          if (original.State?.Running) await runDockerCommand(['stop', deployment.resourceName]);
          await runDockerCommand(['rename', deployment.resourceName, backupName]);
          originalRenamed = true;
        }
        await runDockerCommand(['rename', replacementName, plan.containerName]);
        replacementRenamed = true;
        await runDockerCommand(['start', plan.containerName]);
        this.repo.updateRuntime({
          appId,
          resourceId: stdout.trim(),
          resourceName: plan.containerName,
          deployInput: plan.resolvedDeployInput
        });
      } catch (error) {
        const rollbackErrors: string[] = [];
        const attempt = async (args: string[]) => {
          try { await runDockerCommand(args); }
          catch (rollbackError) { rollbackErrors.push(commandDetail(rollbackError)); }
        };
        // Never remove volumes, including when discarding a failed replacement.
        if (replacementCreated) await attempt(['rm', '-f', replacementRenamed ? plan.containerName : replacementName]);
        if (originalRenamed) await attempt(['rename', backupName, deployment.resourceName]);
        if (original?.State?.Running) await attempt(['start', deployment.resourceName]);
        throw new DeployExecutionError(`${commandDetail(error)}. ${rollbackErrors.length
          ? `Rollback incomplete; previous container ${backupName}: ${rollbackErrors.join('; ')}`
          : 'Previous container and volumes preserved.'}`);
      }
      const warnings: string[] = [];
      if (originalRenamed) {
        try { await runDockerCommand(['rm', '-f', backupName]); }
        catch (error) { warnings.push(`Replacement is running; previous container ${backupName} could not be removed: ${commandDetail(error)}`); }
      }
      const status = await this.managedDeploymentStatus(appId);
      return status ? { ...status, warnings } : null;
    }

    if (deployment.provider === 'docker_compose') {
      await runDockerComposeCommand([
        '-p',
        deployment.resourceName,
        '-f',
        path.join(deployment.resourceId, 'compose.yml'),
        action
      ]);
    } else if (deployment.provider === 'binary_service') {
      if (!deployment.deployInput) {
        throw new DeployInputError('This binary service deployment is missing service metadata.');
      }
      await controlBinaryService(action, deployment.resourceName, deployment.deployInput);
    } else {
      await runDockerCommand([action, deployment.resourceName]);
    }

    return this.managedDeploymentStatus(appId);
  }

  async redeployPreview(appId: string) {
    const deployment = this.repo.findByAppId(appId);

    if (!deployment) {
      return null;
    }

    const warnings: string[] = [];
    const actions = [
      'Pull the latest image for the managed deployment.',
      'Recreate only the managed container or Compose project.',
      'Keep The Containers app route, public host, and proxy settings.'
    ];

    if (deployment.provider === 'docker_compose') {
      const containers = await listComposeProjectContainers(deployment.resourceName);

      return {
        appId,
        provider: deployment.provider,
        resourceName: deployment.resourceName,
        canRedeploy: true,
        image: containers.map((container) => container.image).filter(Boolean).join(', ') || 'Defined in Compose file',
        targetUrl: null,
        hostPort: null,
        containerPort: null,
        composeFilePath: path.join(deployment.resourceId, 'compose.yml'),
        currentState: containers.length > 0
          ? `${containers.filter((container) => container.state === 'running').length}/${containers.length} running`
          : 'missing',
        actions,
        preserved: [
          'Named Docker volumes and bind-mounted data paths are preserved.',
          'The managed Compose file and project directory are preserved.',
          'The existing app record and route are preserved.'
        ],
        removed: [
          'Orphaned containers from the same managed Compose project may be removed.',
          'Images are not deleted.'
        ],
        warnings
      };
    }

    if (deployment.provider === 'binary_service') {
      const service = await binaryServiceStatus(deployment.resourceName, deployment.deployInput);

      if (!deployment.deployInput) {
        return {
          appId,
          provider: deployment.provider,
          resourceName: deployment.resourceName,
          canRedeploy: false,
          image: null,
          targetUrl: null,
          hostPort: null,
          containerPort: null,
          composeFilePath: null,
          currentState: service.state,
          actions: [],
          preserved: ['The existing app record and route are preserved.'],
          removed: [],
          warnings: ['This binary service deployment is missing saved metadata.']
        };
      }

      const plan = await this.buildPlan(deployment.deployInput, false);

      return {
        appId,
        provider: deployment.provider,
        resourceName: deployment.resourceName,
        canRedeploy: true,
        image: plan.image,
        targetUrl: plan.targetUrl,
        hostPort: plan.hostPort,
        containerPort: plan.containerPort,
        composeFilePath: null,
        currentState: service.state,
        actions: [
          'Remove and reinstall the managed local service definition.',
          'Start the service through the host service manager.',
          'Keep The Containers app route, public host, and proxy settings.'
        ],
        preserved: [
          'Service data outside the generated service file is preserved.',
          'The managed service file is recreated from saved metadata.',
          'The existing app record and route are preserved.',
          `The Web UI port ${plan.hostPort ?? plan.containerPort} is reused.`
        ],
        removed: [
          'Data managed by the service command is not deleted.'
        ],
        warnings
      };
    }

    if (!deployment.deployInput) {
      return {
        appId,
        provider: deployment.provider,
        resourceName: deployment.resourceName,
        canRedeploy: false,
        image: null,
        targetUrl: null,
        hostPort: null,
        containerPort: null,
        composeFilePath: null,
        currentState: 'metadata missing',
        actions: [],
        preserved: ['The existing app record and route will stay unchanged.'],
        removed: [],
        warnings: [
          'This Docker run deployment was created before redeploy metadata was saved. Delete and deploy it again to enable safe redeploy.'
        ]
      };
    }

    const plan = await this.buildPlan(deployment.deployInput, false);
    let currentState = 'unknown';
    let attachedVolumes: NonNullable<DockerInspectContainer['Mounts']> = [];

    try {
      const container = await inspectContainer(deployment.resourceName);
      attachedVolumes = (container.Mounts ?? []).filter((mount) => mount.Type === 'volume');
      currentState = container.State?.Status ?? (container.State?.Running ? 'running' : 'stopped');
    } catch (error) {
      const detail = commandDetail(error);

      if (!/No such object|No such container|not found/i.test(detail)) {
        throw error;
      }

      currentState = 'missing';
      warnings.push('The current container is missing. Redeploy will create it again from saved settings.');
    }

    return {
      appId,
      provider: deployment.provider,
      resourceName: deployment.resourceName,
      canRedeploy: true,
      image: plan.image,
      targetUrl: plan.targetUrl,
      hostPort: plan.hostPort,
      containerPort: plan.containerPort,
      composeFilePath: null,
      currentState,
      actions: [
        ...actions,
        `Recreate Docker container ${plan.containerName}.`
      ],
      preserved: [
        'Bind-mounted host paths and named and anonymous Docker volumes are preserved.',
        ...attachedVolumes.map((mount) => `Reattach Docker volume ${mount.Name} at ${mount.Destination} (${mount.RW === false ? 'read-only' : 'read-write'}).`),
        'The existing app record and route are preserved.',
        `The same published port ${plan.hostPort ?? plan.containerPort} is reused.`
      ],
      removed: [
        `The old managed container ${deployment.resourceName} is removed only after the replacement starts; creation/start failures roll back to the previous container.`,
        'Images, bind-mounted data, and Docker volumes are not deleted.'
      ],
      warnings: [
        ...warnings,
        ...plan.warnings.filter((warning) => !/will bind|requires DNS/i.test(warning))
      ]
    };
  }

  async deploymentDrift(appId: string) {
    const app = this.appsService.findById(appId);
    const deployment = this.repo.findByAppId(appId);

    if (!deployment || !app) {
      return null;
    }

    const checks: DeploymentDriftCheck[] = [
      {
        id: 'managed-record',
        label: 'Managed record',
        status: 'pass',
        detail: `The app is linked to ${deployment.resourceName}.`
      }
    ];
    const repairs: DeploymentRepairAction[] = [];

    if (deployment.provider === 'docker_compose') {
      const composeFilePath = path.join(deployment.resourceId, 'compose.yml');
      const composeExists = await fileExists(composeFilePath);
      const containers = await listComposeProjectContainers(deployment.resourceName);
      const running = containers.filter((container) => container.state === 'running').length;

      checks.push({
        id: 'compose-file',
        label: 'Compose file',
        status: composeExists ? 'pass' : 'fail',
        detail: composeExists
          ? composeFilePath
          : `Managed Compose file is missing at ${composeFilePath}.`
      });
      checks.push({
        id: 'compose-containers',
        label: 'Compose containers',
        status: containers.length === 0 ? 'fail' : running > 0 ? 'pass' : 'warn',
        detail: containers.length === 0
          ? 'No containers were found for this managed Compose project.'
          : `${running}/${containers.length} containers are running.`
      });
      if (containers.length === 0) {
        repairs.push({
          id: 'redeploy',
          label: 'Redeploy Compose project',
          detail: 'Recreate the missing managed Compose project from the saved Compose file.',
          severity: 'review'
        });
      } else if (running === 0) {
        repairs.push({
          id: 'start',
          label: 'Start Compose project',
          detail: 'Start the managed Compose project without changing images or routes.',
          severity: 'safe'
        });
      }

      const expectedPort =
        deployment.deployInput && typeof deployment.deployInput === 'object' && 'hostPort' in deployment.deployInput
          ? (deployment.deployInput as { hostPort?: unknown }).hostPort
          : null;
      const appPort = targetPort(app.targetUrl);

      if (typeof expectedPort === 'number' && appPort !== expectedPort) {
        checks.push({
          id: 'target-port',
          label: 'Target port',
          status: 'warn',
          detail: `App target uses port ${appPort ?? 'unknown'}, but deployment metadata expects ${expectedPort}.`
        });
        repairs.push({
          id: 'update_target_from_runtime',
          label: 'Update app target',
          detail: `Update the app target to ${targetUrlForPort(expectedPort)}.`,
          severity: 'safe'
        });
      } else if (appPort) {
        checks.push({
          id: 'target-port',
          label: 'Target port',
          status: 'pass',
          detail: `App target is ${app.targetUrl}.`
        });
      }
    } else if (deployment.provider === 'binary_service') {
      const service = await binaryServiceStatus(deployment.resourceName, deployment.deployInput);

      checks.push({
        id: 'service',
        label: 'Service',
        status: service.running ? 'pass' : 'warn',
        detail: `${service.serviceName} is ${service.state}.`
      });
      if (!service.running) {
        repairs.push({
          id: 'start',
          label: 'Start service',
          detail: 'Start the managed local service.',
          severity: 'safe'
        });
      }

      if (!deployment.deployInput) {
        checks.push({
          id: 'redeploy-metadata',
          label: 'Redeploy metadata',
          status: 'warn',
          detail: 'This binary service deployment is missing saved metadata, so safe redeploy is disabled.'
        });
      } else {
        const plan = await this.buildPlan(deployment.deployInput, false);
        const appPort = targetPort(app.targetUrl);
        checks.push({
          id: 'target-port',
          label: 'Target port',
          status: appPort === (plan.hostPort ?? plan.containerPort) ? 'pass' : 'warn',
          detail: `App target ${app.targetUrl}; saved port ${plan.hostPort ?? plan.containerPort}.`
        });
        if (appPort !== (plan.hostPort ?? plan.containerPort)) {
          repairs.push({
            id: 'update_target_from_runtime',
            label: 'Update app target',
            detail: `Update the app target to ${targetUrlForPort(plan.hostPort ?? plan.containerPort)}.`,
            severity: 'safe'
          });
        }
      }
    } else {
      let container: DockerInspectContainer | null = null;

      try {
        container = await inspectContainer(deployment.resourceName);
      } catch (error) {
        const detail = commandDetail(error);

        if (!/No such object|No such container|not found/i.test(detail)) {
          throw error;
        }
      }

      checks.push({
        id: 'container',
        label: 'Container',
        status: container ? 'pass' : 'fail',
        detail: container
          ? `${container.Name.replace(/^\//, '')} exists.`
          : `Container ${deployment.resourceName} was not found.`
      });
      if (!container && deployment.deployInput) {
        repairs.push({
          id: 'redeploy',
          label: 'Recreate container',
          detail: 'Recreate the missing managed container from saved deployment metadata.',
          severity: 'review'
        });
      }

      if (container) {
        checks.push({
          id: 'container-state',
          label: 'Container state',
          status: container.State?.Running ? 'pass' : 'warn',
          detail: container.State?.Status ?? (container.State?.Running ? 'running' : 'stopped')
        });
        if (!container.State?.Running) {
          repairs.push({
            id: 'start',
            label: 'Start container',
            detail: 'Start the stopped managed container.',
            severity: 'safe'
          });
        }
      }

      if (!deployment.deployInput) {
        checks.push({
          id: 'redeploy-metadata',
          label: 'Redeploy metadata',
          status: 'warn',
          detail: 'This Docker run deployment is missing saved metadata, so safe redeploy is disabled.'
        });
      } else {
        const plan = await this.buildPlan(deployment.deployInput, false);
        const appPort = targetPort(app.targetUrl);
        const publishedPort = container
          ? firstPublishedPort(container, plan.containerPort)
          : null;

        checks.push({
          id: 'redeploy-metadata',
          label: 'Redeploy metadata',
          status: 'pass',
          detail: `Saved redeploy metadata points to ${plan.image}.`
        });
        checks.push({
          id: 'target-port',
          label: 'Target port',
          status:
            appPort === (plan.hostPort ?? plan.containerPort) &&
            (!publishedPort || publishedPort === appPort)
              ? 'pass'
              : 'warn',
          detail: `App target ${app.targetUrl}; saved port ${plan.hostPort ?? plan.containerPort}; runtime port ${publishedPort ?? 'unknown'}.`
        });
        if (appPort !== (publishedPort ?? plan.hostPort ?? plan.containerPort)) {
          const repairPort = publishedPort ?? plan.hostPort ?? plan.containerPort;
          repairs.push({
            id: 'update_target_from_runtime',
            label: 'Update app target',
            detail: `Update the app target to ${targetUrlForPort(repairPort)}.`,
            severity: 'safe'
          });
        }
      }
    }

    const status = checks.some((check) => check.status === 'fail')
      ? 'fail'
      : checks.some((check) => check.status === 'warn')
        ? 'warn'
        : 'pass';

    return {
      appId,
      provider: deployment.provider,
      resourceName: deployment.resourceName,
      checkedAt: new Date().toISOString(),
      status,
      checks,
      repairs
    };
  }

  async repairDeploymentDrift(
    appId: string,
    action: 'start' | 'redeploy' | 'update_target_from_runtime'
  ) {
    const app = this.appsService.findById(appId);
    const deployment = this.repo.findByAppId(appId);

    if (!deployment || !app) {
      return null;
    }

    if (action === 'start' || action === 'redeploy') {
      await this.manageDeployment(appId, action);
      return {
        repair: action,
        app: this.appsService.findById(appId),
        drift: await this.deploymentDrift(appId),
        proxySync: null
      };
    }

    let port: number | null = null;

    if (deployment.provider === 'docker_compose') {
      if (
        deployment.deployInput &&
        typeof deployment.deployInput === 'object' &&
        'hostPort' in deployment.deployInput &&
        typeof (deployment.deployInput as { hostPort?: unknown }).hostPort === 'number'
      ) {
        port = (deployment.deployInput as { hostPort: number }).hostPort;
      }
    } else if (deployment.provider === 'binary_service') {
      if (deployment.deployInput) {
        const plan = await this.buildPlan(deployment.deployInput, false);
        port = plan.hostPort ?? plan.containerPort;
      }
    } else {
      const container = await inspectContainer(deployment.resourceName);

      if (deployment.deployInput) {
        const plan = await this.buildPlan(deployment.deployInput, false);
        port = firstPublishedPort(container, plan.containerPort) ?? plan.hostPort ?? plan.containerPort;
      } else {
        port = firstPublishedPort(container, 80);
      }
    }

    if (!port) {
      throw new DeployInputError('No runtime port could be found for this deployment.');
    }

    const updated = await this.appsService.update(appId, {
      name: app.name,
      slug: app.slug,
      iconType: app.iconType,
      iconValue: app.iconValue,
      targetUrl: targetUrlForPort(port),
      routeMode: app.routeMode,
      publicHost: app.publicHost,
      publicPath: app.publicPath,
      enabled: app.enabled,
      sortOrder: app.sortOrder,
      category: app.category,
      tags: app.tags,
      favorite: app.favorite
    });

    return {
      repair: action,
      app: updated?.app ?? null,
      drift: await this.deploymentDrift(appId),
      proxySync: updated?.proxySync ?? null
    };
  }

  async deploymentLogs(appId: string, tail = 200) {
    const deployment = this.repo.findByAppId(appId);

    if (!deployment) {
      return null;
    }

    const safeTail = Math.max(20, Math.min(1000, tail));
    if (deployment.provider === 'binary_service') {
      return {
        appId,
        provider: deployment.provider,
        resourceName: deployment.resourceName,
        tail: safeTail,
        logs: await binaryServiceLogs(deployment.resourceName, deployment.deployInput, safeTail)
      };
    }

    const result = deployment.provider === 'docker_compose'
      ? await runDockerComposeCommand([
          '-p',
          deployment.resourceName,
          '-f',
          path.join(deployment.resourceId, 'compose.yml'),
          'logs',
          '--tail',
          String(safeTail),
          '--no-color'
        ])
      : await runDockerCommand([
          'logs',
          '--tail',
          String(safeTail),
          deployment.resourceName
        ]);

    return {
      appId,
      provider: deployment.provider,
      resourceName: deployment.resourceName,
      tail: safeTail,
      logs: [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd()
    };
  }

  async deleteManagedDeployment(appId: string) {
    const deployment = this.repo.findByAppId(appId);

    if (!deployment) {
      return null;
    }

    try {
      if (deployment.provider === 'docker_compose') {
        try {
          await runDockerComposeCommand([
            '-p',
            deployment.resourceName,
            '-f',
            path.join(deployment.resourceId, 'compose.yml'),
            'down',
            '--volumes',
            '--remove-orphans'
          ]);
        } catch (composeError) {
          await removeComposeProjectContainers(deployment.resourceName).catch(() => undefined);
        }
        await fs.rm(deployment.resourceId, { recursive: true, force: true }).catch(() => undefined);
      } else if (deployment.provider === 'binary_service') {
        await removeBinaryService(deployment.resourceName, deployment.deployInput);
      } else {
        await runDockerCommand(['rm', '-fv', deployment.resourceName]);
      }
    } catch (error) {
      const detail = commandDetail(error);

      if (!/No such container|no configuration file provided|not found/i.test(detail)) {
        throw error;
      }
    }

    this.repo.delete(appId);

    return {
      provider: deployment.provider,
      resourceName: deployment.resourceName
    };
  }

  private async buildPlan(input: unknown, allocateHostPort: boolean): Promise<DockerRunPlan> {
    const parsed = deployInputSchema.parse(input);

    if (parsed.method === 'docker_compose') {
      return this.buildComposePlan(parsed, allocateHostPort);
    }

    if (parsed.method === 'static_site') {
      return this.buildStaticSitePlan(parsed, allocateHostPort);
    }

    if (parsed.method === 'binary_service') {
      return this.buildBinaryServicePlan(parsed, allocateHostPort);
    }

    if (parsed.method !== 'docker_run') {
      throw new DeployInputError(`${parsed.method} deployment is not available yet.`);
    }

    const dockerRun = parseDockerRun(trimDockerPrefix(tokenizeShellCommand(parsed.command)));
    const candidatePorts = dockerRun.ports.filter((port) => !parsed.containerPort || port.containerPort === parsed.containerPort);
    const selectedPublishedPort =
      candidatePorts.find((port) => port.protocol === 'tcp') ?? candidatePorts[0];
    const inferredContainerPort = inferKnownContainerPort(
      dockerRun.image,
      parsed.name ?? dockerRun.containerName
    );
    const containerPort = parsed.containerPort ?? selectedPublishedPort?.containerPort ?? inferredContainerPort;

    if (!containerPort) {
      throw new DeployInputError(
        'Add a -p mapping to the Docker command or provide a container port.'
      );
    }

    const requestedHostPort =
      dockerRun.hostNetwork
        ? parsed.hostPort ?? selectedPublishedPort?.hostPort ?? containerPort
        : parsed.hostPort ?? selectedPublishedPort?.hostPort ?? null;
    const warnings = [
      ...dockerRun.warnings,
      ...(selectedPublishedPort || parsed.containerPort
        ? []
        : [`No Docker publish mapping was found, so The Containers inferred container port ${containerPort}.`])
    ];
    const reservedPorts = dockerRun.ports
      .filter((port) => port !== selectedPublishedPort && port.protocol === (selectedPublishedPort?.protocol ?? 'tcp'))
      .flatMap((port) => port.hostPort === null ? [] : [port.hostPort]);
    const hostPort =
      dockerRun.hostNetwork
        ? requestedHostPort
        : allocateHostPort
        ? await resolveHostPort(requestedHostPort, warnings, reservedPorts)
        : requestedHostPort;
    const baseName =
      parsed.name ??
      dockerRun.containerName ??
      nameFromImage(dockerRun.image);
    const containerName = slugify(baseName) || `app-${containerPort}`;
    const routeMode = parsed.routeMode;
    const publicPath =
      routeMode === 'subpath'
        ? parsed.publicPath ?? `/${slugify(containerName) || 'app'}`
        : null;
    const targetUrl = publishedPortTargetUrl(
      dockerRun.hostNetwork ? null : selectedPublishedPort?.hostIp,
      hostPort ?? requestedHostPort ?? containerPort
    );
    const appPayload = {
      name: baseName,
      iconType: 'builtin' as const,
      iconValue: null,
      targetUrl,
      routeMode,
      publicHost: parsed.publicHost,
      publicPath,
      enabled: parsed.enabled,
      sortOrder: 0,
      category: parsed.category ?? 'Self-hosted',
      tags: parsed.tags,
      favorite: parsed.favorite
    };
    const publishedPort: PublishedPort = {
      hostIp: selectedPublishedPort ? selectedPublishedPort.hostIp : '127.0.0.1',
      hostPort: hostPort ?? requestedHostPort ?? containerPort,
      containerPort,
      protocol: selectedPublishedPort?.protocol ?? 'tcp'
    };
    const publishedPorts = selectedPublishedPort
      ? dockerRun.ports.map((port) => port === selectedPublishedPort ? publishedPort : port)
      : [...dockerRun.ports, publishedPort];
    const dockerArgs = dockerRun.hostNetwork
      ? [
          'run',
          '-d',
          '--name',
          containerName,
          ...dockerRun.cleanedArgs
        ]
      : [
          'run',
          '-d',
          '--name',
          containerName,
          ...publishedPorts.flatMap((port) => ['-p', formatPublishedPort(port)]),
          ...dockerRun.cleanedArgs
        ];

    return {
      method: 'docker_run',
      containerName,
      image: dockerRun.image,
      publishMode: parsed.publishMode,
      hostPort,
      containerPort,
      protocol: selectedPublishedPort?.protocol ?? 'tcp',
      targetUrl,
      hostMounts: dockerRun.hostMounts,
      appPayload,
      dockerArgs,
      resolvedDeployInput: resolvedDeployInput(parsed, {
        method: 'docker_run',
        hostPort,
        containerPort,
        appPayload
      }),
      warnings: [
        ...warnings,
        ...(hostPort
          ? []
          : ['A free host port will be allocated when deployment starts.']),
        ...(dockerRun.hostMounts.length
          ? ['Bind mount paths will be created and checked before Docker starts.']
          : []),
        ...(dockerRun.hostNetwork
          ? ['Host network mode detected; Docker publish flags will not be injected.']
          : []),
        ...(parsed.publishMode === 'public_domain_reverse_proxy'
          ? [
              'Public domain mode requires DNS to point to this machine and Caddy to receive public traffic.'
            ]
          : [
              'Reverse proxy mode will bind the host in Caddy; DNS must resolve to this machine for clients to reach it.'
            ])
      ]
    };
  }

  private async buildComposePlan(
    parsed: z.infer<typeof deployInputSchema>,
    allocateHostPort: boolean
  ): Promise<DockerRunPlan> {
    if (!looksLikeComposeYaml(parsed.command)) {
      throw new DeployInputError('Paste docker-compose.yml or compose.yml content for Docker Compose deployment.');
    }

    const service = selectComposeService(parsed.command);
    const selectedPublishedPort = service.port;
    const hostNetwork = service.hostNetwork;
    const image = service.image;
    const serviceName = service.name;
    const serviceContainerName = service.containerName;
    const inferredContainerPort = inferComposeContainerPort(
      parsed.command,
      image,
      serviceName
    );
    const containerPort =
      parsed.containerPort ?? selectedPublishedPort?.containerPort ?? inferredContainerPort;
    const requestedHostPort =
      hostNetwork
        ? parsed.hostPort ?? selectedPublishedPort?.hostPort ?? containerPort
        : parsed.hostPort ?? selectedPublishedPort?.hostPort ?? null;
    const warnings: string[] = [
      ...(selectedPublishedPort || parsed.containerPort
        ? []
        : [`No Compose ports mapping was found, so The Containers inferred container port ${containerPort}.`])
    ];
    const hostPort =
      hostNetwork
        ? requestedHostPort
        : allocateHostPort
        ? await resolveHostPort(requestedHostPort, warnings)
        : requestedHostPort;
    const baseName =
      parsed.name ??
      serviceContainerName ??
      serviceName ??
      nameFromImage(image);
    const containerName = slugify(baseName) || `compose-${containerPort}`;
    const projectDir = path.join(config.deploymentsPath, containerName);
    const composeContent = injectComposePort(
      parsed.command,
      hostPort ?? requestedHostPort ?? containerPort,
      containerPort
    );
    const routeMode = parsed.routeMode;
    const publicPath =
      routeMode === 'subpath'
        ? parsed.publicPath ?? `/${slugify(containerName) || 'app'}`
        : null;
    const targetUrl = publishedPortTargetUrl(
      hostNetwork ? null : selectedPublishedPort?.hostIp,
      hostPort ?? requestedHostPort ?? containerPort
    );
    const composeFilePath = path.join(projectDir, 'compose.yml');
    const appPayload = {
      name: baseName,
      iconType: 'builtin' as const,
      iconValue: null,
      targetUrl,
      routeMode,
      publicHost: parsed.publicHost,
      publicPath,
      enabled: parsed.enabled,
      sortOrder: 0,
      category: parsed.category ?? 'Self-hosted',
      tags: parsed.tags,
      favorite: parsed.favorite
    };
    const dockerArgs = [
      'compose',
      '-p',
      containerName,
      '-f',
      composeFilePath,
      'up',
      '-d'
    ];

    return {
      method: 'docker_compose',
      containerName,
      image,
      publishMode: parsed.publishMode,
      hostPort,
      containerPort,
      protocol: selectedPublishedPort?.protocol ?? 'tcp',
      targetUrl,
      hostMounts: composeHostMounts(composeContent, projectDir),
      composeFilePath,
      composeProjectDir: projectDir,
      composeContent,
      appPayload,
      dockerArgs,
      resolvedDeployInput: resolvedDeployInput(parsed, {
        method: 'docker_compose',
        hostPort,
        containerPort,
        appPayload
      }),
      warnings: [
        ...warnings,
        'The Containers will write this Compose file into its managed deployments directory.',
        ...(hostNetwork
          ? ['Host network mode detected; ports will not be injected into the Compose file.']
          : []),
        ...(parsed.publishMode === 'public_domain_reverse_proxy'
          ? [
              'Public domain mode requires DNS to point to this machine and Caddy to receive public traffic.'
            ]
          : [
              'Reverse proxy mode will bind the host in Caddy; DNS must resolve to this machine for clients to reach it.'
            ])
      ]
    };
  }

  private async buildStaticSitePlan(
    parsed: z.infer<typeof deployInputSchema>,
    allocateHostPort: boolean
  ): Promise<DockerRunPlan> {
    const siteRoot = await resolveStaticSiteRoot(parsed.command);
    const containerPort = parsed.containerPort ?? 80;
    const requestedHostPort = parsed.hostPort ?? null;
    const warnings: string[] = [];
    const hostPort = allocateHostPort
      ? await resolveHostPort(requestedHostPort, warnings)
      : requestedHostPort;
    const baseName = parsed.name ?? staticSiteNameFromRoot(siteRoot);
    const containerName = slugify(baseName) || 'static-site';
    const routeMode = parsed.routeMode;
    const publicPath =
      routeMode === 'subpath'
        ? parsed.publicPath ?? `/${slugify(containerName) || 'app'}`
        : null;
    const targetUrl = `http://127.0.0.1:${hostPort ?? requestedHostPort ?? containerPort}`;
    const appPayload = {
      name: baseName,
      iconType: 'builtin' as const,
      iconValue: null,
      targetUrl,
      routeMode,
      publicHost: parsed.publicHost,
      publicPath,
      enabled: parsed.enabled,
      sortOrder: 0,
      category: parsed.category ?? 'Static sites',
      tags: parsed.tags,
      favorite: parsed.favorite
    };
    const image = 'nginx:alpine';
    const dockerArgs = [
      'run',
      '-d',
      '--name',
      containerName,
      '-p',
      `${hostPort ?? requestedHostPort ?? containerPort}:${containerPort}`,
      '-v',
      `${siteRoot}:/usr/share/nginx/html:ro`,
      image
    ];
    const hasIndex = await fileExists(path.join(siteRoot, 'index.html'));

    return {
      method: 'static_site',
      containerName,
      image,
      publishMode: parsed.publishMode,
      hostPort,
      containerPort,
      protocol: 'tcp',
      targetUrl,
      hostMounts: [],
      appPayload,
      dockerArgs,
      resolvedDeployInput: resolvedDeployInput(parsed, {
        method: 'static_site',
        hostPort,
        containerPort,
        appPayload
      }),
      warnings: [
        ...warnings,
        `Static files from ${siteRoot} will be mounted read-only into nginx.`,
        'Docker must be able to access this host folder. If nginx returns 403 or an empty directory, move the built files under a Docker-shared path or update Docker file sharing settings.',
        ...(hasIndex
          ? []
          : ['No index.html was found at the static site root; directory requests may return 403.']),
        ...(parsed.publishMode === 'public_domain_reverse_proxy'
          ? [
              'Public domain mode requires DNS to point to this machine and Caddy to receive public traffic.'
            ]
          : [
              'Reverse proxy mode will bind the host in Caddy; DNS must resolve to this machine for clients to reach it.'
            ])
      ]
    };
  }

  private async buildBinaryServicePlan(
    parsed: z.infer<typeof deployInputSchema>,
    checkPort: boolean
  ): Promise<DockerRunPlan> {
    return buildBinaryServicePlanFromInput(parsed, checkPort);
  }
}
