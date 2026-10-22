import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('custody-service package has no pg dependency', () => {
  const pkg = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(!('pg' in all), 'pg must not be a dependency of custody-service');
  assert.ok(!('@types/pg' in all), '@types/pg must not be a dependency of custody-service');
  assert.ok(!('@platform-core/postgres-runtime' in all), 'postgres-runtime must not be a dependency');
});

test('custody-service sources never import pg, dbPool, or DATABASE_URL', () => {
  const srcRoot = path.join(appRoot, 'src');
  assert.ok(existsSync(srcRoot), 'src/ must exist');
  for (const file of listTsFiles(srcRoot)) {
    const source = readFileSync(file, 'utf8');
    const rel = path.relative(appRoot, file);
    assert.doesNotMatch(source, /from\s+['"]pg['"]/, `${rel} imports pg`);
    assert.doesNotMatch(source, /\bdbPool\b/, `${rel} names dbPool`);
    assert.doesNotMatch(source, /DATABASE_URL/, `${rel} references DATABASE_URL`);
    assert.doesNotMatch(source, /local_custody_secrets/, `${rel} reaches local_custody_secrets`);
    assert.doesNotMatch(source, /@expadio\/postgres-runtime/, `${rel} imports postgres-runtime`);
  }
});

test('custody-service exposes health, wrapping-key, and credentials routes', () => {
  const server = readFileSync(path.join(appRoot, 'src/server.ts'), 'utf8');
  assert.match(server, /\/health/);
  assert.match(server, /\/api\/custody\/wrapping-key/);
  assert.match(server, /\/api\/custody\/credentials/);
});
