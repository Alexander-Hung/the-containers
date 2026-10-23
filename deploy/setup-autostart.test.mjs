import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const installer = fs.readFileSync(new URL('./setup-autostart.sh', import.meta.url), 'utf8');
// Run only the real env-file step. Never execute main, sudo, packages, Docker,
// systemd, or chown. All filesystem commands are restricted to the fixture.
assert.match(installer, /\nmain "\$@"\s*$/);
const envStep = installer.replace(/\nmain "\$@"\s*$/, '') + `
ENV_DIR="$FIXTURE/env"
ENV_FILE="$ENV_DIR/the-containers.env"
DATA_DIR="$FIXTURE/data"
ROOT_DIR="$FIXTURE/project"
DOCKER_HOST_VALUE=""
SERVICE_USER="$FIXTURE_SERVICE_USER"
user_primary_group() { printf '%s' fixture-group; }
run_root() {
  case "$1" in
    mkdir|chown|chmod|test|grep|sed|tee|touch|node) ;;
    *) echo "Unexpected privileged command: $1" >&2; exit 90 ;;
  esac
  local last="\u0024{!#}"
  case "$last" in "$FIXTURE"/*) ;; *) echo "Outside fixture" >&2; exit 91 ;; esac
  if [ "$1" = chown ] || [ "$1" = chmod ]; then
    printf '%s\\n' "$*" >> "$FIXTURE/permissions.log"
  fi
  if [ "$1" = chown ]; then
    return
  elif [ "$1" = sed ] && [ "$(uname -s)" = Darwin ]; then
    shift
    shift
    command sed -i '' "$@"
  else
    "$@"
  fi
}
write_env
`;

function fixture(t, contents, mode = 0o644) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'containers-env-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envDir = path.join(dir, 'env');
  const envFile = path.join(envDir, 'the-containers.env');
  const stepFile = path.join(dir, 'env-step.sh');
  fs.writeFileSync(stepFile, envStep);
  if (contents !== undefined) {
    fs.mkdirSync(envDir, { mode: 0o755 });
    fs.writeFileSync(envFile, contents, { mode });
  }
  return {
    envDir, envFile,
    run: () => execFileSync('bash', [stepFile], {
      env: { ...process.env, FIXTURE: dir, FIXTURE_SERVICE_USER: os.userInfo().username }, encoding: 'utf8'
    }),
    read: () => fs.readFileSync(envFile, 'utf8'),
    permissions: () => fs.readFileSync(path.join(dir, 'permissions.log'), 'utf8')
  };
}

test('fresh autostart generates a strong token and prints it only on creation', (t) => {
  const f = fixture(t);
  const output = f.run();
  const token = f.read().match(/^ADMIN_TOKEN=([a-f0-9]{64})$/m)?.[1];
  assert.ok(token, 'expected a 32-byte random token');
  assert.equal(output.split(token).length - 1, 1);
  const rerun = f.run();
  assert.ok(f.read().includes(`ADMIN_TOKEN=${token}\n`));
  assert.ok(!rerun.includes(token));
  const other = fixture(t);
  other.run();
  assert.notEqual(other.read().match(/^ADMIN_TOKEN=(.*)$/m)?.[1], token);
});

test('missing and empty tokens are filled while existing tokens remain untouched', (t) => {
  for (const line of ['', 'ADMIN_TOKEN=', 'ADMIN_TOKEN=""', "ADMIN_TOKEN=''"]) {
    const f = fixture(t, `HOST=0.0.0.0\n${line}\n`);
    f.run();
    assert.match(f.read(), /^ADMIN_TOKEN=[a-f0-9]{64}$/m);
  }
  const existing = randomBytes(32).toString('hex');
  const f = fixture(t, `ADMIN_TOKEN='${existing}'\n`);
  assert.ok(!f.run().includes(existing));
  assert.equal(f.read().split('\n')[0], `ADMIN_TOKEN='${existing}'`);
});

test('fresh env files are 0640 in a 0750 directory and owned by root and the service group', (t) => {
  const f = fixture(t);
  f.run();
  assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o640);
  assert.equal(fs.statSync(f.envDir).mode & 0o777, 0o750);
  assert.ok(f.permissions().includes(`chown root:fixture-group ${f.envFile}\n`));
  assert.ok(f.permissions().includes(`chown root:fixture-group ${f.envDir}\n`));
});

test('reruns enforce service-group access and remove public access regardless of previous modes', (t) => {
  for (const before of [0o644, 0o666, 0o600, 0o640]) {
    const token = randomBytes(32).toString('hex');
    const f = fixture(t, `ADMIN_TOKEN=${token}\n`, before);
    // writeFile's mode is filtered by umask; set the precise regression input.
    fs.chmodSync(f.envFile, before);
    fs.chmodSync(f.envDir, before === 0o600 ? 0o700 : 0o755);
    f.run();
    assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o640);
    assert.equal(fs.statSync(f.envDir).mode & 0o777, 0o750);
    assert.ok(f.read().includes(`ADMIN_TOKEN=${token}\n`));
  }
});

test('rerun over a service-owned 0600 file grants service-group read after root ownership', (t) => {
  const token = randomBytes(32).toString('hex');
  const f = fixture(t, `ADMIN_TOKEN=${token}\n`, 0o600);
  fs.chmodSync(f.envDir, 0o700);
  assert.equal(fs.statSync(f.envFile).uid, os.userInfo().uid);
  assert.equal(fs.statSync(f.envFile).mode & 0o777, 0o600);
  assert.ok(!f.run().includes(token));
  const calls = f.permissions().trim().split('\n');
  for (const [target, mode] of [[f.envFile, '0640'], [f.envDir, '0750']]) {
    const chown = calls.indexOf(`chown root:fixture-group ${target}`);
    const chmod = calls.indexOf(`chmod ${mode} ${target}`);
    assert.ok(chown >= 0, 'ownership must change to root and the service group');
    assert.ok(chmod > chown, 'service-group access must be granted after ownership changes');
    assert.equal(fs.statSync(target).mode & 0o777, Number.parseInt(mode, 8));
  }
  assert.ok(f.read().includes(`ADMIN_TOKEN=${token}\n`));
});
