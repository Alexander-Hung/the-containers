import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { config } from '../src/config.ts';
import { createDatabase } from '../src/db/database.ts';
import { AppsRepo } from '../src/modules/apps/apps.repo.ts';
import { AppsService } from '../src/modules/apps/apps.service.ts';
import { ProxyService } from '../src/modules/proxy/proxy.service.ts';
import { SettingsService } from '../src/modules/settings/settings.service.ts';
import { registerBackupRoutes } from '../src/modules/backup/backup.routes.ts';

const file = (name, content = 'restored') => ({ path: name, encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) });

async function fixture(t, { failDatabase = false, realDatabase = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'backup-test-')));
  const previous = { ...config };
  config.deploymentsPath = path.join(root, 'deployments');
  config.dockerBin = path.join(root, 'no-docker');
  let mutations = 0;
  config.databasePath = path.join(root, 'test.sqlite');
  config.caddySyncEnabled = false;
  const db = realDatabase ? createDatabase() : null;
  const settings = db ? new SettingsService(db) : { getAll: () => ({}) };
  const service = db ? new AppsService(db, new ProxyService(db, new AppsRepo(db), settings)) : {
    exportDeployments: () => [], exportApps: () => ({ apps: [] }),
    restoreBackup: async () => { if (failDatabase) throw new Error('database transaction failed'); mutations++; return { apps: [], deployments: 0 }; }
  };
  const app = Fastify();
  await registerBackupRoutes(app, service, settings, { record: () => { mutations++; } });
  t.after(async () => { await app.close(); db?.close(); Object.assign(config, previous); await fs.rm(root, { recursive: true, force: true }); });
  return { root, app, service, db, mutations: () => mutations };
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

