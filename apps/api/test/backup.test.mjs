import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { config } from '../src/config.ts';
import { registerBackupRoutes } from '../src/modules/backup/backup.routes.ts';

const file = (name, content = 'restored') => ({ path: name, encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) });

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-')));
  const previous = { ...config };
  config.deploymentsPath = path.join(root, 'deployments');
  config.dockerBin = path.join(root, 'no-docker');
  let mutations = 0;
  const app = Fastify();
  await registerBackupRoutes(app, {
    exportDeployments: () => [], exportApps: () => ({ apps: [] }),
    restoreBackup: async () => { mutations++; return { apps: [], deployments: 0 }; }
  }, { getAll: () => ({}) }, { record: () => { mutations++; } });
  t.after(async () => { await app.close(); Object.assign(config, previous); await fs.rm(root, { recursive: true, force: true }); });
  return { root, app, mutations: () => mutations };
}

test('restore rejects an unapproved project destination before any files or records change', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, '.ssh/authorized_keys');
  const response = await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload: {
    apps: [], deploymentFiles: [file('valid.txt')],
    dockerProjectFiles: [{ ...file('authorized_keys'), absolutePath: target }]
  } });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(f.mutations(), 0);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  await assert.rejects(fs.stat(config.deploymentsPath), { code: 'ENOENT' });
});

async function preview(f, payload) {
  const response = await f.app.inject({ method: 'POST', url: '/api/backup/restore/preview', payload });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function restore(f, payload) {
  const plan = await preview(f, payload);
  return f.app.inject({ method: 'POST', url: '/api/backup/restore', payload, headers: { 'x-backup-confirmation': plan.confirmation } });
}

test('preview lists deployment and declared bind destinations; restore requires confirmation of that exact manifest', async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, 'bind');
  const payload = { apps: [], deploymentFiles: [file('compose.yml')], dockerDataArchives: [{ type: 'bind', source, files: [file('run.sh')] }] };
  const plan = await preview(f, payload);
  assert.deepEqual(plan.destinations, [path.join(config.deploymentsPath, 'compose.yml'), path.join(source, 'run.sh')]);
  assert.equal(f.mutations(), 0);
  const unconfirmed = await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload });
  assert.equal(unconfirmed.statusCode, 400);
  const changed = await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload: { ...payload, deploymentFiles: [file('different')] }, headers: { 'x-backup-confirmation': plan.confirmation } });
  assert.equal(changed.statusCode, 400);
  const response = await restore(f, payload);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(await fs.readFile(path.join(source, 'run.sh'), 'utf8'), 'restored');
});

for (const kind of ['deployment', 'project', 'bind']) {
  test(`restore rejects ${kind} symlink escapes before mutating records`, async (t) => {
    const f = await fixture(t);
    await fs.mkdir(config.deploymentsPath);
    await fs.mkdir(path.join(f.root, 'outside'));
    await fs.symlink(path.join(f.root, 'outside'), path.join(config.deploymentsPath, 'link'));
    const payload = { apps: [] };
    if (kind === 'deployment') payload.deploymentFiles = [file('link/evil')];
    if (kind === 'project') payload.dockerProjectFiles = [{ ...file('evil'), absolutePath: path.join(config.deploymentsPath, 'link/evil') }];
    if (kind === 'bind') payload.dockerDataArchives = [{ type: 'bind', source: path.join(config.deploymentsPath, 'link'), files: [file('evil')] }];
    const response = await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(f.mutations(), 0);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'outside')), []);
  });
}

test('restore validates all archive entries instead of silently skipping malformed or traversing files', async (t) => {
  const f = await fixture(t);
  for (const invalid of [file('../evil'), { ...file('evil'), encoding: 'utf8' }, { ...file('evil'), content: '!!!' }]) {
    const response = await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload: {
      apps: [], deploymentFiles: [file('first')], dockerDataArchives: [{ type: 'bind', source: path.join(f.root, 'bind'), files: [invalid] }]
    } });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(f.mutations(), 0);
  }
});

