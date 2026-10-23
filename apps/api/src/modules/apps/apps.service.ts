import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { ContainersDatabase } from '../../db/database.js';
import type { ProxyService } from '../proxy/proxy.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import { AppsRepo } from './apps.repo.js';
import type { AppRecord, AppStatus } from './apps.types.js';

export class AppConflictError extends Error {}

const backupSnapshotRetention = 25;

const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidHostname(value: string) {
  const host = value.toLowerCase().replace(/\.$/, '');

  if (host.length < 1 || host.length > 253 || host.includes('..')) {
    return false;
  }

  return host.split('.').every((label) => hostnameLabel.test(label));
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isProxyOriginUrl(value: string) {
  try {
    const url = new URL(value);

    return url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isSafePublicPath(value: string) {
  return (
    /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(value) &&
    !value.startsWith('//')
  );
}

const appInputShape = {
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(1).max(80).optional(),
  iconType: z.enum(['url', 'emoji', 'builtin']).default('url'),
  iconValue: z.string().trim().max(500).nullable().optional(),
  targetUrl: z
    .string()
    .trim()
    .url()
    .refine(isHttpUrl, {
      message: 'Target URL must use http or https.'
    })
    .refine(isProxyOriginUrl, {
      message: 'Target URL must be an origin without a path, query, or hash.'
    }),
  routeMode: z.enum(['subdomain', 'subpath']),
  publicHost: z.string().trim().min(1).max(253).refine(isValidHostname, {
    message: 'Public host must be a valid hostname.'
  }),
    publicPath: z.string().trim().max(120).nullable().optional(),
    enabled: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
    category: z.string().trim().max(60).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
    favorite: z.boolean().default(false)
};

function refineRoute(
  value: { routeMode: 'subdomain' | 'subpath'; publicPath?: string | null },
  ctx: z.RefinementCtx
) {
  if (value.routeMode !== 'subpath') {
    return;
  }

  if (!value.publicPath?.startsWith('/')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicPath'],
      message: 'Subpath routes must start with /.'
    });
  }

  if (value.publicPath && !isSafePublicPath(value.publicPath)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publicPath'],
      message: 'Subpath route contains unsupported characters or starts with //.'
    });
  }
}

function refineIcon(
  value: { iconType: 'url' | 'emoji' | 'builtin'; iconValue?: string | null },
  ctx: z.RefinementCtx
) {
  if (value.iconType === 'url' && value.iconValue && !isHttpUrl(value.iconValue)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['iconValue'],
      message: 'Icon URL must use http or https.'
    });
  }
}

function refineAppInput(
  value: {
    routeMode: 'subdomain' | 'subpath';
    publicPath?: string | null;
    iconType: 'url' | 'emoji' | 'builtin';
    iconValue?: string | null;
  },
  ctx: z.RefinementCtx
) {
  refineRoute(value, ctx);
  refineIcon(value, ctx);
}

const appInputSchema = z.object(appInputShape).superRefine(refineAppInput);

const reorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1)
});

const importSchema = z.object({
  mode: z.enum(['replace']).default('replace'),
  apps: z
    .array(
      z
        .object({
          ...appInputShape,
          id: z.string().min(1).optional()
        })
        .superRefine(refineAppInput)
    )
    .min(1)
});

const deploymentBackupSchema = z.array(
  z.object({
    appId: z.string().min(1),
    provider: z.enum(['docker', 'docker_compose', 'binary_service']),
    resourceId: z.string().min(1),
    resourceName: z.string().min(1),
    deployInput: z.unknown().nullable().optional(),
    createdAt: z.string().optional()
  })
);

export type AppInput = z.infer<typeof appInputSchema>;

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizePublicPath(value: string) {
  const normalized = value.trim().replace(/\/+$/g, '');
  return normalized || '/';
}

function normalizeTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 12);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
      return record[key];
    }
  }

  return undefined;
}

function stringValue(value: unknown) {
  return typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : undefined;
}

function booleanValue(value: unknown, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }

  return fallback;
}

function tagsValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const tag = stringValue(item)?.trim();
      return tag ? [tag] : [];
    });
  }

  if (typeof value === 'string') {
    return value.split(',').map((tag) => tag.trim()).filter(Boolean);
  }

  return [];
}

function normalizeTargetUrl(value: unknown, fallbackPort: unknown) {
  const raw = stringValue(value);

  if (raw?.startsWith('http://') || raw?.startsWith('https://')) {
    return raw;
  }

  if (raw && /^\d+$/.test(raw)) {
    return `http://127.0.0.1:${raw}`;
  }

  const port = stringValue(fallbackPort);

  if (port && /^\d+$/.test(port)) {
    return `http://127.0.0.1:${port}`;
  }

  return 'http://127.0.0.1:80';
}

