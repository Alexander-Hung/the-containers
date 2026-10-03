export type RouteMode = 'subdomain' | 'subpath';
export type IconType = 'url' | 'emoji' | 'builtin';

export type ContainerApp = {
  id: string;
  name: string;
  slug: string;
  iconType: IconType;
  iconValue: string | null;
  targetUrl: string;
  routeMode: RouteMode;
  publicHost: string;
  publicPath: string | null;
  enabled: boolean;
  sortOrder: number;
  category: string | null;
  tags: string[];
  favorite: boolean;
  managedDeployment: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProxySync = {
  status: 'success' | 'skipped' | 'failed';
  hash: string | null;
  errorMessage?: string;
};

export type AppMutationResult = {
  app: ContainerApp;
  proxySync: ProxySync;
};

export type AppListMutationResult = {
  apps: ContainerApp[];
  proxySync: ProxySync;
};

export type AppStatus = {
  id: string;
  ok: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  checkedAt: string;
  error: string | null;
};

export type ProxyHistoryItem = {
  id: string;
  caddyConfigHash: string;
  status: ProxySync['status'];
  errorMessage: string | null;
  createdAt: string;
};

export type ProxyDiagnostics = {
  tlsMode: 'http' | 'auto_https' | 'internal_ca';
  caddyListen: string[];
  port443: {
    available: boolean;
    error: string | null;
  };
  warnings: string[];
  renderedConfig: unknown;
};

export type HealthInfo = {
  ok: boolean;
  name: string;
  authRequired: boolean;
};

export type DnsDiagnostic = {
  host: string;
  addresses: string[];
  localAddresses: string[];
  matchesLocalAddress: boolean;
};

export type LocalService = {
  address: string;
  port: number;
  pid: number | null;
  processName: string | null;
  targetUrl: string;
};

export type ContainerSettings = {
  tlsMode: 'http' | 'auto_https' | 'internal_ca';
  dashboardAuthRequired: boolean;
  healthCheckIntervalSeconds: number;
  customCaddyRoutes: Record<string, unknown>[];
};

export type AuditLog = {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  sourceIp: string | null;
  createdAt: string;
};

export type BackupSnapshot = {
  id: string;
  reason: string;
  createdAt: string;
  payload: {
    exportedAt: string;
    version: number;
    apps: ContainerApp[];
    deployments?: DeploymentBackupRecord[];
    deploymentFiles?: BackupDeploymentFile[];
    dockerProjectFiles?: BackupDockerProjectFile[];
    dockerDataArchives?: BackupDockerDataArchive[];
    settings: ContainerSettings;
  };
};

export type DeployPayload = {
  method:
    | 'docker_run'
    | 'docker_compose'
    | 'github_auto'
    | 'static_site'
    | 'node_app'
    | 'python_app'
    | 'binary_service'
    | 'custom_command';
  command: string;
  publishMode: 'reverse_proxy' | 'public_domain_reverse_proxy';
  name?: string;
  publicHost: string;
  routeMode: RouteMode;
  publicPath: string | null;
  hostPort?: number | null;
  containerPort?: number | null;
  category: string | null;
  tags: string[];
  favorite: boolean;
  enabled: boolean;
};

export type DeployPlan = {
  method: 'docker_run' | 'docker_compose' | 'static_site' | 'binary_service';
  containerName: string;
  image: string;
  publishMode: DeployPayload['publishMode'];
  hostPort: number | null;
  containerPort: number;
  protocol: string;
  targetUrl: string;
  appPayload: AppPayload;
  dockerArgs: string[];
  warnings: string[];
};

export type DeployResult = {
  containerId: string;
  plan: DeployPlan;
  app: ContainerApp;
  proxySync: ProxySync;
};

export type DeploymentStatus = {
  appId: string;
  provider: 'docker' | 'docker_compose' | 'binary_service';
  resourceId: string;
  resourceName: string;
  createdAt: string;
  runtime:
    | {
        kind: 'docker';
        running: boolean;
        state: string;
        containerId: string;
        containerName: string;
      }
    | {
        kind: 'docker_compose';
        running: boolean;
        state: string;
        composeFilePath: string;
        containers: Array<{
          id: string;
          name: string;
          state: string;
          status: string;
          image: string;
          ports: string;
        }>;
      }
    | {
        kind: 'binary_service';
        running: boolean;
        state: string;
        command: string;
        pids: number[];
      };
};

export type DeploymentBackupRecord = {
  appId: string;
  provider: 'docker' | 'docker_compose' | 'binary_service';
  resourceId: string;
  resourceName: string;
  deployInput: unknown | null;
  createdAt: string;
};

export type BackupDeploymentFile = {
  path: string;
  encoding: 'base64';
  content: string;
  size: number;
  mode?: number;
  uid?: number;
  gid?: number;
};

export type BackupDockerDataArchive = {
  deployment: string;
  container: string;
  origin?: 'the_containers' | 'registered_app' | 'compose' | 'docker';
  type: 'bind' | 'volume';
  name: string | null;
  source: string;
  destination: string;
  files: BackupDeploymentFile[];
  skipped: Array<{
    path: string;
    reason: string;
    size?: number;
  }>;
};

export type BackupDockerProjectFile = BackupDeploymentFile & {
  absolutePath: string;
  project: string | null;
  container: string;
};

export type DeploymentLogs = {
  appId: string;
  provider: 'docker' | 'docker_compose' | 'binary_service';
  resourceName: string;
  tail: number;
  logs: string;
};

export type RedeployPreview = {
  appId: string;
  provider: 'docker' | 'docker_compose' | 'binary_service';
  resourceName: string;
  canRedeploy: boolean;
  image: string | null;
  targetUrl: string | null;
  hostPort: number | null;
  containerPort: number | null;
  composeFilePath: string | null;
  currentState: string;
  actions: string[];
  preserved: string[];
  removed: string[];
  warnings: string[];
};

export type DeploymentDrift = {
  appId: string;
  provider: 'docker' | 'docker_compose' | 'binary_service';
  resourceName: string;
  checkedAt: string;
  status: 'pass' | 'warn' | 'fail';
  checks: Array<{
    id: string;
    label: string;
    status: 'pass' | 'warn' | 'fail';
    detail: string;
  }>;
  repairs: Array<{
    id: 'start' | 'redeploy' | 'update_target_from_runtime';
    label: string;
    detail: string;
    severity: 'safe' | 'review';
  }>;
};

export type DeployDoctor = {
  ok: boolean;
  dockerBin: string;
  dockerHost: string | null;
  dockerConfig: string | null;
  platform: string;
  userHelpRequired: boolean;
  checks: Array<{
    id: string;
    label: string;
    status: 'pass' | 'warn' | 'fail';
    detail: string;
  }>;
  requirements: Array<{
    id: string;
    label: string;
    status: 'ready' | 'auto' | 'needs_user' | 'blocked';
    userHelpRequired: boolean;
    detail: string;
    commands: string[];
  }>;
  grantSteps: Array<{
    title: string;
    description: string;
    commands: string[];
  }>;
};

export type AppPayload = {
  name: string;
  iconType: IconType;
  iconValue: string | null;
  targetUrl: string;
  routeMode: RouteMode;
  publicHost: string;
  publicPath: string | null;
  enabled: boolean;
  sortOrder: number;
  category: string | null;
  tags: string[];
  favorite: boolean;
};

const tokenKey = 'the-containers-admin-token';
const legacyTokenKey = 'naviproxy-admin-token';
let memoryToken = '';

function readStoredToken() {
  try {
    const sessionToken = sessionStorage.getItem(tokenKey);

    if (sessionToken) {
      return sessionToken;
    }

    const legacySessionToken = sessionStorage.getItem(legacyTokenKey);

    if (legacySessionToken) {
      sessionStorage.setItem(tokenKey, legacySessionToken);
      sessionStorage.removeItem(legacyTokenKey);
      return legacySessionToken;
    }

    const legacyToken = localStorage.getItem(tokenKey) ?? localStorage.getItem(legacyTokenKey);

    if (legacyToken) {
      sessionStorage.setItem(tokenKey, legacyToken);
      localStorage.removeItem(tokenKey);
      localStorage.removeItem(legacyTokenKey);
      return legacyToken;
    }
  } catch {
    return memoryToken;
  }

  return '';
}

export function getAdminToken() {
  return memoryToken || readStoredToken();
}

export function setAdminToken(token: string) {
  memoryToken = token;

  if (token) {
    try {
      sessionStorage.setItem(tokenKey, token);
      sessionStorage.removeItem(legacyTokenKey);
      localStorage.removeItem(tokenKey);
      localStorage.removeItem(legacyTokenKey);
    } catch {
      // Keep the token in memory for storage-restricted browsers.
    }
    return;
  }

  try {
    sessionStorage.removeItem(tokenKey);
    sessionStorage.removeItem(legacyTokenKey);
    localStorage.removeItem(tokenKey);
    localStorage.removeItem(legacyTokenKey);
  } catch {
    // Nothing else to clear when browser storage is unavailable.
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getAdminToken();

  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (token && !headers.has('X-The-Containers-Token')) {
    headers.set('X-The-Containers-Token', token);
  }

  const response = await fetch(path, {
    ...init,
    headers
  });

  if (!response.ok) {
    const detail = await response.text();

    try {
      const parsed = JSON.parse(detail) as {
        message?: string;
        issues?: { path?: Array<string | number>; message: string }[];
      };
      const issueText = parsed.issues
        ?.map((issue) =>
          issue.path?.length
            ? `${issue.path.join('.')}: ${issue.message}`
            : issue.message
        )
        .join('; ');

      throw new Error(issueText || parsed.message || `Request failed with ${response.status}`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(detail || `Request failed with ${response.status}`);
      }

      throw error;
    }
  }

  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),
  listApps: () => request<ContainerApp[]>('/api/apps'),
  appStatuses: () => request<AppStatus[]>('/api/apps/status'),
  runAppStatusCheck: () =>
    request<AppStatus[]>('/api/apps/status/check', {
      method: 'POST'
    }),
  appHealthHistory: (id: string) =>
    request<AppStatus[]>(`/api/apps/${id}/health-history?limit=24`),
  createApp: (payload: AppPayload) =>
    request<AppMutationResult>('/api/apps', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  updateApp: (id: string, payload: AppPayload) =>
    request<AppMutationResult>(`/api/apps/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  deleteApp: (id: string) =>
    request<{
      ok: true;
      proxySync?: ProxySync;
      deployment?: {
        provider: 'docker' | 'docker_compose' | 'binary_service';
        resourceName: string;
      } | null;
    }>(`/api/apps/${id}`, {
      method: 'DELETE'
    }),
  reorderApps: (ids: string[]) =>
    request<AppListMutationResult>('/api/apps/reorder', {
      method: 'PATCH',
      body: JSON.stringify({ ids })
    }),
  exportApps: () =>
    request<{ exportedAt: string; apps: ContainerApp[] }>('/api/apps/export'),
  importApps: (apps: unknown[]) =>
    request<AppListMutationResult>('/api/apps/import', {
      method: 'POST',
      body: JSON.stringify({ mode: 'replace', apps })
    }),
  proxyHistory: () => request<ProxyHistoryItem[]>('/api/proxy/history?limit=8'),
  proxyDiagnostics: () =>
    request<ProxyDiagnostics>('/api/proxy/diagnostics'),
  dnsDiagnostic: (host: string) =>
    request<DnsDiagnostic>(`/api/diagnostics/dns?host=${encodeURIComponent(host)}`),
  auditLogs: () => request<AuditLog[]>('/api/audit?limit=20'),
  localServices: () =>
    request<{ scannedAt: string; services: LocalService[] }>(
      '/api/diagnostics/local-services'
    ),
  settings: () => request<ContainerSettings>('/api/settings'),
  updateSettings: (payload: Partial<ContainerSettings>) =>
    request<{ settings: ContainerSettings; proxySync: ProxySync }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload)
    }),
  backup: () =>
    request<{
      exportedAt: string;
      version: number;
      kind?: string;
      apps: ContainerApp[];
      deployments: DeploymentBackupRecord[];
      deploymentFiles: BackupDeploymentFile[];
      dockerProjectFiles: BackupDockerProjectFile[];
      dockerDataArchives: BackupDockerDataArchive[];
      notes?: string[];
      settings: ContainerSettings;
    }>('/api/backup'),
  previewBackupRestore: (payload: unknown) =>
    request<{ destinations: string[]; confirmation: string }>('/api/backup/restore/preview', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  restoreBackup: (payload: unknown, confirmation: string) =>
    request<AppListMutationResult & {
      settings: ContainerSettings;
      deployments: number;
      deploymentFiles: number;
      dockerProjectFiles: number;
      dockerDataFiles: number;
      warnings: string[];
    }>(
      '/api/backup/restore',
      {
        method: 'POST',
        headers: { 'x-backup-confirmation': confirmation },
        body: JSON.stringify(payload)
      }
    ),
  backupSnapshots: () => request<BackupSnapshot[]>('/api/backup/snapshots'),
  deployDoctor: (payload?: Partial<DeployPayload>) =>
    payload
      ? request<DeployDoctor>('/api/deploy/doctor', {
          method: 'POST',
          body: JSON.stringify(payload)
        })
      : request<DeployDoctor>('/api/deploy/doctor'),
  previewDeploy: (payload: DeployPayload) =>
    request<DeployPlan>('/api/deploy/preview', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  deployDockerRun: (payload: DeployPayload) =>
    request<DeployResult>('/api/deploy/docker-run', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  deploymentStatus: (appId: string) =>
    request<DeploymentStatus>(`/api/deployments/${appId}`),
  manageDeployment: (
    appId: string,
    action: 'start' | 'stop' | 'restart' | 'pull' | 'redeploy'
  ) =>
    request<DeploymentStatus>(`/api/deployments/${appId}/action`, {
      method: 'POST',
      body: JSON.stringify({ action })
    }),
  deploymentLogs: (appId: string, tail = 200) =>
    request<DeploymentLogs>(`/api/deployments/${appId}/logs?tail=${tail}`),
  redeployPreview: (appId: string) =>
    request<RedeployPreview>(`/api/deployments/${appId}/redeploy-preview`),
  deploymentDrift: (appId: string) =>
    request<DeploymentDrift>(`/api/deployments/${appId}/drift`),
  repairDeploymentDrift: (
    appId: string,
    action: 'start' | 'redeploy' | 'update_target_from_runtime'
  ) =>
    request<{
      repair: string;
      app: ContainerApp | null;
      drift: DeploymentDrift | null;
      proxySync: ProxySync | null;
    }>(`/api/deployments/${appId}/drift/repair`, {
      method: 'POST',
      body: JSON.stringify({ action })
    }),
  syncProxy: () =>
    request<ProxySync>('/api/proxy/sync', {
      method: 'POST'
    })
};