for (const bytes of [786432, 800000, 1048576]) {
  test(`an exported ${bytes}-byte deployment file round-trips through the real restore route above 1 MiB JSON`, async (t) => {
    const f = await fixture(t);
    await fs.mkdir(config.deploymentsPath);
    const target = path.join(config.deploymentsPath, 'large.bin');
    await fs.writeFile(target, Buffer.alloc(bytes, 'a'));
    const exported = await f.app.inject({ url: '/api/backup' });
    assert.equal(exported.statusCode, 200);
    assert.ok(Buffer.byteLength(exported.body) > 1024 * 1024);
    await fs.rm(target);
    const response = await restore(f, exported.json());
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await fs.readFile(target), Buffer.alloc(bytes, 'a'));
  });
}

test('export and restore preserve executable mode and ownership metadata', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(config.deploymentsPath);
  const target = path.join(config.deploymentsPath, 'run.sh');
  await fs.writeFile(target, '#!/bin/sh\necho yes\n', { mode: 0o755 });
  const original = await fs.stat(target);
  const exported = (await f.app.inject({ url: '/api/backup' })).json();
  assert.equal(exported.deploymentFiles[0].mode, 0o755);
  assert.equal(exported.deploymentFiles[0].uid, original.uid);
  assert.equal(exported.deploymentFiles[0].gid, original.gid);
  await fs.chmod(target, 0o600);
  const response = await restore(f, exported);
  assert.equal(response.statusCode, 200, response.body);
  const stat = await fs.stat(target);
  assert.equal(stat.mode & 0o777, 0o755);
  assert.equal(stat.uid, original.uid);
  assert.equal(stat.gid, original.gid);
});

test('bind restore attempts a non-service UID and warns on denied ownership without losing executable mode or failing restore', async (t) => {
  const f = await fixture(t);
  const requestedUid = process.getuid() === 1000 ? 1001 : 1000;
  const attempts = [];
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    handle.chown = async (uid, gid) => {
      attempts.push([uid, gid]);
      throw Object.assign(new Error('Ownership not permitted'), { code: 'EPERM' });
    };
    return handle;
  });
  const source = path.join(f.root, 'bind');
  const response = await restore(f, { apps: [], dockerDataArchives: [{ type: 'bind', source, files: [{ ...file('run.sh'), mode: 0o755, uid: requestedUid, gid: 1000 }] }] });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(attempts, [[requestedUid, 1000]]);
  assert.equal((await fs.stat(path.join(source, 'run.sh'))).mode & 0o777, 0o755);
  assert.equal(response.json().dockerDataFiles, 1);
  assert.match(response.json().warnings.join('\n'), /ownership.*1000/i);
});