async function fakeDocker(f, { containers = [], failCopy = false, failApply = false, failRollback = false } = {}) {
  const executable = path.join(f.root, 'docker-fixture');
  const trace = path.join(f.root, 'docker-calls.jsonl');
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const volumeRoot = ${JSON.stringify(path.join(f.root, 'volume-fixture'))};
fs.mkdirSync(volumeRoot, { recursive: true });
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
const containers = ${JSON.stringify(containers)};
if (args[0] === 'ps') console.log(containers.map(c => c.Name.replace(/^\\//, '')).join('\\n'));
if (args[0] === 'inspect') console.log(JSON.stringify(containers.filter(c => c.Name === '/' + args[1])));
if (args[0] === 'exec') {
  let command = args.slice(2).map(arg => arg.startsWith('/restore') ? volumeRoot + arg.slice(8) : arg);
  if (command[0] === 'sh') {
    if (process.platform === 'darwin') command[2] = command[2].replaceAll('stat -c %h', 'stat -f %l').replaceAll('stat -c %u', 'stat -f %u').replaceAll('stat -c %g', 'stat -f %g');
    if (${failApply} && command[4] === 'apply') command[2] = command[2].replace('mv "$work/new/$relative" "$target"', 'if [ "$i" = 1 ]; then exit 42; fi; mv "$work/new/$relative" "$target"');
    if (${failRollback} && command[4] === 'rollback') process.exit(43);
  }
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8' });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
if (args[0] === 'cp') {
  if (${failCopy}) process.exit(1);
  const source = args.find(a => a.endsWith('/.'));
  const destination = args.at(-1).split(':').slice(1).join(':').replace('/restore', volumeRoot);
  fs.cpSync(source, destination, { recursive: true });
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
  assert.equal(await fs.readFile(path.join(f.root, 'volume-fixture/run.sh'), 'utf8'), 'restored');
  assert.equal((await fs.stat(path.join(f.root, 'volume-fixture/run.sh'))).mode & 0o777, 0o755);
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

for (const phase of ['stage', 'rename']) {
  test(`restore ${phase} failure leaves all original files and records intact`, async (t) => {
    const f = await fixture(t);
    await fs.mkdir(config.deploymentsPath);
    const first = path.join(config.deploymentsPath, 'first');
    const second = path.join(config.deploymentsPath, 'second');
    await fs.writeFile(first, 'original-first', { mode: 0o751 });
    await fs.writeFile(second, 'original-second');
    const payload = { apps: [], deploymentFiles: [file('first'), file('second')] };
    const plan = await preview(f, payload);
    if (phase === 'stage') {
      const open = fs.open.bind(fs);
      let writes = 0;
      t.mock.method(fs, 'open', async (...args) => {
        const handle = await open(...args);
        const writeFile = handle.writeFile.bind(handle);
        handle.writeFile = async (...values) => {
          if (++writes === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          return writeFile(...values);
        };
        return handle;
      });
    } else {
      const rename = fs.rename.bind(fs);
      t.mock.method(fs, 'rename', async (from, to) => {
        if (to === second && from !== second && !from.endsWith('original')) throw new Error('rename failed');
        return rename(from, to);
      });
    }
    const response = await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload,
      headers: { 'x-backup-confirmation': plan.confirmation } });
    assert.equal(response.statusCode, 500, response.body);
    assert.equal(await fs.readFile(first, 'utf8'), 'original-first');
    assert.equal(await fs.readFile(second, 'utf8'), 'original-second');
    assert.equal((await fs.stat(first)).mode & 0o777, 0o751);
    assert.equal(f.mutations(), 0);
    assert.equal(response.json().restore.database, 'unchanged');
    assert.equal(response.json().restore.files, 'rolled_back');
    assert.deepEqual(await fs.readdir(config.deploymentsPath), ['first', 'second']);
  });
}


test('database transaction failure rolls files back and removes newly restored files', async (t) => {
  const f = await fixture(t, { failDatabase: true });
  await fs.mkdir(config.deploymentsPath);
  const target = path.join(config.deploymentsPath, 'existing');
  await fs.writeFile(target, 'original');
  const response = await restore(f, { apps: [], deploymentFiles: [file('existing'), file('new')] });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  await assert.rejects(fs.stat(path.join(config.deploymentsPath, 'new')), { code: 'ENOENT' });
  assert.equal(f.mutations(), 0);
  assert.equal(response.json().restore.files, 'rolled_back');
});


for (const failure of ['copy', 'apply', 'database']) {
  test(`named volume ${failure} failure restores originals before leaving records unchanged`, async (t) => {
    const f = await fixture(t, { failDatabase: failure === 'database' });
    const volume = path.join(f.root, 'volume-fixture');
    await fs.mkdir(volume);
    await fs.writeFile(path.join(volume, 'run.sh'), 'original', { mode: 0o751 });
    await fs.writeFile(path.join(volume, 'second'), 'original-second');
    await fakeDocker(f, { failCopy: failure === 'copy', failApply: failure === 'apply' });
    const response = await restore(f, { apps: [], deploymentFiles: [file('new-host-file')], dockerDataArchives: [
      { type: 'volume', name: 'test-data', source: path.join(f.root, 'unused'), files: [file('run.sh'), file('second'), file('new-volume-file')] }
    ] });
    assert.equal(response.statusCode, 500, response.body);
    if (failure === 'database') assert.match(response.json().message, /database transaction failed/);
    if (failure === 'apply') assert.match(response.json().message, /apply/);
    assert.equal(await fs.readFile(path.join(volume, 'run.sh'), 'utf8'), 'original');
    assert.equal(await fs.readFile(path.join(volume, 'second'), 'utf8'), 'original-second');
    assert.equal((await fs.stat(path.join(volume, 'run.sh'))).mode & 0o777, 0o751);
    assert.deepEqual(await fs.readdir(volume), ['run.sh', 'second']);
    await assert.rejects(fs.stat(path.join(config.deploymentsPath, 'new-host-file')), { code: 'ENOENT' });
    assert.equal(f.mutations(), 0);
    assert.equal(response.json().restore.files, 'rolled_back');
  });
}

test('incomplete volume rollback reports partial results and retains originals for recovery', async (t) => {
  const f = await fixture(t, { failDatabase: true });
  const volume = path.join(f.root, 'volume-fixture');
  await fs.mkdir(volume);
  await fs.writeFile(path.join(volume, 'run.sh'), 'original');
  await fakeDocker(f, { failRollback: true });
  const response = await restore(f, { apps: [], dockerDataArchives: [
    { type: 'volume', name: 'test-data', source: path.join(f.root, 'unused'), files: [file('run.sh')] }
  ] });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.json().restore.files, 'partial', response.body);
  assert.equal(response.json().restore.database, 'unchanged');
  assert.match(response.json().restore.rollbackErrors[0], /volume:test-data.*originals:/s);
  const staging = (await fs.readdir(volume)).find(name => name.startsWith('.the-containers-restore-'));
  assert.equal(await fs.readFile(path.join(volume, staging, '0/original'), 'utf8'), 'original');
});


test('failed host rollback reports the retained original instead of claiming an atomic restore', async (t) => {
  const f = await fixture(t, { failDatabase: true });
  await fs.mkdir(config.deploymentsPath);
  const target = path.join(config.deploymentsPath, 'existing');
  await fs.writeFile(target, 'original');
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from.endsWith('/original')) throw new Error('rollback permission denied');
    return rename(from, to);
  });
  const response = await restore(f, { apps: [], deploymentFiles: [file('existing')] });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().restore.files, 'partial');
  assert.match(response.json().restore.rollbackErrors[0], /rollback permission denied.*originals:/);
  const staging = (await fs.readdir(config.deploymentsPath)).find(name => name.startsWith('.the-containers-restore-'));
  assert.equal(await fs.readFile(path.join(config.deploymentsPath, staging, 'original'), 'utf8'), 'original');
});

