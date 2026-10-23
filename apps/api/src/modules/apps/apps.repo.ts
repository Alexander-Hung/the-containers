import type { ContainersDatabase } from '../../db/database.js';
import { nanoid } from 'nanoid';
import type { AppRecord, AppRow, AppStatus } from './apps.types.js';

function toRecord(row: AppRow): AppRecord {
  let tags: string[] = [];

  try {
    const parsed = JSON.parse(row.tags);
    tags = Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    tags = [];
  }

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    iconType: row.icon_type,
    iconValue: row.icon_value,
    targetUrl: row.target_url,
    routeMode: row.route_mode,
    publicHost: row.public_host,
    publicPath: row.public_path,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    category: row.category,
    tags,
    favorite: row.favorite === 1,
    managedDeployment: row.managed_deployment === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class AppsRepo {
  constructor(private readonly db: ContainersDatabase) {}

  findAll() {
    const rows = this.db
      .prepare(
        `SELECT
          apps.*,
          CASE WHEN deployment_records.app_id IS NULL THEN 0 ELSE 1 END AS managed_deployment
        FROM apps
        LEFT JOIN deployment_records ON deployment_records.app_id = apps.id
        ORDER BY apps.sort_order ASC, apps.created_at DESC`
      )
      .all() as AppRow[];

    return rows.map(toRecord);
  }

  findEnabled() {
    const rows = this.db
      .prepare(
        `SELECT
          apps.*,
          CASE WHEN deployment_records.app_id IS NULL THEN 0 ELSE 1 END AS managed_deployment
        FROM apps
        LEFT JOIN deployment_records ON deployment_records.app_id = apps.id
        WHERE apps.enabled = 1
        ORDER BY apps.sort_order ASC, apps.created_at ASC`
      )
      .all() as AppRow[];

    return rows.map(toRecord);
  }

  findById(id: string) {
    const row = this.db
      .prepare(
        `SELECT
          apps.*,
          CASE WHEN deployment_records.app_id IS NULL THEN 0 ELSE 1 END AS managed_deployment
        FROM apps
        LEFT JOIN deployment_records ON deployment_records.app_id = apps.id
        WHERE apps.id = ?`
      )
      .get(id) as AppRow | undefined;

    return row ? toRecord(row) : null;
  }

  findBySlug(slug: string) {
    const row = this.db
      .prepare(
        `SELECT
          apps.*,
          CASE WHEN deployment_records.app_id IS NULL THEN 0 ELSE 1 END AS managed_deployment
        FROM apps
        LEFT JOIN deployment_records ON deployment_records.app_id = apps.id
        WHERE apps.slug = ?`
      )
      .get(slug) as AppRow | undefined;

    return row ? toRecord(row) : null;
  }

  create(app: AppRecord) {
    this.db
      .prepare(
        `INSERT INTO apps (
          id, name, slug, icon_type, icon_value, target_url, route_mode,
          public_host, public_path, enabled, sort_order, category, tags, favorite
        ) VALUES (
          @id, @name, @slug, @iconType, @iconValue, @targetUrl, @routeMode,
          @publicHost, @publicPath, @enabled, @sortOrder, @category, @tags, @favorite
        )`
      )
      .run({
        ...app,
        enabled: app.enabled ? 1 : 0,
        tags: JSON.stringify(app.tags),
        favorite: app.favorite ? 1 : 0
      });

    return this.findById(app.id);
  }

  update(id: string, patch: Omit<AppRecord, 'id' | 'createdAt' | 'updatedAt'>) {
    this.db
      .prepare(
        `UPDATE apps SET
          name = @name,
          slug = @slug,
          icon_type = @iconType,
          icon_value = @iconValue,
          target_url = @targetUrl,
          route_mode = @routeMode,
          public_host = @publicHost,
          public_path = @publicPath,
          enabled = @enabled,
          sort_order = @sortOrder,
          category = @category,
          tags = @tags,
          favorite = @favorite,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = @id`
      )
      .run({
        id,
        ...patch,
        enabled: patch.enabled ? 1 : 0,
        tags: JSON.stringify(patch.tags),
        favorite: patch.favorite ? 1 : 0
      });

    return this.findById(id);
  }

  delete(id: string) {
    return this.db.prepare('DELETE FROM apps WHERE id = ?').run(id).changes > 0;
  }

  updateSortOrder(id: string, sortOrder: number) {
    this.db
      .prepare(
        'UPDATE apps SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      )
      .run(sortOrder, id);

    return this.findById(id);
  }

  replaceAllInCurrentTransaction(apps: AppRecord[]) {
    const insert = this.db.prepare(
      `INSERT INTO apps (
        id, name, slug, icon_type, icon_value, target_url, route_mode,
        public_host, public_path, enabled, sort_order, category, tags, favorite,
        created_at, updated_at
      ) VALUES (
        @id, @name, @slug, @iconType, @iconValue, @targetUrl, @routeMode,
        @publicHost, @publicPath, @enabled, @sortOrder, @category, @tags,
        @favorite, @createdAt, @updatedAt
      )`
    );

    this.db.prepare('DELETE FROM apps').run();

    for (const app of apps) {
      insert.run({
        ...app,
        enabled: app.enabled ? 1 : 0,
        tags: JSON.stringify(app.tags),
        favorite: app.favorite ? 1 : 0
      });
    }

    return this.findAll();
  }

  replaceAll(apps: AppRecord[]) {
    return this.db.transaction(() => {
      const importedIds = new Set(apps.map((app) => app.id));
      const existingIds = new Set(this.findAll().map((app) => app.id));
      const releaseSlug = this.db.prepare('UPDATE apps SET slug = ? WHERE id = ?');

      for (const id of existingIds) {
        if (!importedIds.has(id)) {
          this.delete(id);
        } else {
          // Allow slug swaps without deleting retained rows and cascading their metadata.
          // Imported slugs are normalized and cannot contain this underscore prefix.
          releaseSlug.run(`__import_${nanoid()}`, id);
        }
      }

      for (const app of apps) {
        if (existingIds.has(app.id)) {
          this.update(app.id, app);
        } else {
          this.create(app);
        }
      }

      return this.findAll();
    })();
  }

  recordHealthChecks(statuses: AppStatus[]) {
    const insert = this.db.prepare(
      `INSERT INTO app_health_checks (
        id, app_id, ok, status_code, response_time_ms, error, checked_at
      ) VALUES (
        @id, @appId, @ok, @statusCode, @responseTimeMs, @error, @checkedAt
      )`
    );

    this.db.transaction(() => {
      for (const status of statuses) {
        insert.run({
          id: nanoid(),
          appId: status.id,
          ok: status.ok ? 1 : 0,
          statusCode: status.statusCode,
          responseTimeMs: status.responseTimeMs,
          error: status.error,
          checkedAt: status.checkedAt
        });
      }

      this.db
        .prepare(
          `DELETE FROM app_health_checks
          WHERE id IN (
            SELECT old.id FROM app_health_checks old
            WHERE (
              SELECT COUNT(*) FROM app_health_checks newer
              WHERE newer.app_id = old.app_id
                AND newer.checked_at >= old.checked_at
            ) > 100
          )`
        )
        .run();
    })();
  }

  findHealthHistory(appId: string, limit = 30) {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.min(Math.max(limit, 1), 100)
      : 30;

    return this.db
      .prepare(
        `SELECT
          app_id AS id,
          ok,
          status_code AS statusCode,
          response_time_ms AS responseTimeMs,
          checked_at AS checkedAt,
          error
        FROM app_health_checks
        WHERE app_id = ?
        ORDER BY checked_at DESC
        LIMIT ?`
      )
      .all(appId, normalizedLimit)
      .map((row) => ({
        ...(row as Omit<AppStatus, 'ok'> & { ok: number }),
        ok: (row as { ok: number }).ok === 1
      }));
  }

  findLatestHealthStatuses() {
    return this.db
      .prepare(
        `SELECT
          latest.app_id AS id,
          latest.ok,
          latest.status_code AS statusCode,
          latest.response_time_ms AS responseTimeMs,
          latest.checked_at AS checkedAt,
          latest.error
        FROM app_health_checks latest
        INNER JOIN (
          SELECT app_id, MAX(checked_at) AS checked_at
          FROM app_health_checks
          GROUP BY app_id
        ) grouped
          ON grouped.app_id = latest.app_id
          AND grouped.checked_at = latest.checked_at
        ORDER BY latest.checked_at DESC`
      )
      .all()
      .map((row) => ({
        ...(row as Omit<AppStatus, 'ok'> & { ok: number }),
        ok: (row as { ok: number }).ok === 1
      }));
  }
}