function coerceImportedAppInput(input: unknown) {
  const record = asRecord(input);
  const name =
    stringValue(firstValue(record, ['name', 'title', 'label', 'displayName'])) ??
    'Imported App';
  const slug =
    stringValue(firstValue(record, ['slug', 'id', 'key'])) ??
    slugify(name);
  const routeMode =
    firstValue(record, ['routeMode', 'route_mode']) === 'subpath'
      ? 'subpath'
      : 'subdomain';
  const publicHost =
    stringValue(firstValue(record, ['publicHost', 'public_host', 'host', 'domain'])) ??
    `${slugify(slug || name) || 'app'}.lab.home`;

  return {
    id: stringValue(firstValue(record, ['id', 'appId', 'app_id'])),
    name,
    slug,
    iconType:
      firstValue(record, ['iconType', 'icon_type']) === 'emoji' ||
      firstValue(record, ['iconType', 'icon_type']) === 'builtin'
        ? firstValue(record, ['iconType', 'icon_type'])
        : 'url',
    iconValue:
      stringValue(firstValue(record, ['iconValue', 'icon_value', 'icon', 'iconUrl', 'icon_url'])) ??
      null,
    targetUrl: normalizeTargetUrl(
      firstValue(record, ['targetUrl', 'target_url', 'target', 'url', 'origin']),
      firstValue(record, ['port', 'hostPort', 'host_port'])
    ),
    routeMode,
    publicHost,
    publicPath:
      routeMode === 'subpath'
        ? stringValue(firstValue(record, ['publicPath', 'public_path', 'path'])) ?? `/${slugify(slug || name) || 'app'}`
        : null,
    enabled: booleanValue(firstValue(record, ['enabled', 'isEnabled']), true),
    sortOrder: Number(firstValue(record, ['sortOrder', 'sort_order']) ?? 0),
    category:
      stringValue(firstValue(record, ['category', 'group', 'folder'])) ??
      null,
    tags: tagsValue(firstValue(record, ['tags', 'labels'])),
    favorite: booleanValue(firstValue(record, ['favorite', 'isFavorite']))
  };
}

function coerceImportInput(input: unknown) {
  if (Array.isArray(input)) {
    return {
      mode: 'replace',
      apps: input.map(coerceImportedAppInput)
    };
  }

  const record = asRecord(input);
  const apps =
    firstValue(record, ['apps', 'items', 'services', 'applications']) ??
    firstValue(asRecord(record.data), ['apps', 'items', 'services', 'applications']) ??
    firstValue(asRecord(record.payload), ['apps', 'items', 'services', 'applications']);

  return {
    mode: 'replace',
    apps: Array.isArray(apps) ? apps.map(coerceImportedAppInput) : []
  };
}

function coerceDeploymentBackup(input: unknown) {
  const record = asRecord(input);

  return {
    appId: stringValue(firstValue(record, ['appId', 'app_id', 'app'])) ?? '',
    provider: firstValue(record, ['provider', 'type']),
    resourceId:
      stringValue(firstValue(record, ['resourceId', 'resource_id', 'id', 'path'])) ??
      '',
    resourceName:
      stringValue(firstValue(record, ['resourceName', 'resource_name', 'name', 'containerName', 'container_name'])) ??
      '',
    deployInput: firstValue(record, ['deployInput', 'deploy_input', 'input']) ?? null,
    createdAt: stringValue(firstValue(record, ['createdAt', 'created_at']))
  };
}

function normalizeAppInput(input: unknown, fallbackSlug?: string): AppInput {
  const parsed = appInputSchema.parse(input);
  const url = new URL(parsed.targetUrl);
  const slug = slugify(parsed.slug || parsed.name) || fallbackSlug || `app-${nanoid(8)}`;

  return {
    ...parsed,
    slug,
    targetUrl: url.toString().replace(/\/$/, ''),
    publicHost: parsed.publicHost.toLowerCase().replace(/\.$/, ''),
    publicPath:
      parsed.routeMode === 'subpath'
        ? normalizePublicPath(parsed.publicPath || `/${slug}`)
        : null,
    iconValue: parsed.iconValue || null,
    category: parsed.category || null,
    tags: normalizeTags(parsed.tags),
    favorite: parsed.favorite
  };
}

