import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { check, type ArchitectureConfig, type SdkGroup } from './check.ts';

const SDKS = ['stripe', 'razorpay', 'twilio', 'openai', '@anthropic-ai/', '@aws-sdk/client-ses*', '@sendgrid/'];
const IDENTITY = ['@clerk/', '@aws-sdk/client-cognito-identity-provider'];
const providers = (allowedPaths: string[] = []): SdkGroup => ({ name: 'provider', packages: SDKS, allowedPaths });
const identity = (allowedPaths: string[] = []): SdkGroup => ({ name: 'identity', packages: IDENTITY, allowedPaths });

function repo(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-check-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const pkg = (name: string, deps: Record<string, string> = {}) => ({
  name,
  scripts: { typecheck: 'tsc --noEmit', test: 'node --test' },
  dependencies: deps,
});

const coreConfig: ArchitectureConfig = {
  sdkGroups: [providers(), identity(['packages/foundation/src/identity'])],
  baseAllowedDeps: {
    '@platform-core/contracts': [],
    '@platform-core/foundation': ['@platform-core/contracts'],
    '@platform-core/core-records': ['@platform-core/foundation', '@platform-core/contracts'],
  },
  moduleAllowedDeps: ['@platform-core/foundation', '@platform-core/core-records', '@platform-core/contracts'],
  forbiddenPackages: ['@platform-hub/'],
  allowedExternalLayerPackages: ['@platform-hub/sdk'],
  permissionChecks: true,
  turboRequired: true,
};

const rules = (root: string, cfg: ArchitectureConfig) => check(root, cfg).map((v) => `${v.rule}:${v.file}`);

test('a clean platform-core layout passes', () => {
  const root = repo({
    'turbo.json': {},
    'packages/contracts/package.json': pkg('@platform-core/contracts'),
    'packages/foundation/package.json': pkg('@platform-core/foundation', { '@platform-core/contracts': 'workspace:*' }),
    'packages/crm/package.json': pkg('@platform-core/crm', { '@platform-core/core-records': 'workspace:*', '@platform-hub/sdk': '^1.0.0' }),
    'packages/crm/src/index.ts': `import { can } from '@platform-core/foundation';\nif (can(ctx, 'crm.deal.update')) {}\n`,
  });
  try {
    assert.deepEqual(check(root, coreConfig), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a module depending on another module fails', () => {
  const root = repo({
    'turbo.json': {},
    'packages/crm/package.json': pkg('@platform-core/crm'),
    'packages/gtm/package.json': pkg('@platform-core/gtm', { '@platform-core/crm': 'workspace:*' }),
  });
  try {
    assert.deepEqual(rules(root, coreConfig), ['workspace-deps:packages/gtm/package.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a library depending on an app fails', () => {
  const root = repo({
    'turbo.json': {},
    'apps/platform-api/package.json': pkg('@platform-core/platform-api'),
    'packages/foundation/package.json': pkg('@platform-core/foundation', { '@platform-core/platform-api': 'workspace:*' }),
  });
  try {
    assert.deepEqual(rules(root, coreConfig), ['workspace-deps:packages/foundation/package.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider SDK imports and dependencies outside allowed paths fail, deep and scoped imports included', () => {
  const root = repo({
    'turbo.json': {},
    'packages/crm/package.json': pkg('@platform-core/crm', { stripe: '^17.0.0' }),
    'packages/crm/src/a.ts': `import Stripe from 'stripe';\n`,
    'packages/crm/src/b.ts': `const x = await import("@anthropic-ai/sdk/resources");\n`,
    'packages/crm/src/c.ts': `export { SESClient } from '@aws-sdk/client-sesv2';\n`,
    'packages/crm/src/d.ts': `const t = require('twilio/lib/rest');\n`,
  });
  try {
    const found = rules(root, coreConfig).sort();
    assert.deepEqual(found, [
      'provider-sdk:packages/crm/package.json',
      'provider-sdk:packages/crm/src/a.ts',
      'provider-sdk:packages/crm/src/b.ts',
      'provider-sdk:packages/crm/src/c.ts',
      'provider-sdk:packages/crm/src/d.ts',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider SDKs are allowed under the hub adapters path only', () => {
  const hubConfig: ArchitectureConfig = { sdkGroups: [providers(['packages/adapters']), identity()], forbiddenPackages: ['@platform-core/'], turboRequired: true };
  const root = repo({
    'turbo.json': {},
    'packages/adapters/package.json': pkg('@platform-hub/adapters', { stripe: '^17.0.0' }),
    'packages/adapters/src/stripe/index.ts': `import Stripe from 'stripe';\n`,
    'packages/enforcement/package.json': pkg('@platform-hub/enforcement'),
    'packages/enforcement/src/x.ts': `import OpenAI from 'openai';\n`,
  });
  try {
    assert.deepEqual(rules(root, hubConfig), ['provider-sdk:packages/enforcement/src/x.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the hub may not depend on platform-core', () => {
  const hubConfig: ArchitectureConfig = { sdkGroups: [providers(['packages/adapters'])], forbiddenPackages: ['@platform-core/'] };
  const root = repo({ 'packages/sdk/package.json': pkg('@platform-hub/sdk', { '@platform-core/foundation': '^1.0.0' }) });
  try {
    assert.deepEqual(rules(root, hubConfig), ['forbidden-package:packages/sdk/package.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('role-name and user-ID checks are flagged; permission checks and tests are not', () => {
  const root = repo({
    'turbo.json': {},
    'packages/crm/package.json': pkg('@platform-core/crm'),
    'packages/crm/src/a.ts': [
      `if (user.role === 'admin') {}`,
      `if ('owner' === member.role) {}`,
      `if (auth.hasRole('manager')) {}`,
      `if (roles.includes('staff')) {}`,
      `if (userId === 'usr_9f8e7d6c') {}`,
      `if (can(ctx, 'crm.deal.read')) {}`,
      `// arch-check: allow-role-name (display label only)`,
      `const label = role === 'owner' ? 'Owner' : 'Member';`,
    ].join('\n'),
    'packages/crm/test/a.test.ts': `assert(user.role === 'admin');\n`,
  });
  try {
    const lines = check(root, coreConfig).filter((v) => v.rule === 'permission-check').map((v) => v.line);
    assert.deepEqual(lines, [1, 2, 3, 4, 5]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing turbo.json or package scripts are flagged', () => {
  const root = repo({ 'packages/crm/package.json': { name: '@platform-core/crm', scripts: { test: 'node --test' } } });
  try {
    assert.deepEqual(rules(root, coreConfig).sort(), ['turbo:packages/crm/package.json', 'turbo:turbo.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity SDKs are allowed only in the foundation identity adapter, and never in the hub', () => {
  const core = repo({
    'turbo.json': {},
    'packages/foundation/package.json': pkg('@platform-core/foundation', { '@clerk/backend': '^2.0.0' }),
    'packages/foundation/src/identity/clerk.ts': `import { createClerkClient } from '@clerk/backend';\n`,
    'packages/foundation/src/tenancy.ts': `import { verifyToken } from '@clerk/backend';\n`,
    'packages/crm/package.json': pkg('@platform-core/crm', { '@aws-sdk/client-cognito-identity-provider': '^3.0.0' }),
  });
  const hub = repo({
    'turbo.json': {},
    'packages/adapters/package.json': pkg('@platform-hub/adapters', { '@clerk/backend': '^2.0.0' }),
  });
  try {
    assert.deepEqual(rules(core, coreConfig).sort(), ['provider-sdk:packages/crm/package.json', 'provider-sdk:packages/foundation/src/tenancy.ts']);
    const hubCfg: ArchitectureConfig = { sdkGroups: [providers(['packages/adapters']), identity()] };
    assert.deepEqual(rules(hub, hubCfg), ['provider-sdk:packages/adapters/package.json']);
  } finally {
    rmSync(core, { recursive: true, force: true });
    rmSync(hub, { recursive: true, force: true });
  }
});
