import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { registerAdminAuth } from '../src/auth.ts';
import { config } from '../src/config.ts';
import { registerAppsRoutes } from '../src/modules/apps/apps.routes.ts';
import { registerAuditRoutes } from '../src/modules/audit/audit.routes.ts';
import { registerBackupRoutes } from '../src/modules/backup/backup.routes.ts';
import { registerDeployRoutes } from '../src/modules/deploy/deploy.routes.ts';
import { registerDiagnosticsRoutes } from '../src/modules/diagnostics/diagnostics.routes.ts';
import { registerProxyRoutes } from '../src/modules/proxy/proxy.routes.ts';
import { registerSettingsRoutes } from '../src/modules/settings/settings.routes.ts';

const originalConfig = { ...config };
let app;
let routes;
let dashboardAuthRequired;

beforeEach(async () => {
  Object.assign(config, { host: '0.0.0.0', adminToken: '', dashboardAuthRequired: false });
  dashboardAuthRequired = false;
  routes = [];
  app = Fastify();
  app.addHook('onRoute', ({ method, url }) => {
    for (const verb of [method].flat()) {
      routes.push({ method: verb, url: url.replace(/:[^/]+/g, 'test-app') });
    }
  });
  registerAdminAuth(app, { dashboardAuthRequired: () => dashboardAuthRequired });
  // Observe whether auth allows the request, without executing deployments,
  // database operations, DNS lookups, or any other route handler side effects.
  app.addHook('onRequest', async (_request, reply) => reply.code(204).send());
  await registerAppsRoutes(app);
  await registerAuditRoutes(app);
  await registerBackupRoutes(app);
  await registerDeployRoutes(app);
  await registerDiagnosticsRoutes(app);
  await registerProxyRoutes(app);
  await registerSettingsRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  Object.assign(config, originalConfig);
});

function privilegedRoutes() {
  return routes.filter(({ method, url }) =>
    method !== 'GET' || !['/api/health', '/api/apps'].includes(url)
  );
}

test('every privileged route fails closed without a token on a non-loopback host', async (t) => {
  for (const route of privilegedRoutes()) {
    await t.test(`${route.method} ${route.url}`, async () => {
      const response = await app.inject(route);
      assert.equal(response.statusCode, 503);
      if (route.method !== 'HEAD') assert.match(response.json().message, /ADMIN_TOKEN/);
    });
  }
});

test('empty-token development is open only on explicit loopback hosts', async () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '::1', 'localhost']) {
    config.host = host;
    assert.equal((await app.inject({ method: 'POST', url: '/api/deploy/docker-run' })).statusCode, 204, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'host.local', '127.0.0.1.example.com', '']) {
    config.host = host;
    assert.equal((await app.inject({ method: 'POST', url: '/api/deploy/docker-run' })).statusCode, 503, host);
  }
});

test('every privileged route rejects missing or incorrect tokens and accepts supported token headers', async () => {
  config.adminToken = randomBytes(32).toString('hex');
  for (const route of privilegedRoutes()) {
    for (const headers of [{}, { authorization: 'Bearer incorrect' }]) {
      assert.equal((await app.inject({ ...route, headers })).statusCode, 401, `${route.method} ${route.url}`);
    }
    for (const headers of [
      { authorization: `Bearer ${config.adminToken}` },
      { 'x-the-containers-token': config.adminToken },
      { 'x-naviproxy-token': config.adminToken }
    ]) {
      assert.equal((await app.inject({ ...route, headers })).statusCode, 204, `${route.method} ${route.url}`);
    }
  }
});

test('health and the public dashboard remain available without a token', async () => {
  for (const adminToken of ['', randomBytes(32).toString('hex')]) {
    config.adminToken = adminToken;
    for (const url of ['/api/health', '/api/apps?category=tools']) {
      assert.equal((await app.inject({ url })).statusCode, 204);
    }
  }
});

test('dashboard auth fails closed without a token for either configuration source, including loopback', async () => {
  for (const host of ['0.0.0.0', '127.0.0.1']) {
    config.host = host;
    for (const source of ['config', 'settings']) {
      config.dashboardAuthRequired = source === 'config';
      dashboardAuthRequired = source === 'settings';
      assert.equal((await app.inject({ url: '/api/apps' })).statusCode, 503);
      assert.equal((await app.inject({ url: '/api/health' })).statusCode, 204);
      config.adminToken = randomBytes(32).toString('hex');
      assert.equal((await app.inject({ url: '/api/apps' })).statusCode, 401);
      assert.equal((await app.inject({ url: '/api/apps', headers: { authorization: `Bearer ${config.adminToken}` } })).statusCode, 204);
      config.adminToken = '';
    }
  }
});
