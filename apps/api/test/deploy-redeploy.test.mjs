import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { config } from '../src/config.ts';
import { DeployService } from '../src/modules/deploy/deploy.service.ts';

async function fixture(t, { fail = '', running = true, missing = false, command = '-v /data' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redeploy-test-'));
  const previous = config.dockerBin;
  const statePath = path.join(root, 'state.json');
  const trace = path.join(root, 'calls.jsonl');
  const original = { Id: 'old-id', Name: '/web', Config: { Image: 'nginx' }, State: { Running: running },
    Mounts: [{ Type: 'volume', Name: 'anonymous-data', Destination: '/data', RW: true },
      { Type: 'volume', Name: 'image-volume', Destination: '/image-data', RW: false }] };
  await fs.writeFile(statePath, JSON.stringify(missing ? {} : { web: original }));
  const executable = path.join(root, 'docker');
  await fs.writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(file));
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
const fail = ${JSON.stringify(fail)};
function error(message) { console.error(message); process.exit(1); }
if (args[0] === 'inspect') {
  if (!state[args[1]]) error('No such container');
  console.log(JSON.stringify([state[args[1]]]));
} else if (args[0] === 'create' || args[0] === 'run') {
  if (fail === 'create') error('create failed');
  const name = args[args.indexOf('--name') + 1];
  if (state[name]) error('name conflict');
  state[name] = { Id: 'new-id', Name: '/' + name, State: { Running: args[0] === 'run' } };
  console.log('new-id');
} else if (args[0] === 'rename') {
  if (state[args[2]]) error('name conflict');
  state[args[2]] = state[args[1]];
  state[args[2]].Name = '/' + args[2];
  delete state[args[1]];
} else if (args[0] === 'start' || args[0] === 'stop') {
  if (fail === 'start' && state[args[1]].Id === 'new-id') error('start failed');
  state[args[1]].State.Running = args[0] === 'start';
} else if (args[0] === 'rm') {
  delete state[args.at(-1)];
}
fs.writeFileSync(file, JSON.stringify(state));
`, { mode: 0o755 });
  config.dockerBin = executable;
  let updates = 0;
  const row = { app_id: 'app', provider: 'docker', resource_id: 'old-id', resource_name: 'web',
    deploy_input: JSON.stringify({ command: `docker run --name web -p 18080:80 ${command} nginx echo -v untouched`, publicHost: 'web.test' }) };
  const db = { prepare: () => ({ get: () => row, run: (input) => {
    if (fail === 'database') throw new Error('runtime update failed');
    updates++; row.resource_id = input.resourceId;
  } }) };
  const service = new DeployService(db, {});
  t.after(async () => { config.dockerBin = previous; await fs.rm(root, { recursive: true, force: true }); });
  return { service, updates: () => updates, state: async () => JSON.parse(await fs.readFile(statePath, 'utf8')),
    calls: async () => (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse) };
}

for (const command of ['-v /data', '--volume=/data', '-v/data', '--mount type=volume,destination=/data']) {
  test(`redeploy reattaches explicit and image anonymous volumes (${command}) before removing old container`, async (t) => {
    const f = await fixture(t, { command });
    await f.service.manageDeployment('app', 'redeploy');
    const calls = await f.calls();
    assert.ok(!calls.some(args => args[0] === 'rm' && args.some(arg => arg === '-fv' || arg === '-v')));
    const create = calls.find(args => args[0] === 'create');
    assert.ok(create, 'replacement must be created before destroying the old container');
    assert.ok(create.some(arg => arg.includes('anonymous-data') && arg.includes('/data')));
    assert.ok(create.some(arg => arg.includes('image-volume') && arg.includes('/image-data') && /ro|readonly/.test(arg)));
    assert.deepEqual(create.slice(-4), ['nginx', 'echo', '-v', 'untouched']);
    assert.ok(calls.findIndex(args => args[0] === 'create') < calls.findIndex(args => args[0] === 'stop'));
    assert.ok(calls.findIndex(args => args[0] === 'start') < calls.findIndex(args => args[0] === 'rm'));
    assert.equal((await f.state()).web.Id, 'new-id');
    assert.equal(f.updates(), 1);
  });
}
for (const fail of ['create', 'start', 'database']) {
  for (const running of [true, false]) {
    test(`redeploy rolls back ${fail} failure with original running=${running}`, async (t) => {
      const f = await fixture(t, { fail, running });
      await assert.rejects(f.service.manageDeployment('app', 'redeploy'));
      assert.deepEqual(Object.keys(await f.state()), ['web']);
      assert.equal((await f.state()).web.Id, 'old-id');
      assert.equal((await f.state()).web.State.Running, running);
      assert.equal(f.updates(), 0);
    });
  }
}
test('redeploy preview lists attached anonymous volumes and replacement order', async (t) => {
  const f = await fixture(t);
  const preview = await f.service.redeployPreview('app');
  assert.match(preview.preserved.join('\n'), /anonymous/i);
  assert.match(preview.preserved.join('\n'), /anonymous-data.*\/data/);
  assert.match(preview.preserved.join('\n'), /image-volume.*\/image-data/);
  assert.doesNotMatch(preview.removed.join('\n'), /before recreation/);
});
test('redeploy can recreate a missing container', async (t) => {
  const f = await fixture(t, { missing: true });
  await f.service.manageDeployment('app', 'redeploy');
  assert.equal((await f.state()).web.State.Running, true);
});


test('redeploy retains named volume options and Docker option values that equal the image', async (t) => {
  const f = await fixture(t, { command: '--env nginx -v named-data:/data:ro' });
  await f.service.manageDeployment('app', 'redeploy');
  const create = (await f.calls()).find(args => args[0] === 'create');
  assert.ok(create.includes('named-data:/data:ro'));
  assert.ok(!create.some(arg => arg.includes('anonymous-data')));
  assert.deepEqual(create.slice(create.indexOf('--env'), create.indexOf('--env') + 2), ['--env', 'nginx']);
  assert.deepEqual(create.slice(-4), ['nginx', 'echo', '-v', 'untouched']);
});
