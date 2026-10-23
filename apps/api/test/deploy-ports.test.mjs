import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { test } from 'node:test';
import { parse, stringify } from 'yaml';
import { AppsService } from '../src/modules/apps/apps.service.ts';
import { DeployService } from '../src/modules/deploy/deploy.service.ts';

function previewService(t, occupiedPorts = []) {
  // Model port availability without opening sockets or contacting Docker.
  t.mock.method(net, 'createServer', () => {
    const server = new EventEmitter();
    server.listen = (port) => {
      queueMicrotask(() => server.emit(occupiedPorts.includes(port) ? 'error' : 'listening'));
      return server;
    };
    server.close = (callback) => callback();
    return server;
  });
  // Only read queries used by app validation are allowed; no real database is opened.
  const db = { prepare: () => ({ get: () => undefined, all: () => [] }) };
  return new DeployService(db, new AppsService(db, {}));
}

function publishedArgs(plan) {
  return plan.dockerArgs.flatMap((arg, index, args) => arg === '-p' ? [args[index + 1]] : []);
}

const route = { publicHost: 'ports.test' };

test('docker preview keeps every TCP and UDP mapping and remaps only the selected port', async (t) => {
  const plan = await previewService(t, [18080]).preview({
    ...route,
    command: 'docker run -p 127.0.0.1:18080:80 --publish=18082:81 -p5353:53/udp nginx'
  });
  assert.deepEqual(publishedArgs(plan), ['127.0.0.1:18081:80/tcp', '18082:81/tcp', '5353:53/udp']);
});

test('docker preview keeps a UDP-only publication as UDP', async (t) => {
  const plan = await previewService(t).preview({ ...route, command: 'docker run -p 5353:53/udp dns' });
  assert.deepEqual(publishedArgs(plan), ['5353:53/udp']);
  assert.equal(plan.protocol, 'udp');
});

for (const [containerPort, expected] of [
  [81, ['127.0.0.1:18080:80/tcp', '127.0.0.2:18090:81/tcp']],
  [82, ['127.0.0.1:18080:80/tcp', '127.0.0.2:18081:81/tcp', '127.0.0.1:18090:82/tcp']]
]) {
  test(`docker preview keeps other mappings when explicitly selecting container port ${containerPort}`, async (t) => {
    const plan = await previewService(t).preview({
      ...route,
      command: 'docker run -p 127.0.0.1:18080:80 -p 127.0.0.2:18081:81 nginx',
      containerPort,
      hostPort: 18090
    });
    assert.deepEqual(publishedArgs(plan), expected);
  });
}

test('docker preview preserves a loopback bind and protocol when remapping', async (t) => {
  const plan = await previewService(t).preview({
    ...route,
    command: 'docker run -p 127.0.0.1:18080:80/tcp nginx',
    hostPort: 18090
  });
  assert.deepEqual(publishedArgs(plan), ['127.0.0.1:18090:80/tcp']);
});

for (const [syntax, original, expected] of [
  ['short', '127.0.0.1:18090:80/tcp', '127.0.0.1:18091:80/tcp'],
  ['short IPv6', '[::1]:18090:80/tcp', '[::1]:18091:80/tcp'],
  ['long', { target: 80, published: '18090', host_ip: '127.0.0.1', protocol: 'tcp', mode: 'host', name: 'web' },
    { target: 80, published: '18091', host_ip: '127.0.0.1', protocol: 'tcp', mode: 'host', name: 'web' }],
  ['long UDP', { target: 53, published: '5353', host_ip: '127.0.0.1', protocol: 'udp' },
    { target: 53, published: '18091', host_ip: '127.0.0.1', protocol: 'udp' }]
]) {
  test(`compose preview preserves ${syntax} bind and protocol when remapping`, async (t) => {
    const plan = await previewService(t).preview({
      ...route,
      method: 'docker_compose',
      command: stringify({ services: { web: { image: 'nginx', ports: [original, '5354:54/udp'] } } }),
      hostPort: 18091
    });
    assert.deepEqual(parse(plan.composeContent).services.web.ports, [expected, '5354:54/udp']);
    if (syntax === 'short IPv6') assert.equal(plan.targetUrl, 'http://[::1]:18091');
  });
}

test('compose preview chooses TCP ahead of UDP and preserves the other services', async (t) => {
  const other = { image: 'redis', ports: ['127.0.0.1:16379:6379'] };
  const udp = { target: 53, published: '5353', protocol: 'udp', host_ip: '127.0.0.1' };
  const plan = await previewService(t).preview({
    ...route,
    method: 'docker_compose',
    command: stringify({ services: { web: { image: 'nginx', ports: [udp, '192.0.2.10:18080:80'] }, cache: other } }),
    hostPort: 18081
  });
  const services = parse(plan.composeContent).services;
  assert.deepEqual(services.web.ports, [udp, '192.0.2.10:18081:80/tcp']);
  assert.deepEqual(services.cache, other);
  assert.equal(plan.targetUrl, 'http://192.0.2.10:18081');
});

for (const method of ['docker_run', 'docker_compose']) {
  test(`${method} preview leaves host networking without published ports`, async (t) => {
    const command = method === 'docker_run'
      ? 'docker run --network host -p 18080:80 nginx'
      : 'services:\n  web:\n    image: nginx\n    network_mode: host\n';
    const plan = await previewService(t).preview({ ...route, method, command });
    if (method === 'docker_run') assert.deepEqual(publishedArgs(plan), []);
    else assert.equal(plan.composeContent, command.trim());
  });
}

for (const method of ['docker_run', 'docker_compose']) {
  test(`${method} preview binds a newly injected proxy port to loopback`, async (t) => {
    const plan = await previewService(t).preview({
      ...route,
      method,
      command: method === 'docker_run' ? 'docker run nginx' : 'services:\n  web:\n    image: nginx\n'
    });
    const ports = method === 'docker_run' ? publishedArgs(plan) : parse(plan.composeContent).services.web.ports;
    assert.deepEqual(ports, ['127.0.0.1:18080:80/tcp']);
  });
}

test('docker preview retains duplicate targets, IPv6, random host ports, and command arguments', async (t) => {
  const plan = await previewService(t).preview({
    ...route,
    command: 'docker run --publish 5353:53/udp -p [::1]:18080:80 -p 127.0.0.2:18090:80 -p 54/udp -p [::1]::55/udp nginx echo -p unchanged',
    hostPort: 18081
  });
  assert.deepEqual(publishedArgs(plan).slice(0, 5), [
    '5353:53/udp', '[::1]:18081:80/tcp', '127.0.0.2:18090:80/tcp', '54/udp', '[::1]::55/udp'
  ]);
  assert.deepEqual(plan.dockerArgs.slice(-4), ['nginx', 'echo', '-p', 'unchanged']);
  assert.equal(plan.targetUrl, 'http://[::1]:18081');
});

test('docker preview does not allocate a port already reserved by another mapping', async (t) => {
  const plan = await previewService(t, [18090]).preview({
    ...route,
    command: 'docker run -p 127.0.0.1:18090:80 -p 18080:81 nginx'
  });
  assert.deepEqual(publishedArgs(plan), ['127.0.0.1:18081:80/tcp', '18080:81/tcp']);
});

for (const mapping of ['18080-18090:80', '127.0.0.1:bad:80', '127.0.0.1:18080:80/tcp/udp']) {
  test(`docker preview rejects unsupported mapping ${mapping}`, async (t) => {
    await assert.rejects(
      previewService(t).preview({ ...route, command: `docker run -p ${mapping} nginx` }),
      /Unsupported Docker port mapping/
    );
  });
}