async function fakeDocker(f, { containers = [], failCopy = false } = {}) {
  const executable = path.join(f.root, 'docker-fixture');
  const trace = path.join(f.root, 'docker-calls.jsonl');
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
const containers = ${JSON.stringify(containers)};
if (args[0] === 'ps') console.log(containers.map(c => c.Name.replace(/^\\//, '')).join('\\n'));
if (args[0] === 'inspect') console.log(JSON.stringify(containers.filter(c => c.Name === '/' + args[1])));
if (args[0] === 'cp') {
  if (${failCopy}) process.exit(1);
  const source = args.find(a => a.endsWith('/.'));
  const stat = fs.statSync(path.join(source, 'run.sh'));
  fs.writeFileSync(${JSON.stringify(path.join(f.root, 'copied.json'))}, JSON.stringify({ mode: stat.mode & 511, uid: stat.uid, gid: stat.gid }));
}
`, { mode: 0o755 });
  config.dockerBin = executable;
  return async () => (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
}

test('an export containing the same managed compose file in two sections can be restored', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(config.deploymentsPath);
  const target = path.join(config.deploymentsPath, 'compose.yml');
  await fs.writeFile(target, 'services: {}\n');
  await fakeDocker(f, { containers: [{ Name: '/web', Config: { Labels: { 'com.docker.compose.project.config_files': target } } }] });
  const exported = (await f.app.inject({ url: '/api/backup' })).json();
  assert.equal(exported.deploymentFiles.length, 1);
  assert.equal(exported.dockerProjectFiles.length, 1);
  const response = await restore(f, exported);
  assert.equal(response.statusCode, 200, response.body);
});

test('discovered compose directories and Docker bind exports retain executable metadata', async (t) => {
  const f = await fixture(t);
  const project = path.join(f.root, 'compose');
  const source = path.join(f.root, 'bind');
  await fs.mkdir(project);
  await fs.mkdir(source);
  await fs.writeFile(path.join(project, 'compose.yml'), 'services: {}\n', { mode: 0o640 });
  await fs.writeFile(path.join(source, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  await fakeDocker(f, { containers: [{ Name: '/web', Config: { Labels: { 'com.docker.compose.project.config_files': path.join(project, 'compose.yml') } }, Mounts: [{ Type: 'bind', Source: source, Destination: '/data' }] }] });
  const exported = (await f.app.inject({ url: '/api/backup' })).json();
  assert.equal(exported.dockerDataArchives[0].files[0].mode, 0o755);
  assert.equal(exported.dockerDataArchives[0].files[0].uid, process.getuid());
  assert.equal(exported.dockerProjectFiles[0].mode, 0o640);
  await fs.rm(path.join(source, 'run.sh'));
  const response = await restore(f, exported);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await fs.stat(path.join(source, 'run.sh'))).mode & 0o777, 0o755);
});

test('named volumes copy staged modes and owners with docker cp -a', async (t) => {
  const f = await fixture(t);
  const calls = await fakeDocker(f);
  const response = await restore(f, { apps: [], dockerDataArchives: [{ type: 'volume', name: 'test-data', source: path.join(f.root, 'unused'), files: [{ ...file('run.sh'), mode: 0o755, uid: process.getuid(), gid: process.getgid() }] }] });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, 'copied.json'), 'utf8')), { mode: 0o755, uid: process.getuid(), gid: process.getgid() });
  assert.equal((await calls()).find(args => args[0] === 'cp')[1], '-a');
});

test('failed volume restoration never falls back to writing the manifest host source', async (t) => {
  const f = await fixture(t);
  await fakeDocker(f, { failCopy: true });
  const source = path.join(f.root, '.ssh');
  const response = await restore(f, { apps: [], dockerDataArchives: [{ type: 'volume', name: 'test-data', source, files: [file('run.sh')] }] });
  assert.equal(response.statusCode, 500);
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
});

test('symlink replacement after preview is rejected before records change', async (t) => {
  const f = await fixture(t);
  const payload = { apps: [], deploymentFiles: [file('file')] };
  const plan = await preview(f, payload);
  await fs.mkdir(config.deploymentsPath);
  await fs.writeFile(path.join(f.root, 'outside'), 'unchanged');
  await fs.symlink(path.join(f.root, 'outside'), path.join(config.deploymentsPath, 'file'));
  const response = await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload, headers: { 'x-backup-confirmation': plan.confirmation } });
  assert.equal(response.statusCode, 400);
  assert.equal(f.mutations(), 0);
  assert.equal(await fs.readFile(path.join(f.root, 'outside'), 'utf8'), 'unchanged');
});

test('conflicting volume paths are rejected before database changes or Docker calls', async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload: {
    apps: [], dockerDataArchives: [{ type: 'volume', name: 'data', source: path.join(f.root, 'unused'), files: [file('a'), file('a/b')] }]
  } });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().message, /Conflicting/);
  assert.equal(f.mutations(), 0);
});

test('restore body limit is bounded while other routes retain the default 1 MiB limit', async (t) => {
  const f = await fixture(t);
  f.app.post('/ordinary', async () => ({ ok: true }));
  for (const url of ['/api/backup/restore', '/api/backup/restore/preview']) {
    const response = await f.app.inject({ method: 'POST', url, payload: '{}', headers: { 'content-type': 'application/json', 'content-length': String(1024 ** 3) } });
    assert.equal(response.statusCode, 413, response.body);
  }
  const response = await f.app.inject({ method: 'POST', url: '/ordinary', payload: { content: 'a'.repeat(1024 * 1024) } });
  assert.equal(response.statusCode, 413);
});

test('a hard-linked target is rejected without changing the other file', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(config.deploymentsPath);
  const original = path.join(f.root, 'original');
  await fs.writeFile(original, 'unchanged');
  await fs.link(original, path.join(config.deploymentsPath, 'linked'));
  const response = await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload: { apps: [], deploymentFiles: [file('linked')] } });
  assert.equal(response.statusCode, 400);
  assert.equal(await fs.readFile(original, 'utf8'), 'unchanged');
  assert.equal(f.mutations(), 0);
});