function pathsOverlap(left: string, right: string) {
  if (left === '/' || right === '/') {
    return true;
  }

  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export class AppsService {
  private readonly repo: AppsRepo;

  constructor(
    private readonly db: ContainersDatabase,
    private readonly proxyService: ProxyService
  ) {
    this.repo = new AppsRepo(db);
  }

  list() {
    return this.repo.findAll();
  }

  findById(id: string) {
    return this.repo.findById(id);
  }

  private ensureNoConflict(app: AppRecord, existingId?: string) {
    const slugMatch = this.repo.findBySlug(app.slug);

    if (slugMatch && slugMatch.id !== existingId) {
      throw new AppConflictError(`Slug "${app.slug}" is already used by ${slugMatch.name}.`);
    }

    for (const current of this.repo.findAll()) {
      if (current.id === existingId || current.publicHost !== app.publicHost) {
        continue;
      }

      if (current.routeMode === 'subdomain' || app.routeMode === 'subdomain') {
        throw new AppConflictError(
          `Host "${app.publicHost}" is already covered by ${current.name}.`
        );
      }

      if (pathsOverlap(current.publicPath ?? '/', app.publicPath ?? '/')) {
        throw new AppConflictError(
          `Path "${app.publicPath}" overlaps with ${current.name} at ${current.publicPath}.`
        );
      }
    }
  }

  private ensureImportedAppsAreUnique(apps: AppRecord[]) {
    for (let index = 0; index < apps.length; index += 1) {
      for (let next = index + 1; next < apps.length; next += 1) {
        const left = apps[index];
        const right = apps[next];

        if (left.slug === right.slug) {
          throw new AppConflictError(`Imported apps contain duplicate slug "${left.slug}".`);
        }

        if (left.id === right.id) {
          throw new AppConflictError(`Imported apps contain duplicate id "${left.id}".`);
        }

        if (left.publicHost !== right.publicHost) {
          continue;
        }

        if (
          left.routeMode === 'subdomain' ||
          right.routeMode === 'subdomain' ||
          pathsOverlap(left.publicPath ?? '/', right.publicPath ?? '/')
        ) {
          throw new AppConflictError(
            `Imported apps ${left.name} and ${right.name} have overlapping routes.`
          );
        }
      }
    }
  }

  async create(input: unknown) {
    const normalized = normalizeAppInput(input);
    const now = new Date().toISOString();
    const sortOrder = this.repo.findAll().length;
    const app: AppRecord = {
      id: nanoid(),
      name: normalized.name,
      slug: normalized.slug || slugify(normalized.name),
      iconType: normalized.iconType,
      iconValue: normalized.iconValue ?? null,
      targetUrl: normalized.targetUrl,
      routeMode: normalized.routeMode,
      publicHost: normalized.publicHost,
      publicPath: normalized.publicPath ?? null,
      enabled: normalized.enabled,
      sortOrder,
      category: normalized.category ?? null,
      tags: normalized.tags,
      favorite: normalized.favorite,
      managedDeployment: false,
      createdAt: now,
      updatedAt: now
    };

    this.ensureNoConflict(app);
    const created = this.db.transaction(() => this.repo.create(app))();
    const proxySync = await this.proxyService.syncSafely();
    return { app: created, proxySync };
  }

  validateCreate(input: unknown) {
    const normalized = normalizeAppInput(input);
    const now = new Date().toISOString();
    const app: AppRecord = {
      id: nanoid(),
      name: normalized.name,
      slug: normalized.slug || slugify(normalized.name),
      iconType: normalized.iconType,
      iconValue: normalized.iconValue ?? null,
      targetUrl: normalized.targetUrl,
      routeMode: normalized.routeMode,
      publicHost: normalized.publicHost,
      publicPath: normalized.publicPath ?? null,
      enabled: normalized.enabled,
      sortOrder: normalized.sortOrder,
      category: normalized.category ?? null,
      tags: normalized.tags,
      favorite: normalized.favorite,
      managedDeployment: false,
      createdAt: now,
      updatedAt: now
    };

    this.ensureNoConflict(app);
    return app;
  }

  async update(id: string, input: unknown) {
    const existing = this.repo.findById(id);

    if (!existing) {
      return null;
    }

    const normalized = normalizeAppInput(input, existing.slug);
    const patch = {
      name: normalized.name,
      slug: normalized.slug || slugify(normalized.name),
      iconType: normalized.iconType,
      iconValue: normalized.iconValue ?? null,
      targetUrl: normalized.targetUrl,
      routeMode: normalized.routeMode,
      publicHost: normalized.publicHost,
      publicPath: normalized.publicPath ?? null,
      enabled: normalized.enabled,
      sortOrder: normalized.sortOrder,
      category: normalized.category ?? null,
      tags: normalized.tags,
      favorite: normalized.favorite,
      managedDeployment: existing.managedDeployment,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt
    };

    this.ensureNoConflict({ ...patch, id }, id);
    const updated = this.db.transaction(() =>
      this.repo.update(id, patch)
    )();

    const proxySync = await this.proxyService.syncSafely();
    return { app: updated, proxySync };
  }

  async delete(id: string) {
    const deleted = this.db.transaction(() => this.repo.delete(id))();

    if (deleted) {
      const proxySync = await this.proxyService.syncSafely();
      return { deleted, proxySync };
    }

    return { deleted };
  }

  async reorder(input: unknown) {
    const { ids } = reorderSchema.parse(input);
    const existing = this.repo.findAll();
    const existingIds = new Set(existing.map((app) => app.id));
    const requestedIds = new Set(ids);

    if (requestedIds.size !== ids.length) {
      throw new AppConflictError('Reorder list contains duplicate app ids.');
    }

    if (ids.length !== existing.length || ids.some((id) => !existingIds.has(id))) {
      throw new AppConflictError('Reorder list must include every configured app exactly once.');
    }

    this.db.transaction(() => {
      ids.forEach((id, index) => this.repo.updateSortOrder(id, index));
    })();

    const proxySync = await this.proxyService.syncSafely();
    return { apps: this.repo.findAll(), proxySync };
  }

  async checkStatuses(): Promise<AppStatus[]> {
    const apps = this.repo.findAll();

    const statuses = await Promise.all(
      apps.map(async (app) => {
        const startedAt = Date.now();
        const checkedAt = new Date().toISOString();

        try {
          const response = await fetch(app.targetUrl, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(2500)
          });

          return {
            id: app.id,
            ok: response.status < 500,
            statusCode: response.status,
            responseTimeMs: Date.now() - startedAt,
            checkedAt,
            error: null
          };
        } catch (error) {
          const cause =
            error instanceof Error && error.cause instanceof Error
              ? error.cause
              : null;
          const message = cause?.message ?? (error instanceof Error ? error.message : String(error));

          return {
            id: app.id,
            ok: false,
            statusCode: null,
            responseTimeMs: Date.now() - startedAt,
            checkedAt,
            error: message
          };
        }
      })
    );

    this.repo.recordHealthChecks(statuses);
    return statuses;
  }

  healthHistory(appId: string, limit = 30) {
    return this.repo.findHealthHistory(appId, limit);
  }

  latestStatuses() {
    return this.repo.findLatestHealthStatuses();
  }

  exportApps() {
    return {
      exportedAt: new Date().toISOString(),
      apps: this.repo.findAll()
    };
  }

  exportDeployments() {
    const rows = this.db
      .prepare(
        `SELECT
          app_id AS appId,
          provider,
          resource_id AS resourceId,
          resource_name AS resourceName,
          deploy_input AS deployInput,
          created_at AS createdAt
        FROM deployment_records
        ORDER BY created_at ASC`
      )
      .all() as Array<{
        appId: string;
        provider: 'docker' | 'docker_compose' | 'binary_service';
        resourceId: string;
        resourceName: string;
        deployInput: string | null;
        createdAt: string;
      }>;

    return rows.map((row) => {
      let deployInput: unknown | null = null;

      if (row.deployInput) {
        try {
          deployInput = JSON.parse(row.deployInput);
        } catch {
          deployInput = null;
        }
      }

      return {
        ...row,
        deployInput
      };
    });
  }

  private prepareImportedApps(input: unknown) {
    const parsed = importSchema.parse(coerceImportInput(input));
    const now = new Date().toISOString();
    const apps = parsed.apps.map((appInput, index) => {
      const normalized = normalizeAppInput(appInput);

      return {
        id: appInput.id ?? nanoid(),
        name: normalized.name,
        slug: normalized.slug || slugify(normalized.name),
        iconType: normalized.iconType,
        iconValue: normalized.iconValue ?? null,
        targetUrl: normalized.targetUrl,
        routeMode: normalized.routeMode,
        publicHost: normalized.publicHost,
        publicPath: normalized.publicPath ?? null,
        enabled: normalized.enabled,
        sortOrder: index,
        category: normalized.category ?? null,
        tags: normalized.tags,
        favorite: normalized.favorite,
        managedDeployment: false,
        createdAt: now,
        updatedAt: now
      };
    });

    this.ensureImportedAppsAreUnique(apps);
    return apps;
  }

  async importApps(input: unknown) {
    const apps = this.prepareImportedApps(input);
    const importedIds = new Set(apps.map((app) => app.id));
    const removedManagedApps = this.repo.findAll().filter(
      (app) => app.managedDeployment && !importedIds.has(app.id)
    );

    if (removedManagedApps.length > 0) {
      throw new AppConflictError(
        `Import would remove managed apps: ${removedManagedApps.map((app) => `${app.name} (${app.id})`).join(', ')}. Include them in the import or delete them through the managed app delete flow first.`
      );
    }

    const savedApps = this.repo.replaceAll(apps);
    const proxySync = await this.proxyService.syncSafely();

    return { apps: savedApps, proxySync };
  }

  async restoreBackup(input: {
    apps: unknown[];
    deployments?: unknown[];
    settings?: unknown;
    settingsService: SettingsService;
    adminTokenConfigured: boolean;
  }) {
    const apps = this.prepareImportedApps({
      mode: 'replace',
      apps: input.apps
    });
    const nextSettings = input.settings
      ? input.settingsService.normalize(input.settings, {
          adminTokenConfigured: input.adminTokenConfigured
        })
      : input.settingsService.getAll();
    const snapshot = {
      exportedAt: new Date().toISOString(),
      version: 1,
      apps: this.exportApps().apps,
      deployments: this.exportDeployments(),
      settings: input.settingsService.getAll()
    };
    const deployments = input.deployments
      ? deploymentBackupSchema.parse(input.deployments.map(coerceDeploymentBackup))
      : [];

    const savedApps = this.db.transaction(() => {
      this.recordBackupSnapshotInCurrentTransaction('pre_restore', snapshot);
      const restoredApps = this.repo.replaceAllInCurrentTransaction(apps);
      this.replaceDeploymentsInCurrentTransaction(deployments);
      input.settingsService.save(nextSettings);
      this.pruneBackupSnapshotsInCurrentTransaction();
      return restoredApps;
    })();
    const proxySync = await this.proxyService.syncSafely();

    return {
      apps: savedApps,
      deployments: deployments.length,
      settings: nextSettings,
      snapshot,
      proxySync
    };
  }

  private replaceDeploymentsInCurrentTransaction(
    deployments: z.infer<typeof deploymentBackupSchema>
  ) {
    this.db.prepare('DELETE FROM deployment_records').run();

    if (deployments.length === 0) {
      return;
    }

    const existingAppIds = new Set(
      (this.db.prepare('SELECT id FROM apps').all() as Array<{ id: string }>).map((row) => row.id)
    );
    const insert = this.db.prepare(
      `INSERT INTO deployment_records (
        app_id, provider, resource_id, resource_name, deploy_input, created_at
      ) VALUES (
        @appId, @provider, @resourceId, @resourceName, @deployInput, @createdAt
      )`
    );

    for (const deployment of deployments) {
      if (!existingAppIds.has(deployment.appId)) {
        continue;
      }

      insert.run({
        ...deployment,
        deployInput: deployment.deployInput ? JSON.stringify(deployment.deployInput) : null,
        createdAt: deployment.createdAt ?? new Date().toISOString()
      });
    }
  }

  recordBackupSnapshot(reason: string, payload: unknown) {
    this.db.transaction(() => {
      this.recordBackupSnapshotInCurrentTransaction(reason, payload);
      this.pruneBackupSnapshotsInCurrentTransaction();
    })();
  }

  private recordBackupSnapshotInCurrentTransaction(reason: string, payload: unknown) {
    this.db
      .prepare(
        `INSERT INTO backup_snapshots (id, reason, payload)
        VALUES (?, ?, ?)`
      )
      .run(nanoid(), reason, JSON.stringify(payload));
  }

  private pruneBackupSnapshotsInCurrentTransaction() {
    this.db
      .prepare(
        `DELETE FROM backup_snapshots
        WHERE id IN (
          SELECT id FROM backup_snapshots
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?
        )`
      )
      .run(backupSnapshotRetention);
  }

  listBackupSnapshots(limit = 20) {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.min(Math.max(limit, 1), 100)
      : 20;
    const rows = this.db
      .prepare(
        `SELECT id, reason, payload, created_at AS createdAt
        FROM backup_snapshots
        ORDER BY created_at DESC
        LIMIT ?`
      )
      .all(normalizedLimit);

    return rows.map((row) => ({
      ...(row as { id: string; reason: string; createdAt: string }),
      payload: JSON.parse((row as { payload: string }).payload) as unknown
    }));
  }
}
