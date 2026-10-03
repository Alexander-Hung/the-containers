import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { config } from '../src/config.ts';
import { createDatabase } from '../src/db/database.ts';
import { AppsRepo } from '../src/modules/apps/apps.repo.ts';
import { AppConflictError, AppsService } from '../src/modules/apps/apps.service.ts';
import { ProxyService } from '../src/modules/proxy/proxy.service.ts';
import { SettingsService } from '../src/modules/settings/settings.service.ts';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'containers-import-test-'));
  const originalConfig = { ...config };
  Object.assign(config, {
    databasePath: path.join(directory, 'test.sqlite'),
    caddySyncEnabled: false
  });
  const db = createDatabase();
  t.after(() => {
    db.close();
    Object.assign(config, originalConfig);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const settingsService = new SettingsService(db);
  const proxyService = new ProxyService(db, new AppsRepo(db), settingsService);
  const service = new AppsService(db, proxyService);
  return {
    service,
    settingsService,
    async addApp(name, provider) {
      const { app } = await service.create({
        name, slug: name, targetUrl: 'http://127.0.0.1:18080',
        routeMode: 'subdomain', publicHost: `${name}.test`
      });
      if (provider) {
        // Seed metadata only; never create or contact a runtime resource.
        db.prepare(`INSERT INTO deployment_records
          (app_id, provider, resource_id, resource_name, deploy_input, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
          app.id, provider, `resource-${name}`, `service-${name}`,
          JSON.stringify({ method: provider, command: 'fixture-command' }),
          '2026-01-01T00:00:00.000Z'
        );
      }
      return service.findById(app.id);
    }
  };
}

test('same-id export/import preserves managed deployment metadata while editing routes and categories', async (t) => {
  const { service, addApp } = fixture(t);
  const app = await addApp('managed', 'binary_service');
  const deployments = service.exportDeployments();
  const exported = service.exportApps();
  exported.apps[0].publicHost = 'edited.test';
  exported.apps[0].category = 'Edited category';

  const result = await service.importApps(exported);

  assert.equal(result.proxySync.status, 'skipped');
  assert.equal(result.apps[0].managedDeployment, true);
  assert.deepEqual(service.exportDeployments(), deployments);
  assert.equal(service.findById(app.id).publicHost, 'edited.test');
  assert.equal(service.findById(app.id).category, 'Edited category');
  assert.equal(service.findById(app.id).createdAt, app.createdAt);
});

test('import rejects omitted managed apps without changing apps or deployment metadata', async (t) => {
  const { service, addApp } = fixture(t);
  const managed = await addApp('managed', 'docker');
  const unmanaged = await addApp('unmanaged');
  const before = service.list();
  const deployments = service.exportDeployments();

  await assert.rejects(service.importApps({
    apps: [{ ...unmanaged, category: 'Must not be saved' }]
  }), (error) => error instanceof AppConflictError && error.message.includes(managed.id));

  assert.deepEqual(service.list(), before);
  assert.deepEqual(service.exportDeployments(), deployments);
});

test('import can swap retained slugs, add apps and remove unmanaged apps without losing deployments', async (t) => {
  const { service, addApp } = fixture(t);
  const first = await addApp('first', 'docker');
  const second = await addApp('second', 'docker_compose');
  const removed = await addApp('removed');
  const deployments = service.exportDeployments();

  const result = await service.importApps({ apps: [
    { ...first, slug: second.slug },
    { ...second, slug: first.slug },
    { ...removed, id: 'new-app', managedDeployment: true }
  ] });

  assert.equal(result.apps.length, 3);
  assert.equal(service.findById(first.id).slug, 'second');
  assert.equal(service.findById(second.id).slug, 'first');
  assert.equal(service.findById(removed.id), null);
  assert.equal(service.findById('new-app').managedDeployment, false);
  assert.deepEqual(service.exportDeployments(), deployments);
});

for (const provider of ['docker', 'docker_compose', 'binary_service']) {
  test(`backup export/restore preserves ${provider} and its deployment metadata`, async (t) => {
    const { service, settingsService, addApp } = fixture(t);
    const app = await addApp('managed', provider);
    const backup = {
      apps: service.exportApps().apps,
      deployments: service.exportDeployments(),
      settings: settingsService.getAll()
    };

    // Clear the fixture so preservation cannot be mistaken for a successful restore.
    await service.delete(app.id);
    assert.deepEqual(service.exportDeployments(), []);
    const restored = await service.restoreBackup({
      ...backup, settingsService, adminTokenConfigured: false
    });

    assert.equal(restored.proxySync.status, 'skipped');
    assert.equal(restored.deployments, 1);
    assert.equal(service.findById(app.id).managedDeployment, true);
    assert.deepEqual(service.exportDeployments(), backup.deployments);
  });
}

for (const provider of ['unknown_runtime', undefined, null, '', 42]) {
  test(`restore rejects invalid provider ${String(provider)} before changing saved state`, async (t) => {
    const { service, settingsService, addApp } = fixture(t);
    await addApp('managed', 'docker');
    const apps = service.exportApps().apps;
    const deployments = service.exportDeployments();
    const settings = settingsService.getAll();
    const snapshots = service.listBackupSnapshots();

    await assert.rejects(service.restoreBackup({
      apps: apps.map((app) => ({ ...app, category: 'Must not be saved' })),
      deployments: deployments.map((deployment) => ({ ...deployment, provider })),
      settings: { ...settings, tlsMode: 'internal_ca' },
      settingsService,
      adminTokenConfigured: false
    }), (error) => error instanceof ZodError && error.issues.some(
      (issue) => issue.path.join('.') === '0.provider'
    ));

    assert.deepEqual(service.list(), apps);
    assert.deepEqual(service.exportDeployments(), deployments);
    assert.deepEqual(settingsService.getAll(), settings);
    assert.deepEqual(service.listBackupSnapshots(), snapshots);
  });
}
