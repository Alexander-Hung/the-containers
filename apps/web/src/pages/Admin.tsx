import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Search,
  Server,
  Shield,
  Square,
  Terminal,
  Upload,
  X
} from 'lucide-react';
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { AuditLogPanel, BackupSnapshotsPanel } from '../components/AdminPanels';
import { AppCard } from '../components/AppCard';
import { RouteModeWarning } from '../components/RouteModeWarning';
import {
  api,
  getAdminToken,
  setAdminToken,
  type AppPayload,
  type AppStatus,
  type AuditLog,
  type BackupSnapshot,
  type DeployDoctor,
  type DeployPayload,
  type DeployPlan,
  type DeployResult,
  type DeploymentDrift,
  type DeploymentLogs,
  type DeploymentStatus,
  type DnsDiagnostic,
  type LocalService,
  type ContainerSettings,
  type ContainerApp,
  type ProxyDiagnostics,
  type ProxyHistoryItem,
  type ProxySync,
  type RedeployPreview,
  type RouteMode
} from '../lib/api';

type Props = {
  onBack: () => void;
  openDeploySignal?: number;
};

const initialForm: AppPayload = {
  name: '',
  iconType: 'builtin',
  iconValue: null,
  targetUrl: 'http://192.168.1.20:8080',
  routeMode: 'subdomain',
  publicHost: 'app.lab.home',
  publicPath: null,
  enabled: true,
  sortOrder: 0,
  category: null,
  tags: [],
  favorite: false
};

const initialDeployForm: DeployPayload = {
  method: 'docker_run',
  command: 'docker run -d --name uptime-kuma -p 3001 louislam/uptime-kuma:1',
  publishMode: 'reverse_proxy',
  name: '',
  publicHost: 'uptime.lab.home',
  routeMode: 'subdomain',
  publicPath: null,
  hostPort: null,
  containerPort: null,
  category: 'Self-hosted',
  tags: [],
  favorite: false,
  enabled: true
};

const ignoredServicesKey = 'the-containers-ignored-services';
const legacyIgnoredServicesKey = 'naviproxy-ignored-services';

const deployMethods: Array<{
  id: DeployPayload['method'];
  title: string;
  detail: string;
  status: 'available' | 'planned';
}> = [
  {
    id: 'docker_run',
    title: 'Docker run',
    detail: 'Paste a docker run command',
    status: 'available'
  },
  {
    id: 'docker_compose',
    title: 'Docker Compose',
    detail: 'Paste compose.yml content',
    status: 'available'
  },
  {
    id: 'github_auto',
    title: 'GitHub auto',
    detail: 'Clone repo and detect deploy type',
    status: 'planned'
  },
  {
    id: 'static_site',
    title: 'Static site',
    detail: 'Serve an existing dist folder',
    status: 'available'
  },
  {
    id: 'node_app',
    title: 'Node app',
    detail: 'npm/pnpm/yarn/bun service',
    status: 'planned'
  },
  {
    id: 'python_app',
    title: 'Python app',
    detail: 'pip/uv service',
    status: 'planned'
  },
  {
    id: 'binary_service',
    title: 'Binary/service',
    detail: 'Run a local daemon command',
    status: 'available'
  },
  {
    id: 'custom_command',
    title: 'Custom command',
    detail: 'advanced install/start commands',
    status: 'planned'
  }
];

const deployOptionValueNames = new Set([
  '--add-host',
  '--cap-add',
  '--cap-drop',
  '--device',
  '--dns',
  '--entrypoint',
  '--env',
  '--env-file',
  '--expose',
  '--hostname',
  '--label',
  '--memory',
  '--mount',
  '--name',
  '--network',
  '--net',
  '--platform',
  '--publish',
  '--restart',
  '--user',
  '--volume',
  '--workdir'
]);

const deployShortOptionsWithValues = new Set(['e', 'h', 'l', 'm', 'p', 'u', 'v', 'w']);

function expandDeployShortOptionGroup(token: string) {
  if (!/^-[A-Za-z]{2,}$/.test(token)) {
    return [token];
  }

  const flags = token.slice(1).split('');
  const firstValueFlag = flags.findIndex((flag) => deployShortOptionsWithValues.has(flag));

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

function tokenizeDeployCommand(command: string) {
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

  if (current) {
    tokens.push(current);
  }

  return tokens.flatMap(expandDeployShortOptionGroup);
}

function parsePublishPort(raw: string) {
  const [withoutProtocol, protocol = 'tcp'] = raw.split('/');

  if (protocol !== 'tcp') {
    return null;
  }

  const segments = withoutProtocol.split(':');
  const containerPort = Number(segments.at(-1));

  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    return null;
  }

  const hostPart = segments.length >= 2 ? segments.at(-2) : null;
  const hostPort = hostPart && /^\d+$/.test(hostPart) ? Number(hostPart) : null;

  if (hostPort !== null && (hostPort < 1 || hostPort > 65535)) {
    return null;
  }

  return {
    hostPort,
    containerPort
  };
}

function parsePublishPortFromCommand(command: string) {
  const tokens = tokenizeDeployCommand(command);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === '-p' || token === '--publish') {
      const parsed = parsePublishPort(tokens[index + 1] ?? '');

      if (parsed) {
        return parsed;
      }
    }

    if (token.startsWith('--publish=')) {
      const parsed = parsePublishPort(token.slice('--publish='.length));

      if (parsed) {
        return parsed;
      }
    }

    if (token.startsWith('-p') && token.length > 2) {
      const parsed = parsePublishPort(token.slice(2));

      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

function slugifyDeployName(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function nameFromDeployImage(image: string) {
  const withoutDigest = image.split('@')[0];
  const withoutTag = withoutDigest.includes(':')
    ? withoutDigest.slice(0, withoutDigest.lastIndexOf(':'))
    : withoutDigest;

  return withoutTag.split('/').at(-1) ?? '';
}

function parseDeployCommand(command: string) {
  const tokens = tokenizeDeployCommand(command);
  const startIndex =
    tokens[0] === 'sudo' && tokens[1] === 'docker' && tokens[2] === 'run'
      ? 3
      : tokens[0] === 'docker' && tokens[1] === 'run'
        ? 2
        : 0;
  let containerName = '';
  let image = '';

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!image && token === '--name') {
      containerName = tokens[index + 1] ?? '';
      index += 1;
      continue;
    }

    if (!image && token.startsWith('--name=')) {
      containerName = token.slice('--name='.length);
      continue;
    }

    if (!image && (token === '-p' || token === '--publish')) {
      index += 1;
      continue;
    }

    if (!image && token.startsWith('--publish=')) {
      continue;
    }

    if (!image && token.startsWith('-p') && token.length > 2) {
      continue;
    }

    if (!image && token.startsWith('-')) {
      const option = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;

      if (
        !token.includes('=') &&
        (deployOptionValueNames.has(option) ||
          (option.length === 2 && deployShortOptionsWithValues.has(option[1])))
      ) {
        index += 1;
      }

      continue;
    }

    if (!image) {
      image = token;
      break;
    }
  }

  const name = containerName || nameFromDeployImage(image);

  return {
    name,
    slug: slugifyDeployName(name),
    port: parsePublishPortFromCommand(command)
  };
}

function looksLikeComposeYaml(value: string) {
  return /(^|\n)\s*services\s*:/i.test(value);
}

type ComposeServiceBlock = {
  name: string;
  content: string;
};