test('overlapping restores are rejected while the first restore owns its staged originals', async (t) => {
  const f = await fixture(t);
  let release;
  let entered;
  const paused = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const open = fs.open.bind(fs);
  let blocked = false;
  t.mock.method(fs, 'open', async (...args) => {
    if (!blocked) { blocked = true; entered(); await resume; }
    return open(...args);
  });
  const payload = { apps: [], deploymentFiles: [file('one')] };
  const plan = await preview(f, payload);
  const first = f.app.inject({ method: 'POST', url: '/api/backup/restore', payload,
    headers: { 'x-backup-confirmation': plan.confirmation } }).then(response => response);
  await paused;
  try {
    const other = await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload: { apps: [] } });
    assert.equal(other.statusCode, 409);
    assert.match(other.json().message, /in progress/);
  } finally { release(); }
  assert.equal((await first).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/backup/restore', payload: { apps: [] } })).statusCode, 200);
});


test('real SQLite transaction failure restores host files, apps, deployments, and snapshot history', async (t) => {
  const f = await fixture(t, { realDatabase: true });
  const { app } = await f.service.create({ name: 'original', slug: 'original', targetUrl: 'http://127.0.0.1:18080',
    routeMode: 'subdomain', publicHost: 'original.test' });
  f.db.prepare(`INSERT INTO deployment_records (app_id, provider, resource_id, resource_name)
    VALUES (?, 'docker', 'old-id', 'original')`).run(app.id);
  const deployments = f.service.exportDeployments();
  const before = f.service.exportApps().apps;
  const snapshots = f.service.listBackupSnapshots();
  await fs.mkdir(config.deploymentsPath);
  const target = path.join(config.deploymentsPath, 'compose.yml');
  await fs.writeFile(target, 'original');
  f.db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON apps BEGIN SELECT RAISE(ABORT, 'restore fixture failure'); END");
  const response = await restore(f, { apps: [{ ...app, id: 'replacement', name: 'replacement', slug: 'replacement' }],
    deploymentFiles: [file('compose.yml'), file('new')] });
  assert.equal(response.statusCode, 500, response.body);
  assert.match(response.json().message, /restore fixture failure/);
  assert.equal(response.json().restore.files, 'rolled_back');
  assert.deepEqual(f.service.exportApps().apps, before);
  assert.deepEqual(f.service.listBackupSnapshots(), snapshots);
  assert.deepEqual(f.service.exportDeployments(), deployments);
  assert.equal(await fs.readFile(target, 'utf8'), 'original');
  await assert.rejects(fs.stat(path.join(config.deploymentsPath, 'new')), { code: 'ENOENT' });
});