function composeServiceBlocks(compose: string) {
  const lines = compose.split('\n');
  const servicesIndex = lines.findIndex((line) => /^\s*services\s*:/i.test(line));
  const blocks: ComposeServiceBlock[] = [];
  let current: ComposeServiceBlock | null = null;

  for (const line of lines.slice(Math.max(servicesIndex + 1, 0))) {
    const serviceMatch = line.match(/^\s{2}([A-Za-z0-9._-]+)\s*:\s*(?:#.*)?$/);

    if (serviceMatch) {
      if (current) {
        blocks.push(current);
      }

      current = {
        name: serviceMatch[1],
        content: ''
      };
      continue;
    }

    if (current) {
      current.content += `${line}\n`;
    }
  }

  if (current) {
    blocks.push(current);
  }

  return blocks;
}

function composeBlockImage(block: ComposeServiceBlock) {
  return block.content.match(/^\s*image\s*:\s*['"]?([^'"\s#]+)['"]?/m)?.[1] ?? '';
}

function composeBlockContainerName(block: ComposeServiceBlock) {
  return block.content.match(/^\s*container_name\s*:\s*['"]?([^'"\s#]+)['"]?/m)?.[1] ?? '';
}

function composeBlockUsesHostNetwork(block: ComposeServiceBlock) {
  return /^\s*(network_mode|network)\s*:\s*['"]?host['"]?\s*(?:#.*)?$/m.test(block.content);
}

function parseComposePort(compose: string) {
  for (const line of compose.split('\n')) {
    const match = line.match(/^\s*-\s*['"]?([^'"\s#]+)['"]?/);

    if (!match) {
      continue;
    }

    const parsed = parsePublishPort(match[1]);

    if (parsed) {
      return parsed;
    }
  }

  const target = compose.match(/^\s*(?:-\s*)?target\s*:\s*(\d+)\s*$/m)?.[1];
  const published = compose.match(/^\s*published\s*:\s*(\d+)\s*$/m)?.[1];

  if (target) {
    return {
      hostPort: published ? Number(published) : null,
      containerPort: Number(target)
    };
  }

  return null;
}

function parseComposeExposePort(compose: string) {
  for (const line of compose.split('\n')) {
    const match = line.match(/^\s*-\s*['"]?(\d+)(?:\/tcp)?['"]?\s*$/);

    if (match) {
      return Number(match[1]);
    }
  }

  const expose = compose.match(/^\s*expose\s*:\s*['"]?(\d+)['"]?\s*$/m)?.[1];

  return expose ? Number(expose) : null;
}

function inferComposePort(compose: string, image: string, serviceName: string) {
  const exposed = parseComposeExposePort(compose);

  if (exposed) {
    return {
      hostPort: null,
      containerPort: exposed
    };
  }

  const text = `${image} ${serviceName}`.toLowerCase();
  const knownPorts: Array<[RegExp, number]> = [
    [/postgres|postgis/, 5432],
    [/mysql|mariadb/, 3306],
    [/redis|valkey/, 6379],
    [/mongo/, 27017],
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

  return {
    hostPort: null,
    containerPort: knownPorts.find(([pattern]) => pattern.test(text))?.[1] ?? 80
  };
}

function isDatabaseLikeComposeService(text: string) {
  return /postgres|postgis|mysql|mariadb|redis|valkey|mongo|clickhouse|meili|qdrant|elastic|opensearch|rabbitmq|nats/i.test(text);
}

function isWebLikeComposeService(text: string) {
  return /web|app|api|server|frontend|backend|ui|admin|dashboard|http|nginx|caddy|apache|httpd|traefik|whoami|grafana|prometheus|upsnap|uptime-kuma|homeassistant|home-assistant|jellyfin|plex|portainer/i.test(text);
}

function isLikelyWebComposePort(port: number | null | undefined) {
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

function selectComposeBlock(compose: string) {
  const blocks = composeServiceBlocks(compose);

  return blocks
    .map((block, index) => {
      const image = composeBlockImage(block);
      const containerName = composeBlockContainerName(block);
      const port = parseComposePort(block.content) ?? inferComposePort(block.content, image, block.name);
      const text = `${block.name} ${image} ${containerName}`.toLowerCase();
      const score =
        (isDatabaseLikeComposeService(text) ? -100 : 0) +
        (isWebLikeComposeService(text) ? 90 : 0) +
        (isLikelyWebComposePort(port.containerPort) ? 70 : 0) +
        (port.hostPort ? 30 : 0) -
        index;

      return {
        block,
        image,
        containerName,
        port,
        score
      };
    })
    .sort((left, right) => right.score - left.score)[0];
}

function parseComposeDeployInput(compose: string) {
  const selected = selectComposeBlock(compose);
  const image = selected?.image ?? '';
  const serviceName = selected?.block.name ?? '';
  const name =
    selected?.containerName ||
    serviceName ||
    nameFromDeployImage(image);
  const port =
    selected?.port ??
    inferComposePort(compose, image, serviceName);

  return {
    name,
    slug: slugifyDeployName(name),
    port: selected && composeBlockUsesHostNetwork(selected.block)
      ? {
          hostPort: port.containerPort,
          containerPort: port.containerPort
        }
      : port
  };
}

function hostSuffixFrom(value: string) {
  const parts = value.split('.').filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('.') : 'lab.home';
}

function DeployHostPermissionSection({
  deployDoctor,
  checkingDeployPermission,
  checkDeployPermission,
  copyCommand
}: {
  deployDoctor: DeployDoctor | null;
  checkingDeployPermission: boolean;
  checkDeployPermission: () => void;
  copyCommand: (command: string) => void;
}) {
  return (
    <div className="rounded border border-black/10 bg-[#f7faf8] p-3 text-xs dark:border-white/15 dark:bg-[#15201c]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-spruce dark:text-[#9be8d7]" />
          <div>
            <div className="font-semibold">Host permission</div>
            <div className="text-black/50 dark:text-[#a9bbb4]">
              {deployDoctor
                ? deployDoctor.ok
                  ? deployDoctor.userHelpRequired
                    ? 'Docker is reachable. This command still needs user review.'
                    : 'Docker can run this command without extra user help.'
                  : 'This command needs host authorization before deployment can run.'
                : 'Check whether this process can execute Docker.'}
            </div>
          </div>
        </div>
        <button
          className="btn-secondary h-9"
          type="button"
          onClick={() => void checkDeployPermission()}
          disabled={checkingDeployPermission}
        >
          <RefreshCw
            size={15}
            className={checkingDeployPermission ? 'animate-spin' : ''}
          />
          {checkingDeployPermission ? 'Checking' : 'Recheck'}
        </button>
      </div>

      {deployDoctor ? (
        <div className="mt-3 grid gap-2">
          <div className="grid gap-2 md:grid-cols-3">
            {deployDoctor.checks.map((check) => (
              <div
                key={check.id}
                className="rounded border border-black/10 bg-white/70 p-2 dark:border-white/10 dark:bg-white/[0.04]"
              >
                <div className="flex items-center gap-2 font-semibold">
                  {check.status === 'pass' ? (
                    <CheckCircle2 size={14} className="text-spruce dark:text-[#9be8d7]" />
                  ) : (
                    <AlertTriangle size={14} className="text-amber" />
                  )}
                  {check.label}
                </div>
                <div className="mt-1 break-all text-black/55 dark:text-[#b8c7c1]">
                  {check.detail}
                </div>
              </div>
            ))}
          </div>

          {deployDoctor.requirements.length > 0 ? (
            <div className="grid gap-2">
              <div className="font-semibold">Command requirements</div>
              {deployDoctor.requirements.map((requirement) => (
                <div
                  key={requirement.id}
                  className={`rounded border p-3 ${
                    requirement.status === 'blocked'
                      ? 'border-coral/30 bg-coral/10'
                      : requirement.status === 'needs_user'
                        ? 'border-amber/30 bg-amber/10'
                        : 'border-black/10 bg-white/70 dark:border-white/10 dark:bg-white/[0.04]'
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {requirement.status === 'ready' ? (
                      <CheckCircle2 size={15} className="mt-0.5 text-spruce dark:text-[#9be8d7]" />
                    ) : requirement.status === 'auto' ? (
                      <RefreshCw size={15} className="mt-0.5 text-spruce dark:text-[#9be8d7]" />
                    ) : requirement.status === 'blocked' ? (
                      <X size={15} className="mt-0.5 text-coral" />
                    ) : (
                      <AlertTriangle size={15} className="mt-0.5 text-amber" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{requirement.label}</span>
                        <span className="rounded border border-black/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-black/45 dark:border-white/15 dark:text-[#a9bbb4]">
                          {requirement.status === 'ready'
                            ? 'ready'
                            : requirement.status === 'auto'
                              ? 'auto'
                              : requirement.status === 'blocked'
                                ? 'needs fix'
                                : 'review'}
                        </span>
                      </div>
                      <div className="mt-1 break-words text-black/60 dark:text-[#b8c7c1]">
                        {requirement.detail}
                      </div>
                      {requirement.commands.length > 0 ? (
                        <div className="mt-2 grid gap-1">
                          {requirement.commands.map((command) => (
                            <div
                              key={command}
                              className="flex items-center gap-2 rounded bg-black/[0.04] px-2 py-1.5 font-mono text-[11px] dark:bg-black/25"
                            >
                              <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre">
                                {command}
                              </code>
                              <button
                                type="button"
                                className="grid h-7 w-7 shrink-0 place-items-center rounded text-black/45 transition hover:bg-black/10 hover:text-black dark:text-[#a9bbb4] dark:hover:bg-white/10 dark:hover:text-white"
                                onClick={() => void copyCommand(command)}
                                title="Copy command"
                                aria-label="Copy command"
                              >
                                <Clipboard size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {deployDoctor.grantSteps.length > 0 ? (
            <div className="grid gap-2">
              {deployDoctor.grantSteps.map((step) => (
                <div
                  key={step.title}
                  className="rounded border border-amber/30 bg-amber/10 p-3"
                >
                  <div className="flex items-start gap-2">
                    <Terminal size={15} className="mt-0.5 text-amber" />
                    <div>
                      <div className="font-semibold">{step.title}</div>
                      <div className="mt-1 text-black/60 dark:text-[#d5caa2]">
                        {step.description}
                      </div>
                    </div>
                  </div>
                  {step.commands.length > 0 ? (
                    <div className="mt-2 grid gap-1">
                      {step.commands.map((command) => (
                        <div
                          key={command}
                          className="flex items-center gap-2 rounded bg-black/[0.04] px-2 py-1.5 font-mono text-[11px] dark:bg-black/25"
                        >
                          <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre">
                            {command}
                          </code>
                          <button
                            type="button"
                            className="grid h-7 w-7 shrink-0 place-items-center rounded text-black/45 transition hover:bg-black/10 hover:text-black dark:text-[#a9bbb4] dark:hover:bg-white/10 dark:hover:text-white"
                            onClick={() => void copyCommand(command)}
                            title="Copy command"
                            aria-label="Copy command"
                          >
                            <Clipboard size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Admin({ onBack, openDeploySignal = 0 }: Props) {
  const [apps, setApps] = useState<ContainerApp[]>([]);
  const [statuses, setStatuses] = useState<Record<string, AppStatus>>({});
  const [healthHistory, setHealthHistory] = useState<AppStatus[]>([]);
  const [history, setHistory] = useState<ProxyHistoryItem[]>([]);
  const [form, setForm] = useState<AppPayload>(initialForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [tokenInput, setTokenInput] = useState(getAdminToken());
  const [dnsHost, setDnsHost] = useState('');
  const [dnsResult, setDnsResult] = useState<DnsDiagnostic | null>(null);
  const [localServices, setLocalServices] = useState<LocalService[]>([]);
  const [serviceSearch, setServiceSearch] = useState('');
  const [serviceScope, setServiceScope] = useState<'all' | 'public' | 'loopback'>('all');
  const [showSystemServices, setShowSystemServices] = useState(false);
  const [ignoredServices, setIgnoredServices] = useState<string[]>(() => {
    try {
      const stored =
        localStorage.getItem(ignoredServicesKey) ??
        localStorage.getItem(legacyIgnoredServicesKey) ??
        '[]';

      return JSON.parse(stored);
    } catch {
      return [];
    }
  });
  const [settings, setSettings] = useState<ContainerSettings | null>(null);
  const [customCaddyRoutesText, setCustomCaddyRoutesText] = useState('[]');
  const [proxyDiagnostics, setProxyDiagnostics] = useState<ProxyDiagnostics | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [backupSnapshots, setBackupSnapshots] = useState<BackupSnapshot[]>([]);
  const [deployForm, setDeployForm] = useState<DeployPayload>(initialDeployForm);
  const [deployPlan, setDeployPlan] = useState<DeployPlan | null>(null);
  const [deployDoctor, setDeployDoctor] = useState<DeployDoctor | null>(null);
  const deployDoctorAutoChecked = useRef(false);
  const [deploySuccess, setDeploySuccess] = useState<DeployResult | null>(null);
  const [showDeployDialog, setShowDeployDialog] = useState(false);
  const [detailAppId, setDetailAppId] = useState<string | null>(null);
  const [detailHistory, setDetailHistory] = useState<AppStatus[]>([]);
  const [deploymentStatus, setDeploymentStatus] = useState<DeploymentStatus | null>(null);
  const [deploymentDrift, setDeploymentDrift] = useState<DeploymentDrift | null>(null);
  const [deploymentLogs, setDeploymentLogs] = useState<DeploymentLogs | null>(null);
  const [redeployPreview, setRedeployPreview] = useState<RedeployPreview | null>(null);
  const [deploymentAction, setDeploymentAction] = useState<'start' | 'stop' | 'restart' | 'pull' | 'redeploy' | null>(null);
  const [loadingDeploymentLogs, setLoadingDeploymentLogs] = useState(false);
  const [checkingDeploymentDrift, setCheckingDeploymentDrift] = useState(false);
  const [repairingDeploymentDrift, setRepairingDeploymentDrift] = useState<string | null>(null);
  const [loadingRedeployPreview, setLoadingRedeployPreview] = useState(false);
  const [appSearch, setAppSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [scanningServices, setScanningServices] = useState(false);
  const [previewingDeploy, setPreviewingDeploy] = useState(false);
  const [checkingDeployPermission, setCheckingDeployPermission] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    const [
      health,
      nextApps,
      nextStatuses,
      nextSettings,
      nextProxyDiagnostics,
      nextAuditLogs,
      nextBackupSnapshots
    ] = await Promise.all([
      api.health().catch(() => null),
      api.listApps().catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        return [];
      }),
      api.appStatuses().catch(() => []),
      api.settings().catch(() => null),
      api.proxyDiagnostics().catch(() => null),
      api.auditLogs().catch(() => []),
      api.backupSnapshots().catch(() => [])
    ]);

    setAuthRequired(Boolean(health?.authRequired));
    setSettings(nextSettings);
    setCustomCaddyRoutesText(JSON.stringify(nextSettings?.customCaddyRoutes ?? [], null, 2));
    setProxyDiagnostics(nextProxyDiagnostics);
    setAuditLogs(nextAuditLogs);
    setBackupSnapshots(nextBackupSnapshots);
    setApps(nextApps);
    setStatuses(
      Object.fromEntries(nextStatuses.map((status) => [status.id, status]))
    );

    await loadHistory();
  }

  async function loadHistory() {
    try {
      setHistory(await api.proxyHistory());
    } catch {
      setHistory([]);
    }
  }

  useEffect(() => {
    void load().catch((err) =>
      setError(err instanceof Error ? err.message : String(err))
    );
  }, []);

  useEffect(() => {
    if (openDeploySignal > 0) {
      setError(null);
      setMessage(null);
      setShowDeployDialog(true);
      deployDoctorAutoChecked.current = false;
    }
  }, [openDeploySignal]);

  useEffect(() => {
    if (!showDeployDialog) {
      deployDoctorAutoChecked.current = false;
    }
  }, [showDeployDialog]);

  useEffect(() => {
    if (
      !showDeployDialog ||
      deployDoctorAutoChecked.current ||
      deployDoctor ||
      checkingDeployPermission
    ) {
      return;
    }

    deployDoctorAutoChecked.current = true;
    void checkDeployPermission(false);
  }, [checkingDeployPermission, deployDoctor, showDeployDialog]);

  useEffect(() => {
    if (
      !showDeployDialog ||
      deployForm.method === 'binary_service' ||
      !deployForm.command.trim() ||
      deployForm.hostPort
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      void api
        .previewDeploy(deployPayload())
        .then((plan) => {
          setDeployPlan(plan);

          if (plan.hostPort) {
            setDeployForm((current) => ({
              ...current,
              hostPort: plan.hostPort,
              containerPort: current.containerPort ?? plan.containerPort
            }));
          }
        })
        .catch(() => undefined);
    }, 500);

    return () => window.clearTimeout(timer);
  }, [
    deployForm.command,
    deployForm.containerPort,
    deployForm.hostPort,
    showDeployDialog
  ]);

  const sortedApps = useMemo(
    () =>
      [...apps]
        .filter((app) => {
          const query = appSearch.trim().toLowerCase();
          const text = [
            app.name,
            app.publicHost,
            app.targetUrl,
            app.category ?? '',
            ...app.tags
          ]
            .join(' ')
            .toLowerCase();

          return (
            (!query || text.includes(query)) &&
            (!categoryFilter || app.category === categoryFilter) &&
            (!favoriteOnly || app.favorite)
          );
        })
        .sort((left, right) => {
          if (left.favorite !== right.favorite) {
            return left.favorite ? -1 : 1;
          }

          return left.sortOrder - right.sortOrder;
        }),
    [appSearch, apps, categoryFilter, favoriteOnly]
  );
  const allSortedApps = useMemo(
    () => [...apps].sort((left, right) => left.sortOrder - right.sortOrder),
    [apps]
  );
  const categories = useMemo(
    () =>
      [...new Set(apps.map((app) => app.category).filter(Boolean) as string[])]
        .sort((left, right) => left.localeCompare(right)),
    [apps]
  );
  const detailApp = useMemo(
    () => apps.find((app) => app.id === detailAppId) ?? null,
    [apps, detailAppId]
  );
  const filteredLocalServices = useMemo(() => {
    const query = serviceSearch.trim().toLowerCase();
    const ignored = new Set(ignoredServices);

    return localServices.filter((service) => {
      const text = [
        service.processName ?? '',
        service.address,
        service.port,
        service.targetUrl,
        knownServiceName(service.port) ?? ''
      ]
        .join(' ')
        .toLowerCase();
      const matchesScope =
        serviceScope === 'all' ||
        (serviceScope === 'public' &&
          (service.address === '*' ||
            service.address === '0.0.0.0' ||
            service.address === '::')) ||
        (serviceScope === 'loopback' &&
          (service.address === '127.0.0.1' ||
            service.address === '::1' ||
            service.address === 'localhost'));

      return (
        !ignored.has(serviceKey(service)) &&
        (showSystemServices || !isDefaultHiddenService(service)) &&
        matchesScope &&
        (!query || text.includes(query))
      );
    });
  }, [
    ignoredServices,
    localServices,
    serviceScope,
    serviceSearch,
    showSystemServices
  ]);
  const selectedDeployMethod = useMemo(
    () =>
      deployMethods.find((method) => method.id === deployForm.method) ??
      deployMethods[0],
    [deployForm.method]
  );

  function proxySyncMessage(sync?: ProxySync) {
    if (!sync) {
      return 'Saved.';
    }

    if (sync.status === 'success') {
      return 'Saved and Caddy configuration synced.';
    }

    if (sync.status === 'skipped') {
      return 'Saved. Caddy sync is disabled in the API environment.';
    }

    return `Saved, but Caddy sync failed: ${sync.errorMessage ?? 'Unknown error'}`;
  }

  function saveToken() {
    setAdminToken(tokenInput.trim());
    setMessage(tokenInput.trim() ? 'Admin token saved for this tab.' : 'Admin token cleared.');
    setError(null);
    void load();
  }

  function knownServiceName(port: number) {
    const names: Record<number, string> = {
      80: 'HTTP',
      443: 'HTTPS',
      3000: 'Node app',
      32400: 'Plex',
      5173: 'Vite app',
      5174: 'Vite app',
      8080: 'Web UI',
      8096: 'Jellyfin',
      8123: 'Home Assistant',
      9000: 'Portainer'
    };

    return names[port] ?? null;
  }

  function serviceKey(service: LocalService) {
    return `${service.address}:${service.port}:${service.pid ?? 'unknown'}`;
  }

  function isDefaultHiddenService(service: LocalService) {
    const currentPort = Number(window.location.port);
    const processName = (service.processName ?? '').toLowerCase();
    const toolPorts = new Set([
      3001,
      5173,
      5174,
      ...(Number.isFinite(currentPort) && currentPort > 0 ? [currentPort] : [])
    ]);
    const toolProcesses = [
      'code helper',
      'cursor',
      'electron',
      'figma_agent',
      'rapportd',
      'sharingd',
      'controlcenter',
      'coreservicesuiagent',
      'identityservicesd',
      'universalaccessd',
      'antigravity'
    ];

    return (
      (toolPorts.has(service.port) && processName.includes('node')) ||
      toolProcesses.some((name) => processName.includes(name))
    );
  }

  function serviceName(service: LocalService) {
    const known = knownServiceName(service.port);

    if (known) {
      return known;
    }

    return service.processName
      ? `${service.processName} ${service.port}`
      : `Port ${service.port}`;
  }

  function serviceHost(service: LocalService) {
    const base = (service.processName || `port-${service.port}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);

    return `${base || `port-${service.port}`}.lab.home`;
  }

  function ignoreService(service: LocalService) {
    const next = [...new Set([...ignoredServices, serviceKey(service)])];
    setIgnoredServices(next);
    localStorage.setItem(ignoredServicesKey, JSON.stringify(next));
    localStorage.removeItem(legacyIgnoredServicesKey);
  }

  function update<K extends keyof AppPayload>(key: K, value: AppPayload[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateDeploy<K extends keyof DeployPayload>(
    key: K,
    value: DeployPayload[K]
  ) {
    setDeployForm((current) => ({ ...current, [key]: value }));
    setDeployPlan(null);
    setDeployDoctor(null);
  }

  function updateBinaryServicePort(port: number | null) {
    setDeployForm((current) => ({
      ...current,
      hostPort: port,
      containerPort: port
    }));
    setDeployPlan(null);
    setDeployDoctor(null);
  }

  function selectDeployMethod(method: DeployPayload['method']) {
    setDeployForm((current) => {
      if (method === 'binary_service') {
        return {
          ...current,
          method,
          command: current.method === 'binary_service' ? current.command : '',
          name: current.method === 'binary_service' ? current.name : '',
          hostPort: current.method === 'binary_service' ? current.hostPort : null,
          containerPort: current.method === 'binary_service' ? current.containerPort : null,
          category: current.category || 'Self-hosted'
        };
      }

      if (method === 'static_site') {
        return {
          ...current,
          method,
          command: current.method === 'static_site' ? current.command : '',
          name: current.method === 'static_site' ? current.name : '',
          hostPort: current.method === 'static_site' ? current.hostPort : null,
          containerPort: current.method === 'static_site' ? current.containerPort : null,
          category: current.category || 'Static sites'
        };
      }

      return {
        ...current,
        method
      };
    });
    setDeployPlan(null);
    setDeployDoctor(null);
  }

  function updateDeployCommand(command: string) {
    const isCompose = looksLikeComposeYaml(command);
    const parsed = isCompose
      ? parseComposeDeployInput(command)
      : parseDeployCommand(command);

    setDeployForm((current) => ({
      ...current,
      command,
      ...(isCompose && current.method === 'docker_run'
        ? {
            method: 'docker_compose' as const
          }
        : {}),
      ...(current.method === 'docker_run' || current.method === 'docker_compose' || isCompose
        ? {
            ...(parsed.name ? { name: parsed.name } : {}),
            ...(parsed.slug
              ? {
                  publicHost: `${parsed.slug}.${hostSuffixFrom(current.publicHost)}`
                }
              : {}),
            ...(parsed.port
              ? {
                  hostPort: parsed.port.hostPort,
                  containerPort: parsed.port.containerPort
                }
              : {})
          }
        : {})
    }));
    setDeployPlan(null);
    setDeployDoctor(null);
  }

  function deployPayload() {
    const binaryServicePort =
      deployForm.method === 'binary_service'
        ? deployForm.hostPort || deployForm.containerPort || null
        : null;

    return {
      ...deployForm,
      name: deployForm.name?.trim() || undefined,
      publicPath:
        deployForm.routeMode === 'subpath'
          ? deployForm.publicPath || '/app'
          : null,
      hostPort: deployForm.method === 'binary_service' ? binaryServicePort : deployForm.hostPort || null,
      containerPort: deployForm.method === 'binary_service' ? binaryServicePort : deployForm.containerPort || null,
      tags: deployForm.tags.filter(Boolean)
    };
  }

  function appPublicUrl(app: ContainerApp) {
    const route =
      app.routeMode === 'subdomain'
        ? app.publicHost
        : `${app.publicHost}${app.publicPath ?? ''}`;

    return /^https?:\/\//i.test(route) ? route : `http://${route}`;
  }

  function setRouteMode(mode: RouteMode) {
    setForm((current) => ({
      ...current,
      routeMode: mode,
      publicPath: mode === 'subpath' ? current.publicPath ?? '/app' : null
    }));
  }

  function resetForm() {
    setEditingId(null);
    setForm(initialForm);
    setError(null);
    setMessage(null);
    setHealthHistory([]);
  }

  function editApp(app: ContainerApp) {
    setEditingId(app.id);
    setForm({
      name: app.name,
      iconType: app.iconType,
      iconValue: app.iconValue,
      targetUrl: app.targetUrl,
      routeMode: app.routeMode,
      publicHost: app.publicHost,
      publicPath: app.publicPath,
      enabled: app.enabled,
      sortOrder: app.sortOrder,
      category: app.category,
      tags: app.tags,
      favorite: app.favorite
    });
    setError(null);
    setMessage(null);
    void api
      .appHealthHistory(app.id)
      .then(setHealthHistory)
      .catch(() => setHealthHistory([]));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openDetails(app: ContainerApp) {
    setDetailAppId(app.id);
    setDetailHistory([]);
    setDeploymentStatus(null);
    setDeploymentDrift(null);
    setDeploymentLogs(null);
    setRedeployPreview(null);
    void api
      .appHealthHistory(app.id)
      .then(setDetailHistory)
      .catch(() => setDetailHistory([]));
    if (app.managedDeployment) {
      void api
        .deploymentStatus(app.id)
        .then(setDeploymentStatus)
        .catch(() => setDeploymentStatus(null));
      void api
        .deploymentDrift(app.id)
        .then(setDeploymentDrift)
        .catch(() => setDeploymentDrift(null));
    }
  }

  async function checkDeploymentDrift() {
    if (!detailApp) {
      return;
    }

    setCheckingDeploymentDrift(true);
    setError(null);
    setMessage(null);

    try {
      const [status, drift] = await Promise.all([
        api.deploymentStatus(detailApp.id),
        api.deploymentDrift(detailApp.id)
      ]);
      setDeploymentStatus(status);
      setDeploymentDrift(drift);
      setMessage(
        drift.status === 'pass'
          ? 'Deployment drift check passed.'
          : drift.status === 'warn'
            ? 'Deployment drift check completed with warnings.'
            : 'Deployment drift check found a problem.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingDeploymentDrift(false);
    }
  }

  async function repairDeploymentDrift(
    action: 'start' | 'redeploy' | 'update_target_from_runtime'
  ) {
    if (!detailApp) {
      return;
    }

    if (action === 'redeploy' && !window.confirm('Redeploy this app to repair drift?')) {
      return;
    }

    setRepairingDeploymentDrift(action);
    setError(null);
    setMessage(null);

    try {
      const result = await api.repairDeploymentDrift(detailApp.id, action);
      if (result.drift) {
        setDeploymentDrift(result.drift);
      }
      setMessage(
        result.proxySync
          ? `${proxySyncMessage(result.proxySync)} Deployment repair completed.`
          : 'Deployment repair completed.'
      );
      await load();
      setDeploymentStatus(await api.deploymentStatus(detailApp.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRepairingDeploymentDrift(null);
    }
  }

  async function runDeploymentAction(action: 'start' | 'stop' | 'restart' | 'pull' | 'redeploy') {
    if (!detailApp) {
      return;
    }

    setDeploymentAction(action);
    setError(null);
    setMessage(null);

    try {
      const status = await api.manageDeployment(detailApp.id, action);
      setDeploymentStatus(status);
      setMessage(`${action[0].toUpperCase()}${action.slice(1)} command completed for ${status.resourceName}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeploymentAction(null);
    }
  }

  async function viewDeploymentLogs() {
    if (!detailApp) {
      return;
    }

    setLoadingDeploymentLogs(true);
    setError(null);
    setMessage(null);

    try {
      setDeploymentLogs(await api.deploymentLogs(detailApp.id, 300));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDeploymentLogs(false);
    }
  }

  async function openRedeployPreview() {
    if (!detailApp) {
      return;
    }

    setLoadingRedeployPreview(true);
    setError(null);
    setMessage(null);

    try {
      setRedeployPreview(await api.redeployPreview(detailApp.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingRedeployPreview(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);

    try {
      if (editingId) {
        const result = await api.updateApp(editingId, form);
        setMessage(proxySyncMessage(result.proxySync));
      } else {
        const result = await api.createApp({
          ...form,
          sortOrder: apps.length
        });
        setMessage(proxySyncMessage(result.proxySync));
      }

      setEditingId(null);
      setForm(initialForm);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteApp(app: ContainerApp) {
    const confirmation = app.managedDeployment
      ? `Delete ${app.name} and remove its Docker container? This will also free its published port.`
      : `Delete ${app.name}?`;

    if (!window.confirm(confirmation)) {
      return;
    }

    setError(null);
    setMessage(null);

    try {
      const result = await api.deleteApp(app.id);
      setMessage(
        result.deployment
          ? `${proxySyncMessage(result.proxySync)} Removed Docker container ${result.deployment.resourceName}.`
          : proxySyncMessage(result.proxySync)
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function syncProxy() {
    setSyncing(true);
    setError(null);
    setMessage(null);

    try {
      const result = await api.syncProxy();
      setMessage(
        result.status === 'success'
          ? 'Caddy configuration synced.'
          : result.status === 'skipped'
            ? 'Caddy sync skipped because it is disabled in the API environment.'
            : `Caddy sync failed: ${result.errorMessage ?? 'Unknown error'}`
      );
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function moveApp(app: ContainerApp, direction: -1 | 1) {
    const index = allSortedApps.findIndex((item) => item.id === app.id);
    const target = index + direction;

    if (target < 0 || target >= allSortedApps.length) {
      return;
    }

    const ids = allSortedApps.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];

    try {
      const result = await api.reorderApps(ids);
      setApps(result.apps);
      setMessage(proxySyncMessage(result.proxySync));
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function exportApps() {
    try {
      const data = await api.exportApps();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `the-containers-apps-${data.exportedAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage('Apps exported.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function importApps(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    if (!window.confirm('Importing will replace all configured apps. Continue?')) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { apps?: unknown[] } | unknown[];
      const importedApps = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.apps)
          ? parsed.apps
          : [];

      if (importedApps.length === 0) {
        throw new Error('Import file does not contain apps.');
      }

      const result = await api.importApps(importedApps);
      setApps(result.apps);
      setMessage(proxySyncMessage(result.proxySync));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function exportBackup() {
    try {
      const data = await api.backup();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `the-containers-backup-${data.exportedAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      const dockerDataFiles = data.dockerDataArchives.reduce(
        (total, archive) => total + archive.files.length,
        0
      );
      setMessage(
        `Backup exported with ${data.apps.length} apps, ${data.deployments.length} deployments, ${data.deploymentFiles.length} deployment files, ${data.dockerProjectFiles.length} Docker project files, and ${dockerDataFiles} Docker data files.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function restoreBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    if (!window.confirm('Restoring a backup will replace apps, settings, and managed deployment records. Continue?')) {
      return;
    }

    try {
      const result = await api.restoreBackup(JSON.parse(await file.text()));
      setApps(result.apps);
      setSettings(result.settings);
      setMessage(
        `${proxySyncMessage(result.proxySync)} Restored ${result.deployments} managed deployment records, ${result.deploymentFiles} deployment files, ${result.dockerProjectFiles} Docker project files, and ${result.dockerDataFiles} Docker data files. A pre-restore snapshot was saved.`
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runDnsDiagnostic() {
    setDnsResult(null);
    setError(null);

    try {
      setDnsResult(await api.dnsDiagnostic(dnsHost.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function scanLocalServices() {
    setScanningServices(true);
    setError(null);

    try {
      const result = await api.localServices();
      setLocalServices(result.services);
      setMessage(`Found ${result.services.length} listening local ports.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanningServices(false);
    }
  }

  async function checkDeployPermission(showResult = true) {
    setCheckingDeployPermission(true);
    setError(null);

    try {
      const result = await api.deployDoctor(deployPayload());
      setDeployDoctor(result);

      if (showResult) {
        setMessage(
          result.ok
            ? result.userHelpRequired
              ? 'Deploy can run, but this command needs user review.'
              : 'Deploy permissions are ready.'
            : 'Deploy needs host permission. Follow the commands in the permission panel.'
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingDeployPermission(false);
    }
  }

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setMessage('Command copied.');
      setError(null);
    } catch {
      setError('Could not copy command from this browser.');
    }
  }

  async function previewDeploy() {
    if (selectedDeployMethod.status !== 'available') {
      setError(`${selectedDeployMethod.title} is planned. Docker run, Docker Compose, and Binary/service are available now.`);
      return;
    }

    setPreviewingDeploy(true);
    setError(null);
    setMessage(null);

    try {
      const plan = await api.previewDeploy(deployPayload());
      setDeployPlan(plan);
      setMessage(`Prepared ${plan.containerName} -> ${plan.targetUrl}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewingDeploy(false);
    }
  }

  async function deployDockerRun() {
    if (selectedDeployMethod.status !== 'available') {
      setError(`${selectedDeployMethod.title} is planned. Docker run, Docker Compose, and Binary/service are available now.`);
      return;
    }

    const currentDoctor = deployDoctor ?? await api.deployDoctor(deployPayload());
    setDeployDoctor(currentDoctor);

    if (currentDoctor.ok === false) {
      setError('Deploy needs host permission first. Run the commands in the permission panel, then click Recheck.');
      return;
    }

    const confirmation = currentDoctor.userHelpRequired
      ? 'This command needs user review because it requests host-level access. Deploy it and create a public route?'
      : deployForm.method === 'binary_service'
        ? 'Start this binary service and create a public route?'
        : deployForm.method === 'static_site'
          ? 'Serve this static folder and create a public route?'
        : 'Deploy this Docker container and create a public route?';

    if (!window.confirm(confirmation)) {
      return;
    }

    setDeploying(true);
    setError(null);
    setMessage(null);

    try {
      const result = await api.deployDockerRun(deployPayload());
      setDeployPlan(result.plan);
      setDeploySuccess(result);
      setShowDeployDialog(false);
      setMessage(proxySyncMessage(result.proxySync));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeploying(false);
    }
  }

  function useLocalService(service: LocalService) {
    setEditingId(null);
    setForm({
      ...initialForm,
      name: serviceName(service),
      targetUrl: service.targetUrl,
      publicHost: serviceHost(service),
      category: service.processName ? 'Local' : null,
      sortOrder: apps.length
    });
    setMessage(`Prepared ${service.targetUrl}. Review the host name and save it.`);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function saveSettings(patch: Partial<ContainerSettings>) {
    try {
      const result = await api.updateSettings(patch);
      const next = result.settings;
      setSettings(next);
      setCustomCaddyRoutesText(JSON.stringify(next.customCaddyRoutes ?? [], null, 2));
      setProxyDiagnostics(await api.proxyDiagnostics().catch(() => null));
      setAuditLogs(await api.auditLogs().catch(() => []));
      setMessage(proxySyncMessage(result.proxySync));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveCustomCaddyRoutes() {
    try {
      const parsed = JSON.parse(customCaddyRoutesText) as unknown;

      if (!Array.isArray(parsed)) {
        throw new Error('Custom Caddy routes must be a JSON array.');
      }

      await saveSettings({
        customCaddyRoutes: parsed as Record<string, unknown>[]
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="grid gap-6 pb-20 lg:grid-cols-[minmax(0,420px),1fr] sm:pb-0">
      <section>
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold uppercase text-spruce dark:text-[#86d8c6]">
              Admin
            </p>
            <h1 className="mt-2 text-2xl font-bold tracking-normal">Services</h1>
            {editingId ? (
              <p className="mt-1 text-sm text-black/55 dark:text-[#b8c7c1]">
                Editing existing app
              </p>
            ) : null}
          </div>
          <button
            className="h-10 rounded border border-black/10 bg-white px-3 text-sm font-semibold text-black/65 transition hover:text-black dark:border-white/15 dark:bg-[#18211e] dark:text-[#d7e4df] dark:hover:border-[#8fe0ce]/40 dark:hover:text-white"
            onClick={onBack}
          >
            Dashboard
          </button>
        </div>

        {authRequired ? (
          <div className="mb-4 rounded border border-amber/30 bg-amber/10 p-3 dark:border-amber/40 dark:bg-amber/15">
            <label className="label" htmlFor="adminToken">
              Admin token
            </label>
            <div className="flex gap-2">
              <input
                id="adminToken"
                className="field"
                type="password"
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder="Required for admin actions"
              />
              <button
                className="grid h-11 w-11 shrink-0 place-items-center rounded bg-ink text-white transition hover:bg-spruce dark:bg-[#dff3ec] dark:text-[#0f1714]"
                type="button"
                onClick={saveToken}
                title="Save token"
                aria-label="Save token"
              >
                <Shield size={18} />
              </button>
            </div>
          </div>
        ) : null}

        <form className="panel p-4" onSubmit={submit}>
          <div className="grid gap-4">
            <div>
              <label className="label" htmlFor="name">
                App name
              </label>
              <input
                id="name"
                className="field"
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
                placeholder="Jellyfin"
                required
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-[120px,minmax(0,1fr)]">
              <div>
                <label className="label" htmlFor="iconType">
                  Icon
                </label>
                <select
                  id="iconType"
                  className="field"
                  value={form.iconType}
                  onChange={(event) =>
                    update('iconType', event.target.value as AppPayload['iconType'])
                  }
                >
                  <option value="emoji">Emoji</option>
                  <option value="url">URL</option>
                  <option value="builtin">Built in</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="iconValue">
                  Icon value
                </label>
                <input
                  id="iconValue"
                  className="field"
                  value={form.iconValue ?? ''}
                  onChange={(event) => update('iconValue', event.target.value || null)}
                  placeholder="Emoji, built-in name, or https://..."
                />
              </div>
            </div>

            <div>
              <label className="label" htmlFor="targetUrl">
                LAN target URL
              </label>
              <input
                id="targetUrl"
                className="field"
                value={form.targetUrl}
                onChange={(event) => update('targetUrl', event.target.value)}
                placeholder="http://192.168.1.20:8096"
                required
              />
            </div>

            <div>
              <span className="label">Access mode</span>
              <div className="grid grid-cols-2 gap-2 rounded border border-black/10 bg-[#f1f5f3] p-1 dark:border-white/15 dark:bg-[#18211e]">
                {(['subdomain', 'subpath'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`h-10 rounded text-sm font-semibold transition ${
                      form.routeMode === mode
                        ? 'bg-white text-spruce shadow-sm dark:bg-[#24312d] dark:text-[#f4fbf8]'
                        : 'text-black/55 hover:text-black dark:text-[#b8c7c1] dark:hover:text-[#f4fbf8]'
                    }`}
                    onClick={() => setRouteMode(mode)}
                  >
                    {mode === 'subdomain' ? 'Subdomain' : 'Subpath'}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="label" htmlFor="publicHost">
                Public host
              </label>
              <input
                id="publicHost"
                className="field"
                value={form.publicHost}
                onChange={(event) => update('publicHost', event.target.value)}
                placeholder="jellyfin.lab.home"
                required
              />
              {form.routeMode === 'subdomain' ? (
                <p className="mt-2 text-xs leading-5 text-black/50 dark:text-[#a9bbb4]">
                  Use app-first names like homebridge.lab.home, and point either
                  that host or *.lab.home to the machine running The Containers in local DNS.
                </p>
              ) : null}
            </div>

            {form.routeMode === 'subpath' ? (
              <>
                <div>
                  <label className="label" htmlFor="publicPath">
                    Public path
                  </label>
                  <input
                    id="publicPath"
                    className="field"
                    value={form.publicPath ?? ''}
                    onChange={(event) =>
                      update('publicPath', event.target.value || null)
                    }
                    placeholder="/jellyfin"
                    required
                  />
                </div>
                <RouteModeWarning />
              </>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="category">
                  Category
                </label>
                <input
                  id="category"
                  className="field"
                  value={form.category ?? ''}
                  onChange={(event) => update('category', event.target.value || null)}
                  placeholder="Media"
                />
              </div>
              <div>
                <label className="label" htmlFor="tags">
                  Tags
                </label>
                <input
                  id="tags"
                  className="field"
                  value={form.tags.join(', ')}
                  onChange={(event) =>
                    update(
                      'tags',
                      event.target.value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                    )
                  }
                  placeholder="nas, video"
                />
              </div>
            </div>

            <label className="flex items-center gap-3 text-sm font-medium text-black/70 dark:text-[#d7e4df]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-spruce"
                checked={form.favorite}
                onChange={(event) => update('favorite', event.target.checked)}
              />
              Favorite
            </label>

            <label className="flex items-center gap-3 text-sm font-medium text-black/70 dark:text-[#d7e4df]">
              <input
                type="checkbox"
                className="h-4 w-4 accent-spruce"
                checked={form.enabled}
                onChange={(event) => update('enabled', event.target.checked)}
              />
              Enabled on dashboard and proxy
            </label>
          </div>

          {error ? (
            <div className="mt-4 rounded border border-coral/30 bg-coral/10 p-3 text-sm text-coral">
              {error}
            </div>
          ) : null}
          {message ? (
            <div className="mt-4 rounded border border-spruce/25 bg-spruce/10 p-3 text-sm text-spruce dark:border-[#8fe0ce]/25 dark:bg-[#8fe0ce]/10 dark:text-[#9be8d7]">
              {message}
            </div>
          ) : null}

          <button
            className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded bg-spruce px-4 text-sm font-semibold text-white transition hover:bg-[#11564a] disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
            disabled={saving}
          >
            <Save size={18} />
            {saving ? 'Saving...' : editingId ? 'Update app' : 'Save app'}
          </button>

          {editingId ? (
            <button
              className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded border border-black/10 bg-white px-4 text-sm font-semibold text-black/65 transition hover:text-black dark:border-white/15 dark:bg-[#18211e] dark:text-[#d7e4df] dark:hover:border-[#8fe0ce]/40 dark:hover:text-white"
              type="button"
              onClick={resetForm}
            >
              <X size={18} />
              Cancel editing
            </button>
          ) : (
            <button
              className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded border border-black/10 bg-white px-4 text-sm font-semibold text-black/65 transition hover:text-black dark:border-white/15 dark:bg-[#18211e] dark:text-[#d7e4df] dark:hover:border-[#8fe0ce]/40 dark:hover:text-white"
              type="button"
              onClick={resetForm}
            >
              <Plus size={18} />
              New app
            </button>
          )}
        </form>

        {healthHistory.length > 0 ? (
          <section className="panel mt-4 p-4">
            <h3 className="mb-3 text-sm font-semibold">Health history</h3>
            <div className="space-y-2">
              {healthHistory.slice(0, 8).map((item) => (
                <div
                  key={`${item.checkedAt}-${item.statusCode ?? 'error'}`}
                  className="flex items-center justify-between gap-3 rounded border border-black/10 p-2 text-xs dark:border-white/15"
                >
                  <span
                    className={
                      item.ok
                        ? 'font-semibold text-spruce dark:text-[#9be8d7]'
                        : 'font-semibold text-coral dark:text-[#ff9b8c]'
                    }
                  >
                    {item.ok ? item.statusCode ?? 'OK' : item.error ?? 'Offline'}
                  </span>
                  <span className="text-black/45 dark:text-[#9fb0aa]">
                    {item.responseTimeMs}ms · {new Date(item.checkedAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </section>

      <section>
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase text-black/45 dark:text-[#a9bbb4]">
              Current apps
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-normal">
              {apps.length} configured
            </h2>
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <button
              className="inline-flex h-10 items-center gap-2 rounded border border-black/10 bg-white px-3 text-sm font-semibold text-black/65 transition hover:text-black disabled:opacity-60 dark:border-white/15 dark:bg-[#18211e] dark:text-[#d7e4df] dark:hover:border-[#8fe0ce]/40 dark:hover:text-white"
              onClick={() => void exportApps()}
              title="Export apps"
              aria-label="Export apps"
            >
              <Download size={16} />
              Apps JSON
            </button>
            <label
              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded border border-black/10 bg-white px-3 text-sm font-semibold text-black/65 transition hover:text-black dark:border-white/15 dark:bg-[#18211e] dark:text-[#d7e4df] dark:hover:border-[#8fe0ce]/40 dark:hover:text-white"
              title="Import apps"
              aria-label="Import apps"
            >
              <Upload size={16} />
              Import Apps
              <input
                className="sr-only"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importApps(event)}
              />
            </label>
            <button
              className="inline-flex h-10 items-center gap-2 rounded border border-spruce/20 bg-spruce/10 px-3 text-sm font-semibold text-spruce transition hover:border-spruce/40 dark:border-[#8fe0ce]/25 dark:bg-[#8fe0ce]/10 dark:text-[#9be8d7]"
              onClick={() => void exportBackup()}
              title="Export full backup"
              aria-label="Export full backup"
            >
              <Download size={16} />
              Full Backup
            </button>
            <label
              className="inline-flex h-10 cursor-pointer items-center gap-2 rounded border border-amber/30 bg-amber/10 px-3 text-sm font-semibold text-amber transition hover:border-amber/50"
              title="Restore backup"
              aria-label="Restore backup"
            >
              <Upload size={16} />
              Restore
              <input
                className="sr-only"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void restoreBackup(event)}
              />
            </label>
            <button
              className="inline-flex h-10 items-center gap-2 rounded border border-black/10 bg-white px-3 text-sm font-semibold text-black/65 transition hover:text-black disabled:opacity-60 dark:border-white/15 dark:bg-[#18211e] dark:text-[#d7e4df] dark:hover:border-[#8fe0ce]/40 dark:hover:text-white"
              onClick={() => void syncProxy()}
              disabled={syncing}
            >
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
              Sync
            </button>
          </div>
        </div>

        <div className="mb-4 grid gap-3 rounded border border-black/10 bg-white p-3 dark:border-white/15 dark:bg-[#141d1a] md:grid-cols-[minmax(0,1fr),180px,auto]">
          <input
            className="field"
            value={appSearch}
            onChange={(event) => setAppSearch(event.target.value)}
            placeholder="Search apps, hosts, tags"
          />
          <select
            className="field"
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
          <label className="flex h-11 items-center gap-2 text-sm font-medium text-black/70 dark:text-[#d7e4df]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-spruce"
              checked={favoriteOnly}
              onChange={(event) => setFavoriteOnly(event.target.checked)}
            />
            Favorites
          </label>
        </div>

        {apps.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sortedApps.map((app, index) => (
              <AppCard
                key={app.id}
                app={app}
                status={statuses[app.id]}
                onEdit={editApp}
                onDelete={deleteApp}
                onDetails={openDetails}
                onMoveUp={index > 0 ? (item) => void moveApp(item, -1) : undefined}
                onMoveDown={
                  index < sortedApps.length - 1
                    ? (item) => void moveApp(item, 1)
                    : undefined
                }
              />
            ))}
          </div>
        ) : (
          <div className="rounded border border-dashed border-black/20 bg-white p-8 text-center text-sm text-black/55 dark:border-white/20 dark:bg-[#141d1a] dark:text-[#b8c7c1]">
            No services have been configured.
          </div>
        )}

        {detailApp ? (
          <section className="panel mt-4 p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase text-black/45 dark:text-[#a9bbb4]">
                  App details
                </p>
                <h3 className="mt-1 text-xl font-semibold">{detailApp.name}</h3>
              </div>
              <button
                className="grid h-9 w-9 place-items-center rounded text-black/45 transition hover:bg-black/5 hover:text-black dark:text-[#a9bbb4] dark:hover:bg-white/10 dark:hover:text-white"
                onClick={() => setDetailAppId(null)}
                title="Close details"
                aria-label="Close details"
              >
                <X size={17} />
              </button>
            </div>
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <div className="rounded border border-black/10 p-3 dark:border-white/15">
                <div className="label">Public route</div>
                <div className="break-all font-medium">
                  {detailApp.routeMode === 'subdomain'
                    ? detailApp.publicHost
                    : `${detailApp.publicHost}${detailApp.publicPath}`}
                </div>
              </div>
              <div className="rounded border border-black/10 p-3 dark:border-white/15">
                <div className="label">Target</div>
                <div className="break-all font-medium">{detailApp.targetUrl}</div>
              </div>
              <div className="rounded border border-black/10 p-3 dark:border-white/15">
                <div className="label">Metadata</div>
                <div className="text-black/60 dark:text-[#b8c7c1]">
                  {detailApp.category ?? 'No category'}
                  {detailApp.tags.length > 0 ? ` · ${detailApp.tags.join(', ')}` : ''}
                </div>
              </div>
              <div className="rounded border border-black/10 p-3 dark:border-white/15">
                <div className="label">Latest health</div>
                <div
                  className={
                    statuses[detailApp.id]?.ok
                      ? 'font-semibold text-spruce dark:text-[#9be8d7]'
                      : 'font-semibold text-coral dark:text-[#ff9b8c]'
                  }
                >
                  {statuses[detailApp.id]
                    ? statuses[detailApp.id].ok
                      ? `${statuses[detailApp.id].statusCode ?? 'OK'} in ${
                          statuses[detailApp.id].responseTimeMs
                        }ms`
                      : statuses[detailApp.id].error ?? 'Offline'
                    : 'Not checked yet'}
                </div>
              </div>
            </div>
            {detailApp.managedDeployment ? (
              <div className="mt-4 rounded border border-black/10 p-3 text-sm dark:border-white/15">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="label">Self-host deployment</div>
                    {deploymentStatus ? (
                      <div className="mt-1 space-y-1">
                        <div className="font-medium">
                          {deploymentStatus.resourceName}
                          <span
                            className={`ml-2 rounded px-2 py-0.5 text-xs ${
                              deploymentStatus.runtime.running
                                ? 'bg-spruce/10 text-spruce dark:bg-[#8fe0ce]/10 dark:text-[#9be8d7]'
                                : 'bg-coral/10 text-coral dark:bg-[#ff9b8c]/10 dark:text-[#ffb1a5]'
                            }`}
                          >
                            {deploymentStatus.runtime.state}
                          </span>
                        </div>
                        <div className="text-xs text-black/55 dark:text-[#b8c7c1]">
                          {deploymentStatus.provider === 'docker_compose'
                            ? `Docker Compose · ${deploymentStatus.runtime.kind === 'docker_compose' ? deploymentStatus.runtime.composeFilePath : ''}`
                            : deploymentStatus.provider === 'binary_service'
                              ? `Local daemon · ${deploymentStatus.runtime.kind === 'binary_service' ? deploymentStatus.runtime.command : ''}`
                            : `Docker container · ${deploymentStatus.runtime.kind === 'docker' ? deploymentStatus.runtime.containerId.slice(0, 12) : ''}`}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-1 text-black/55 dark:text-[#b8c7c1]">
                        Loading deployment status...
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn-secondary h-9"
                      onClick={() => void checkDeploymentDrift()}
                      disabled={checkingDeploymentDrift}
                      title="Check deployment drift"
                    >
                      <Shield
                        size={15}
                        className={checkingDeploymentDrift ? 'animate-pulse' : ''}
                      />
                      {checkingDeploymentDrift ? 'Checking' : 'Check'}
                    </button>
                    <button
                      className="btn-secondary h-9"
                      onClick={() => void viewDeploymentLogs()}
                      disabled={loadingDeploymentLogs}
                      title="View deployment logs"
                    >
                      <Terminal size={15} />
                      {loadingDeploymentLogs ? 'Loading' : 'Logs'}
                    </button>
                    <button
                      className="btn-secondary h-9"
                      onClick={() => void runDeploymentAction('pull')}
                      disabled={Boolean(deploymentAction) || deploymentStatus?.provider === 'binary_service'}
                      title={deploymentStatus?.provider === 'binary_service' ? 'Local daemons do not support image pull' : 'Pull latest image'}
                    >
                      <Download
                        size={15}
                        className={deploymentAction === 'pull' ? 'animate-pulse' : ''}
                      />
                      {deploymentAction === 'pull' ? 'Pulling' : 'Pull'}
                    </button>
                    <button
                      className="btn-secondary h-9"
                      onClick={() => void openRedeployPreview()}
                      disabled={Boolean(deploymentAction) || loadingRedeployPreview}
                      title="Pull latest image and recreate deployment"
                    >
                      <RefreshCw
                        size={15}
                        className={
                          deploymentAction === 'redeploy' || loadingRedeployPreview
                            ? 'animate-spin'
                            : ''
                        }
                      />
                      {deploymentAction === 'redeploy'
                        ? 'Redeploying'
                        : loadingRedeployPreview
                          ? 'Checking'
                          : 'Redeploy'}
                    </button>
                    <button
                      className="btn-secondary h-9"
                      onClick={() => void runDeploymentAction('start')}
                      disabled={Boolean(deploymentAction)}
                      title="Start deployment"
                    >
                      <Rocket size={15} />
                      {deploymentAction === 'start' ? 'Starting' : 'Start'}
                    </button>
                    <button
                      className="btn-secondary h-9"
                      onClick={() => void runDeploymentAction('restart')}
                      disabled={Boolean(deploymentAction)}
                      title="Restart deployment"
                    >
                      <RefreshCw
                        size={15}
                        className={deploymentAction === 'restart' ? 'animate-spin' : ''}
                      />
                      {deploymentAction === 'restart' ? 'Restarting' : 'Restart'}
                    </button>
                    <button
                      className="btn-secondary h-9"
                      onClick={() => void runDeploymentAction('stop')}
                      disabled={Boolean(deploymentAction)}
                      title="Stop deployment"
                    >
                      <Square size={14} />
                      {deploymentAction === 'stop' ? 'Stopping' : 'Stop'}
                    </button>
                  </div>
                </div>
                {deploymentDrift ? (
                  <div className="mt-3 rounded border border-black/10 bg-black/[0.02] p-3 dark:border-white/15 dark:bg-white/[0.03]">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="font-semibold">Deployment drift</div>
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${
                          deploymentDrift.status === 'pass'
                            ? 'bg-spruce/10 text-spruce dark:bg-[#8fe0ce]/10 dark:text-[#9be8d7]'
                            : deploymentDrift.status === 'warn'
                              ? 'bg-amber/10 text-amber'
                              : 'bg-coral/10 text-coral dark:bg-[#ff9b8c]/10 dark:text-[#ffb1a5]'
                        }`}
                      >
                        {deploymentDrift.status}
                      </span>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {deploymentDrift.checks.map((check) => (
                        <div
                          key={check.id}
                          className="rounded border border-black/10 p-2 text-xs dark:border-white/15"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold">{check.label}</span>
                            <span
                              className={
                                check.status === 'pass'
                                  ? 'text-spruce dark:text-[#9be8d7]'
                                  : check.status === 'warn'
                                    ? 'text-amber'
                                    : 'text-coral dark:text-[#ff9b8c]'
                              }
                            >
                              {check.status}
                            </span>
                          </div>
                          <div className="mt-1 break-all text-black/55 dark:text-[#b8c7c1]">
                            {check.detail}
                          </div>
                        </div>
                      ))}
                    </div>
                    {deploymentDrift.repairs.length > 0 ? (
                      <div className="mt-3 rounded border border-black/10 bg-white/70 p-3 dark:border-white/15 dark:bg-white/[0.04]">
                        <div className="mb-2 font-semibold">Repair actions</div>
                        <div className="flex flex-wrap gap-2">
                          {deploymentDrift.repairs.map((repair) => (
                            <button
                              key={repair.id}
                              className="btn-secondary h-9"
                              type="button"
                              onClick={() => void repairDeploymentDrift(repair.id)}
                              disabled={Boolean(repairingDeploymentDrift)}
                              title={repair.detail}
                            >
                              {repair.id === 'start' ? (
                                <Rocket size={15} />
                              ) : repair.id === 'redeploy' ? (
                                <RefreshCw
                                  size={15}
                                  className={
                                    repairingDeploymentDrift === repair.id ? 'animate-spin' : ''
                                  }
                                />
                              ) : (
                                <Save size={15} />
                              )}
                              {repairingDeploymentDrift === repair.id
                                ? 'Repairing'
                                : repair.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-2 text-xs text-black/45 dark:text-[#9fb0aa]">
                      Checked {new Date(deploymentDrift.checkedAt).toLocaleString()}
                    </div>
                  </div>
                ) : null}
                {deploymentStatus?.runtime.kind === 'docker_compose' &&
                deploymentStatus.runtime.containers.length > 0 ? (
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {deploymentStatus.runtime.containers.map((container) => (
                      <div
                        key={container.id || container.name}
                        className="rounded border border-black/10 p-2 text-xs dark:border-white/15"
                      >
                        <div className="font-semibold">{container.name || container.id}</div>
                        <div className="mt-1 text-black/55 dark:text-[#b8c7c1]">
                          {container.image} · {container.status}
                        </div>
                        {container.ports ? (
                          <div className="mt-1 break-all text-black/45 dark:text-[#9fb0aa]">
                            {container.ports}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {detailHistory.length > 0 ? (
              <div className="mt-4 grid gap-2 md:grid-cols-2">
                {detailHistory.slice(0, 6).map((item) => (
                  <div
                    key={`${item.checkedAt}-${item.statusCode ?? 'error'}`}
                    className="flex items-center justify-between gap-3 rounded border border-black/10 p-2 text-xs dark:border-white/15"
                  >
                    <span
                      className={
                        item.ok
                          ? 'font-semibold text-spruce dark:text-[#9be8d7]'
                          : 'font-semibold text-coral dark:text-[#ff9b8c]'
                      }
                    >
                      {item.ok ? item.statusCode ?? 'OK' : item.error ?? 'Offline'}
                    </span>
                    <span className="text-black/45 dark:text-[#9fb0aa]">
                      {item.responseTimeMs}ms · {new Date(item.checkedAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {showDeployDialog ? (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-sm"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setShowDeployDialog(false);
              }
            }}
          >
            <section
              className="panel max-h-[min(720px,calc(100vh-2rem))] w-full max-w-4xl overflow-auto p-4 shadow-xl"
              role="dialog"
              aria-modal="true"
              aria-labelledby="deployDialogTitle"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 id="deployDialogTitle" className="text-sm font-semibold">
                    Deploy self-hosted app
                  </h3>
                  <p className="mt-1 text-xs text-black/50 dark:text-[#a9bbb4]">
                    Docker, binary services, auto port, and public route
                  </p>
                </div>
                <button
                  className="grid h-9 w-9 place-items-center rounded text-black/45 transition hover:bg-black/5 hover:text-black dark:text-[#a9bbb4] dark:hover:bg-white/10 dark:hover:text-white"
                  onClick={() => setShowDeployDialog(false)}
                  title="Close deploy dialog"
                  aria-label="Close deploy dialog"
                >
                  <X size={17} />
                </button>
              </div>

              <div className="grid gap-3">
              <div>
                <span className="label">Deploy method</span>
                <div className="grid gap-2 md:grid-cols-4">
                  {deployMethods.map((method) => (
                    <button
                      key={method.id}
                      type="button"
                      className={`rounded border p-3 text-left transition ${
                        deployForm.method === method.id
                          ? 'border-spruce bg-spruce/10 text-spruce dark:border-[#8fe0ce]/60 dark:bg-[#8fe0ce]/10 dark:text-[#9be8d7]'
                          : 'border-black/10 bg-white/70 text-black/60 hover:text-black dark:border-white/15 dark:bg-white/[0.04] dark:text-[#b8c7c1] dark:hover:text-white'
                      }`}
                      onClick={() => {
                        selectDeployMethod(method.id);
                      }}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">{method.title}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                            method.status === 'available'
                              ? 'bg-spruce/10 text-spruce dark:bg-[#8fe0ce]/10 dark:text-[#9be8d7]'
                              : 'bg-amber/10 text-amber'
                          }`}
                        >
                          {method.status === 'available' ? 'ready' : 'next'}
                        </span>
                      </span>
                      <span className="mt-1 block text-[11px] opacity-75">
                        {method.detail}
                      </span>
                    </button>
                  ))}
                </div>
                {selectedDeployMethod.status === 'planned' ? (
                  <div className="mt-2 rounded border border-amber/30 bg-amber/10 p-3 text-xs text-black/65 dark:text-[#d5caa2]">
                    {selectedDeployMethod.title} is queued for the universal GitHub deploy flow. Use Docker run, Docker Compose, or Binary/service now, or add the repo as an existing service after starting it manually.
                  </div>
                ) : null}
              </div>

              <div>
                <label className="label" htmlFor="deployCommand">
                  {deployForm.method === 'docker_run'
                    ? 'Docker command'
                    : deployForm.method === 'docker_compose'
                      ? 'Compose file'
                      : deployForm.method === 'binary_service'
                        ? 'Binary service command'
                        : deployForm.method === 'static_site'
                          ? 'Static folder path'
                        : `${selectedDeployMethod.title} input`}
                </label>
                <textarea
                  id="deployCommand"
                  className="field min-h-28 resize-y py-3"
                  value={deployForm.command}
                  onChange={(event) => updateDeployCommand(event.target.value)}
                  placeholder={
                    deployForm.method === 'docker_run'
                      ? 'docker run -d --name app -p 8080:80 image:tag'
                      : deployForm.method === 'docker_compose'
                        ? 'services:\n  app:\n    image: nginx:alpine\n    ports:\n      - "8080:80"'
                        : deployForm.method === 'binary_service'
                          ? '/usr/local/bin/my-service --port 8080'
                          : deployForm.method === 'static_site'
                            ? '/srv/sites/my-app/dist'
                          : 'This deploy method is planned'
                  }
                  disabled={selectedDeployMethod.status !== 'available'}
                />
                {deployForm.method === 'binary_service' ? (
                  <p className="mt-1 text-xs text-black/50 dark:text-[#a9bbb4]">
                    The command or service config must listen on the Service web port. The Containers verifies that port after start.
                  </p>
                ) : null}
                {deployForm.method === 'static_site' ? (
                  <p className="mt-1 text-xs text-black/50 dark:text-[#a9bbb4]">
                    Point to an already-built folder such as dist, build, or public. The folder is mounted read-only into nginx.
                  </p>
                ) : null}
              </div>

              <DeployHostPermissionSection
                deployDoctor={deployDoctor}
                checkingDeployPermission={checkingDeployPermission}
                checkDeployPermission={checkDeployPermission}
                copyCommand={copyCommand}
              />

              <div>
                <span className="label">Publish</span>
                <div className="grid gap-2 rounded border border-black/10 bg-[#f1f5f3] p-1 dark:border-white/15 dark:bg-[#18211e] md:grid-cols-2">
                  {[
                    {
                      id: 'reverse_proxy' as const,
                      title: 'Reverse proxy',
                      detail: 'Bind an internal host through Caddy'
                    },
                    {
                      id: 'public_domain_reverse_proxy' as const,
                      title: 'Public domain + proxy',
                      detail: 'Bind a real domain and reverse proxy'
                    }
                  ].map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      className={`rounded px-3 py-2 text-left transition ${
                        deployForm.publishMode === mode.id
                          ? 'bg-white text-spruce shadow-sm dark:bg-[#24312d] dark:text-[#f4fbf8]'
                          : 'text-black/60 hover:text-black dark:text-[#b8c7c1] dark:hover:text-[#f4fbf8]'
                      }`}
                      onClick={() => {
                        updateDeploy('publishMode', mode.id);
                      }}
                    >
                      <span className="block text-xs font-semibold">{mode.title}</span>
                      <span className="mt-1 block text-[11px] opacity-75">{mode.detail}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <label className="label" htmlFor="deployName">
                    App name
                  </label>
                  <input
                    id="deployName"
                    className="field"
                    value={deployForm.name ?? ''}
                    onChange={(event) =>
                      updateDeploy('name', event.target.value || undefined)
                    }
                    placeholder="Optional"
                  />
                </div>
                <div>
                  <label className="label" htmlFor="deployPublicHost">
                    {deployForm.publishMode === 'public_domain_reverse_proxy'
                      ? 'Public domain'
                      : 'Proxy host'}
                  </label>
                  <input
                    id="deployPublicHost"
                    className="field"
                    value={deployForm.publicHost}
                    onChange={(event) =>
                      updateDeploy('publicHost', event.target.value)
                    }
                    placeholder={
                      deployForm.publishMode === 'public_domain_reverse_proxy'
                        ? 'app.example.com'
                        : 'app.lab.home'
                    }
                  />
                </div>
                <div>
                  <label className="label" htmlFor="deployCategory">
                    Category
                  </label>
                  <input
                    id="deployCategory"
                    className="field"
                    value={deployForm.category ?? ''}
                    onChange={(event) =>
                      updateDeploy('category', event.target.value || null)
                    }
                    placeholder="Self-hosted"
                  />
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-[160px,1fr,1fr,1fr]">
                <div>
                  <span className="label">Route</span>
                  <div className="grid grid-cols-2 gap-1 rounded border border-black/10 bg-[#f1f5f3] p-1 dark:border-white/15 dark:bg-[#18211e]">
                    {(['subdomain', 'subpath'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`h-9 rounded text-xs font-semibold transition ${
                          deployForm.routeMode === mode
                            ? 'bg-white text-spruce shadow-sm dark:bg-[#24312d] dark:text-[#f4fbf8]'
                            : 'text-black/55 hover:text-black dark:text-[#b8c7c1] dark:hover:text-[#f4fbf8]'
                        }`}
                        onClick={() =>
                          {
                            setDeployForm((current) => ({
                              ...current,
                              routeMode: mode,
                              publicPath:
                                mode === 'subpath'
                                  ? current.publicPath ?? '/app'
                                  : null
                            }));
                            setDeployPlan(null);
                            setDeployDoctor(null);
                          }
                        }
                      >
                        {mode === 'subdomain' ? 'Sub' : 'Path'}
                      </button>
                    ))}
                  </div>
                </div>
                {deployForm.routeMode === 'subpath' ? (
                  <div>
                    <label className="label" htmlFor="deployPublicPath">
                      Public path
                    </label>
                    <input
                      id="deployPublicPath"
                      className="field"
                      value={deployForm.publicPath ?? ''}
                      onChange={(event) =>
                        updateDeploy('publicPath', event.target.value || null)
                      }
                      placeholder="/app"
                    />
                  </div>
                ) : null}
                <div>
                  <label className="label" htmlFor="deployHostPort">
                    {deployForm.method === 'binary_service' ? 'Service web port' : 'Host port'}
                  </label>
                  <input
                    id="deployHostPort"
                    className="field"
                    type="number"
                    min={1}
                    max={65535}
                    value={
                      deployForm.method === 'binary_service'
                        ? deployForm.hostPort ?? deployForm.containerPort ?? ''
                        : deployForm.hostPort ?? ''
                    }
                    onChange={(event) => {
                      const port = event.target.value ? Number(event.target.value) : null;
                      if (deployForm.method === 'binary_service') {
                        updateBinaryServicePort(port);
                        return;
                      }
                      updateDeploy('hostPort', port);
                    }}
                    placeholder={deployForm.method === 'binary_service' ? '8080' : 'Auto'}
                  />
                  {deployForm.method === 'binary_service' ? (
                    <p className="mt-1 text-xs text-black/50 dark:text-[#a9bbb4]">
                      Must match the port the service really opens. For example, if the daemon still listens on 8080, enter 8080 or change that daemon's own config first.
                    </p>
                  ) : null}
                </div>
                {deployForm.method === 'binary_service' ? null : (
                  <div>
                    <label className="label" htmlFor="deployContainerPort">
                      {deployForm.method === 'static_site' ? 'Nginx port' : 'Container port'}
                    </label>
                    <input
                      id="deployContainerPort"
                      className="field"
                      type="number"
                      min={1}
                      max={65535}
                      value={deployForm.containerPort ?? ''}
                      onChange={(event) =>
                        updateDeploy(
                          'containerPort',
                          event.target.value ? Number(event.target.value) : null
                        )
                      }
                      placeholder={deployForm.method === 'static_site' ? '80' : 'From -p'}
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="label" htmlFor="deployTags">
                  Tags
                </label>
                <input
                  id="deployTags"
                  className="field"
                  value={deployForm.tags.join(', ')}
                  onChange={(event) =>
                    updateDeploy(
                      'tags',
                      event.target.value
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean)
                    )
                  }
                  placeholder="docker, media"
                />
              </div>

              {deployPlan ? (
                <div className="grid gap-2 rounded border border-black/10 bg-black/[0.02] p-3 text-xs dark:border-white/15 dark:bg-white/[0.03] md:grid-cols-4">
                  <div>
                    <div className="label">Container</div>
                    <div className="break-all font-semibold">
                      {deployPlan.containerName}
                    </div>
                  </div>
                  <div>
                    <div className="label">Image</div>
                    <div className="break-all font-semibold">
                      {deployPlan.image}
                    </div>
                  </div>
                  <div>
                    <div className="label">Route target</div>
                    <div className="break-all font-semibold">
                      {deployPlan.targetUrl}
                    </div>
                  </div>
                  <div>
                    <div className="label">Publish</div>
                    <div className="break-all font-semibold">
                      {deployPlan.publishMode === 'public_domain_reverse_proxy'
                        ? 'Public domain + proxy'
                        : 'Reverse proxy'}
                    </div>
                  </div>
                  {deployPlan.warnings.length > 0 ? (
                    <div className="text-amber md:col-span-4">
                      {deployPlan.warnings.join(' ')}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {error ? (
                <div className="rounded border border-coral/30 bg-coral/10 p-3 text-sm text-coral">
                  {error}
                </div>
              ) : null}
              {message ? (
                <div className="rounded border border-spruce/25 bg-spruce/10 p-3 text-sm text-spruce dark:border-[#8fe0ce]/25 dark:bg-[#8fe0ce]/10 dark:text-[#9be8d7]">
                  {message}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  className="inline-flex h-10 items-center gap-2 rounded border border-black/10 bg-white px-3 text-sm font-semibold text-black/65 transition hover:text-black disabled:opacity-60 dark:border-white/15 dark:bg-[#18211e] dark:text-[#d7e4df] dark:hover:border-[#8fe0ce]/40 dark:hover:text-white"
                  onClick={() => void previewDeploy()}
                  disabled={
                    previewingDeploy ||
                    selectedDeployMethod.status !== 'available' ||
                    !deployForm.command.trim()
                  }
                >
                  <Search size={16} />
                  {previewingDeploy ? 'Previewing...' : 'Preview'}
                </button>
                <button
                  className="inline-flex h-10 items-center gap-2 rounded bg-spruce px-3 text-sm font-semibold text-white transition hover:bg-[#11564a] disabled:opacity-60"
                  onClick={() => void deployDockerRun()}
                  disabled={
                    deploying ||
                    checkingDeployPermission ||
                    selectedDeployMethod.status !== 'available' ||
                    !deployForm.command.trim() ||
                    deployDoctor?.ok === false
                  }
                >
                  <Rocket size={16} />
                  {deploying ? 'Deploying...' : 'Deploy'}
                </button>
              </div>
            </div>
          </section>
          </div>
        ) : null}

        {deploySuccess ? (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-sm"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setDeploySuccess(null);
              }
            }}
          >
            <section
              className="panel w-full max-w-lg p-4 shadow-xl"
              role="dialog"
              aria-modal="true"
              aria-labelledby="deploySuccessTitle"
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded bg-spruce/10 text-spruce dark:bg-[#8fe0ce]/10 dark:text-[#9be8d7]">
                    <CheckCircle2 size={20} />
                  </span>
                  <div>
                    <p className="text-xs font-semibold uppercase text-black/45 dark:text-[#a9bbb4]">
                      Deploy complete
                    </p>
                    <h3 id="deploySuccessTitle" className="mt-1 text-lg font-semibold">
                      {deploySuccess.app.name} is self-hosted
                    </h3>
                  </div>
                </div>
                <button
                  className="grid h-9 w-9 place-items-center rounded text-black/45 transition hover:bg-black/5 hover:text-black dark:text-[#a9bbb4] dark:hover:bg-white/10 dark:hover:text-white"
                  onClick={() => setDeploySuccess(null)}
                  title="Close deploy success"
                  aria-label="Close deploy success"
                >
                  <X size={17} />
                </button>
              </div>

              <div className="grid gap-2 text-sm">
                <div className="rounded border border-black/10 p-3 dark:border-white/15">
                  <div className="label">Public route</div>
                  <div className="break-all font-semibold">
                    {deploySuccess.app.routeMode === 'subdomain'
                      ? deploySuccess.app.publicHost
                      : `${deploySuccess.app.publicHost}${deploySuccess.app.publicPath ?? ''}`}
                  </div>
                </div>
                <div className="rounded border border-black/10 p-3 dark:border-white/15">
                  <div className="label">Container</div>
                  <div className="break-all font-semibold">
                    {deploySuccess.plan.containerName}
                  </div>
                </div>
                <div className="rounded border border-black/10 p-3 dark:border-white/15">
                  <div className="label">Target</div>
                  <div className="break-all font-semibold">
                    {deploySuccess.plan.targetUrl}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="inline-flex h-10 items-center gap-2 rounded bg-spruce px-3 text-sm font-semibold text-white transition hover:bg-[#11564a]"
                  type="button"
                  onClick={() => {
                    setDeploySuccess(null);
                    onBack();
                  }}
                >
                  <LayoutDashboard size={16} />
                  Dashboard
                </button>
                <button
                  className="inline-flex h-10 items-center gap-2 rounded border border-black/10 bg-white px-3 text-sm font-semibold text-black/65 transition hover:text-black dark:border-white/15 dark:bg-[#18211e] dark:text-[#d7e4df] dark:hover:border-[#8fe0ce]/40 dark:hover:text-white"
                  type="button"
                  onClick={() => window.open(appPublicUrl(deploySuccess.app), '_blank', 'noopener,noreferrer')}
                >
                  <ExternalLink size={16} />
                  Open app
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {deploymentLogs ? (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-sm"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setDeploymentLogs(null);
              }
            }}
          >
            <section
              className="panel flex max-h-[min(760px,calc(100vh-2rem))] w-full max-w-5xl flex-col p-4 shadow-xl"
              role="dialog"
              aria-modal="true"
              aria-labelledby="deploymentLogsTitle"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase text-black/45 dark:text-[#a9bbb4]">
                    Deployment logs
                  </p>
                  <h3 id="deploymentLogsTitle" className="mt-1 text-lg font-semibold">
                    {deploymentLogs.resourceName}
                  </h3>
                  <p className="mt-1 text-xs text-black/50 dark:text-[#a9bbb4]">
                    Last {deploymentLogs.tail} lines · {deploymentLogs.provider === 'docker_compose' ? 'Docker Compose' : deploymentLogs.provider === 'binary_service' ? 'Local daemon' : 'Docker'}
                  </p>
                </div>
                <button
                  className="grid h-9 w-9 place-items-center rounded text-black/45 transition hover:bg-black/5 hover:text-black dark:text-[#a9bbb4] dark:hover:bg-white/10 dark:hover:text-white"
                  onClick={() => setDeploymentLogs(null)}
                  title="Close logs"
                  aria-label="Close logs"
                >
                  <X size={17} />
                </button>
              </div>
              <pre className="min-h-[280px] overflow-auto rounded bg-[#101715] p-3 text-xs leading-relaxed text-[#d9eee7]">
                {deploymentLogs.logs || 'No logs returned.'}
              </pre>
            </section>
          </div>
        ) : null}

        {redeployPreview ? (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-sm"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setRedeployPreview(null);
              }
            }}
          >
            <section
              className="panel max-h-[min(760px,calc(100vh-2rem))] w-full max-w-3xl overflow-auto p-4 shadow-xl"
              role="dialog"
              aria-modal="true"
              aria-labelledby="redeployPreviewTitle"
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase text-black/45 dark:text-[#a9bbb4]">
                    Redeploy preview
                  </p>
                  <h3 id="redeployPreviewTitle" className="mt-1 text-lg font-semibold">
                    {redeployPreview.resourceName}
                  </h3>
                  <p className="mt-1 text-xs text-black/50 dark:text-[#a9bbb4]">
                    {redeployPreview.provider === 'docker_compose' ? 'Docker Compose' : redeployPreview.provider === 'binary_service' ? 'Local daemon' : 'Docker'} · {redeployPreview.currentState}
                  </p>
                </div>
                <button
                  className="grid h-9 w-9 place-items-center rounded text-black/45 transition hover:bg-black/5 hover:text-black dark:text-[#a9bbb4] dark:hover:bg-white/10 dark:hover:text-white"
                  onClick={() => setRedeployPreview(null)}
                  title="Close redeploy preview"
                  aria-label="Close redeploy preview"
                >
                  <X size={17} />
                </button>
              </div>

              <div className="grid gap-3 text-sm md:grid-cols-2">
                <div className="rounded border border-black/10 p-3 dark:border-white/15">
                  <div className="label">Image</div>
                  <div className="break-all font-semibold">
                    {redeployPreview.image ?? 'Unavailable'}
                  </div>
                </div>
                <div className="rounded border border-black/10 p-3 dark:border-white/15">
                  <div className="label">Target</div>
                  <div className="break-all font-semibold">
                    {redeployPreview.targetUrl ??
                      redeployPreview.composeFilePath ??
                      'Managed deployment'}
                  </div>
                </div>
                <div className="rounded border border-black/10 p-3 dark:border-white/15">
                  <div className="label">Port</div>
                  <div className="font-semibold">
                    {redeployPreview.hostPort && redeployPreview.containerPort
                      ? `${redeployPreview.hostPort}:${redeployPreview.containerPort}`
                      : 'Defined by Compose or host network'}
                  </div>
                </div>
                <div className="rounded border border-black/10 p-3 dark:border-white/15">
                  <div className="label">Result</div>
                  <div className={redeployPreview.canRedeploy ? 'font-semibold text-spruce dark:text-[#9be8d7]' : 'font-semibold text-coral dark:text-[#ff9b8c]'}>
                    {redeployPreview.canRedeploy ? 'Ready to redeploy' : 'Redeploy unavailable'}
                  </div>
                </div>
              </div>

              {redeployPreview.warnings.length > 0 ? (
                <div className="mt-3 rounded border border-amber/30 bg-amber/10 p-3 text-sm text-amber">
                  {redeployPreview.warnings.join(' ')}
                </div>
              ) : null}

              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <div className="rounded border border-black/10 p-3 dark:border-white/15">
                  <div className="label">Actions</div>
                  <ul className="space-y-1 text-xs text-black/60 dark:text-[#b8c7c1]">
                    {redeployPreview.actions.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded border border-black/10 p-3 dark:border-white/15">
                  <div className="label">Preserved</div>
                  <ul className="space-y-1 text-xs text-black/60 dark:text-[#b8c7c1]">
                    {redeployPreview.preserved.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded border border-black/10 p-3 dark:border-white/15">
                  <div className="label">Removed</div>
                  <ul className="space-y-1 text-xs text-black/60 dark:text-[#b8c7c1]">
                    {redeployPreview.removed.length > 0 ? (
                      redeployPreview.removed.map((item) => (
                        <li key={item}>{item}</li>
                      ))
                    ) : (
                      <li>Nothing is removed by preview.</li>
                    )}
                  </ul>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  className="btn-secondary h-10"
                  type="button"
                  onClick={() => setRedeployPreview(null)}
                >
                  Cancel
                </button>
                <button
                  className="inline-flex h-10 items-center gap-2 rounded bg-spruce px-3 text-sm font-semibold text-white transition hover:bg-[#11564a] disabled:opacity-60"
                  type="button"
                  disabled={!redeployPreview.canRedeploy || Boolean(deploymentAction)}
                  onClick={() => {
                    setRedeployPreview(null);
                    void runDeploymentAction('redeploy');
                  }}
                >
                  <RefreshCw
                    size={16}
                    className={deploymentAction === 'redeploy' ? 'animate-spin' : ''}
                  />
                  {deploymentAction === 'redeploy' ? 'Redeploying' : 'Redeploy'}
                </button>
              </div>
            </section>
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 lg:grid-cols-2">

          <section className="panel p-4 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Local host services</h3>
                <p className="mt-1 text-xs text-black/50 dark:text-[#a9bbb4]">
                  Listening TCP ports on this machine
                </p>
              </div>
              <button
                className="inline-flex h-9 items-center gap-2 rounded bg-ink px-3 text-sm font-semibold text-white transition hover:bg-spruce disabled:opacity-60 dark:bg-[#dff3ec] dark:text-[#0f1714]"
                onClick={() => void scanLocalServices()}
                disabled={scanningServices}
              >
                <Server size={16} />
                {scanningServices ? 'Scanning...' : 'Scan'}
              </button>
            </div>

            <div className="mb-3 grid gap-2 md:grid-cols-[minmax(0,1fr),160px,auto,auto]">
              <input
                className="field"
                value={serviceSearch}
                onChange={(event) => setServiceSearch(event.target.value)}
                placeholder="Search process or port"
              />
              <select
                className="field"
                value={serviceScope}
                onChange={(event) =>
                  setServiceScope(event.target.value as typeof serviceScope)
                }
              >
                <option value="all">All scopes</option>
                <option value="public">Public bind</option>
                <option value="loopback">Loopback</option>
              </select>
              <label className="flex h-11 items-center gap-2 whitespace-nowrap text-sm font-medium text-black/70 dark:text-[#d7e4df]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-spruce"
                  checked={showSystemServices}
                  onChange={(event) => setShowSystemServices(event.target.checked)}
                />
                Show system/dev
              </label>
              <button
                className="h-11 rounded border border-black/10 bg-white px-3 text-sm font-semibold text-black/65 transition hover:text-black dark:border-white/15 dark:bg-[#18211e] dark:text-[#d7e4df] dark:hover:border-[#8fe0ce]/40 dark:hover:text-white"
                onClick={() => {
                  setIgnoredServices([]);
                  localStorage.removeItem(ignoredServicesKey);
                  localStorage.removeItem(legacyIgnoredServicesKey);
                }}
              >
                Reset hidden
              </button>
            </div>

            {filteredLocalServices.length > 0 ? (
              <div className="max-h-[320px] overflow-auto rounded border border-black/10 dark:border-white/15">
                {filteredLocalServices.map((service) => (
                  <div
                    key={`${service.address}:${service.port}:${service.pid ?? 'unknown'}`}
                    className="grid gap-3 border-b border-black/10 p-3 text-sm last:border-b-0 dark:border-white/15 md:grid-cols-[minmax(0,1fr),auto]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          {knownServiceName(service.port) ?? service.processName ?? 'Unknown process'}
                        </span>
                        <span className="rounded bg-black/5 px-2 py-0.5 text-xs text-black/55 dark:bg-white/10 dark:text-[#b8c7c1]">
                          {service.address}:{service.port}
                        </span>
                        {service.pid ? (
                          <span className="text-xs text-black/45 dark:text-[#9fb0aa]">
                            PID {service.pid}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate text-xs text-black/50 dark:text-[#a9bbb4]">
                        {service.targetUrl}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="h-9 rounded border border-black/10 bg-white px-3 text-sm font-semibold text-black/65 transition hover:text-black dark:border-white/15 dark:bg-[#18211e] dark:text-[#d7e4df] dark:hover:border-[#8fe0ce]/40 dark:hover:text-white"
                        onClick={() => ignoreService(service)}
                      >
                        Hide
                      </button>
                      <button
                        className="h-9 rounded bg-spruce px-3 text-sm font-semibold text-white transition hover:bg-[#11564a]"
                        onClick={() => useLocalService(service)}
                      >
                        Use
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded border border-dashed border-black/20 p-4 text-sm text-black/55 dark:border-white/20 dark:text-[#b8c7c1]">
                Scan to find software listening on local ports.
              </div>
            )}
          </section>

          <section className="panel p-4">
            <h3 className="mb-3 text-sm font-semibold">Gateway settings</h3>
            <div className="grid gap-3">
              <div>
                <label className="label" htmlFor="tlsMode">
                  TLS mode
                </label>
                <select
                  id="tlsMode"
                  className="field"
                  value={settings?.tlsMode ?? 'http'}
                  onChange={(event) =>
                    void saveSettings({
                      tlsMode: event.target.value as ContainerSettings['tlsMode']
                    })
                  }
                >
                  <option value="http">HTTP only</option>
                  <option value="auto_https">Caddy auto HTTPS</option>
                  <option value="internal_ca">Caddy internal CA</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="healthInterval">
                  Health interval seconds
                </label>
                <input
                  id="healthInterval"
                  className="field"
                  type="number"
                  min={0}
                  max={86400}
                  step={30}
                  value={settings?.healthCheckIntervalSeconds ?? 0}
                  onChange={(event) =>
                    void saveSettings({
                      healthCheckIntervalSeconds: Number(event.target.value)
                    })
                  }
                />
              </div>
              <label className="flex items-center gap-3 text-sm font-medium text-black/70 dark:text-[#d7e4df]">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-spruce"
                  checked={settings?.dashboardAuthRequired ?? false}
                  onChange={(event) =>
                    void saveSettings({
                      dashboardAuthRequired: event.target.checked
                    })
                  }
                />
                Require token for dashboard list
              </label>
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label className="label" htmlFor="customCaddyRoutes">
                    Custom Caddy routes JSON
                  </label>
                  <button
                    className="inline-flex h-8 items-center gap-2 rounded bg-ink px-3 text-xs font-semibold text-white transition hover:bg-spruce dark:bg-[#dff3ec] dark:text-[#0f1714]"
                    type="button"
                    onClick={() => void saveCustomCaddyRoutes()}
                    title="Save custom Caddy routes"
                  >
                    <Save size={14} />
                    Save
                  </button>
                </div>
                <textarea
                  id="customCaddyRoutes"
                  className="field min-h-40 resize-y font-mono text-xs leading-relaxed"
                  value={customCaddyRoutesText}
                  onChange={(event) => setCustomCaddyRoutesText(event.target.value)}
                  spellCheck={false}
                />
                <p className="mt-1 text-xs text-black/50 dark:text-[#a9bbb4]">
                  JSON array of Caddy HTTP routes merged before generated app routes. Private hosts stay in local settings and backups.
                </p>
              </div>
              {proxyDiagnostics ? (
                <div className="rounded border border-black/10 p-3 text-xs text-black/60 dark:border-white/15 dark:text-[#b8c7c1]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-black/70 dark:text-[#d7e4df]">
                      Port 443
                    </span>
                    <span
                      className={
                        proxyDiagnostics.port443.available
                          ? 'font-semibold text-spruce dark:text-[#9be8d7]'
                          : 'font-semibold text-coral dark:text-[#ff9b8c]'
                      }
                    >
                      {proxyDiagnostics.port443.available ? 'available' : 'blocked'}
                    </span>
                  </div>
                  <div className="mt-2">
                    Listen: {proxyDiagnostics.caddyListen.join(', ') || 'none'}
                  </div>
                  {proxyDiagnostics.warnings.length > 0 ? (
                    <div className="mt-2 space-y-1 text-amber">
                      {proxyDiagnostics.warnings.map((warning) => (
                        <div key={warning}>{warning}</div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">DNS diagnostic</h3>
              <button
                className="grid h-9 w-9 place-items-center rounded bg-ink text-white transition hover:bg-spruce dark:bg-[#dff3ec] dark:text-[#0f1714]"
                onClick={() => void runDnsDiagnostic()}
                title="Check DNS"
                aria-label="Check DNS"
                disabled={!dnsHost.trim()}
              >
                <Search size={16} />
              </button>
            </div>
            <input
              className="field"
              value={dnsHost}
              onChange={(event) => setDnsHost(event.target.value)}
              placeholder="jellyfin.lab.home"
            />
            {dnsResult ? (
              <div className="mt-3 space-y-2 text-xs text-black/60 dark:text-[#b8c7c1]">
                <div>Resolved: {dnsResult.addresses.join(', ') || 'none'}</div>
                <div>Local: {dnsResult.localAddresses.join(', ') || 'none'}</div>
                <div
                  className={
                    dnsResult.matchesLocalAddress
                      ? 'font-semibold text-spruce dark:text-[#9be8d7]'
                      : 'font-semibold text-coral dark:text-[#ff9b8c]'
                  }
                >
                  {dnsResult.matchesLocalAddress
                    ? 'Host points to this machine.'
                    : 'Host does not resolve to this machine.'}
                </div>
              </div>
            ) : null}
          </section>

          <section className="panel p-4">
            <h3 className="mb-3 text-sm font-semibold">Sync history</h3>
            {history.length > 0 ? (
              <div className="space-y-2">
                {history.map((item) => (
                  <div
                    key={item.id}
                    className="rounded border border-black/10 p-2 text-xs dark:border-white/15"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={
                          item.status === 'success'
                            ? 'font-semibold text-spruce dark:text-[#9be8d7]'
                            : item.status === 'failed'
                              ? 'font-semibold text-coral dark:text-[#ff9b8c]'
                              : 'font-semibold text-amber'
                        }
                      >
                        {item.status}
                      </span>
                      <span className="text-black/45 dark:text-[#9fb0aa]">
                        {new Date(item.createdAt).toLocaleString()}
                      </span>
                    </div>
                    {item.errorMessage ? (
                      <div className="mt-1 truncate text-coral dark:text-[#ff9b8c]">
                        {item.errorMessage}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-black/55 dark:text-[#b8c7c1]">
                No sync history available.
              </div>
            )}
          </section>

          <AuditLogPanel auditLogs={auditLogs} />

          <BackupSnapshotsPanel backupSnapshots={backupSnapshots} />
        </div>
      </section>
    </div>
  );
}
