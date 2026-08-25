import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CommunicationTemplate,
  CommunicationTemplateRepository,
  CommunicationTemplateResolutionInput,
} from '../src/template.ts';
import { resolveAndRenderCommunicationTemplate } from '../src/template-resolve-render.ts';

const template: CommunicationTemplate = {
  templateId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  scope: {
    kind: 'ORGANIZATION',
    tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    organizationId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  },
  key: { triggerKey: 'lead.followup', channel: 'email', locale: 'en' },
  content: { format: 'TEXT', subject: 'Hello {{name}}', body: 'Welcome {{name}}' },
  requiredVariables: ['name'],
  defaultVariables: {},
  version: 2,
  status: 'ACTIVE',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

function repository(result: Awaited<ReturnType<CommunicationTemplateRepository['resolveActive']>>) {
  const calls: CommunicationTemplateResolutionInput[] = [];
  const repo: CommunicationTemplateRepository = {
    async resolveActive(input) {
      calls.push(input);
      return result;
    },
  };
  return { repo, calls };
}

test('resolves then renders the winning active template', async () => {
  const { repo, calls } = repository({ matchedScope: 'ORGANIZATION', template });

  const result = await resolveAndRenderCommunicationTemplate(repo, {
    tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    organizationId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    triggerKey: 'lead.followup',
    channel: 'email',
    locale: 'en',
    variables: { name: 'Maya' },
  });

  assert.deepEqual(calls, [{
    tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    organizationId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    triggerKey: 'lead.followup',
    channel: 'email',
    locale: 'en',
  }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.matchedScope, 'ORGANIZATION');
  assert.equal(result.rendered.subject, 'Hello Maya');
  assert.equal(result.rendered.body, 'Welcome Maya');
});

test('returns TEMPLATE_MISSING when no active template resolves', async () => {
  const { repo } = repository({ matchedScope: 'NONE', template: null });

  const result = await resolveAndRenderCommunicationTemplate(repo, {
    tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    triggerKey: 'lead.followup',
    channel: 'email',
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'TEMPLATE_MISSING',
    matchedScope: 'NONE',
  });
});

test('preserves matched scope and template identity on render failure', async () => {
  const { repo } = repository({ matchedScope: 'TENANT', template });

  const result = await resolveAndRenderCommunicationTemplate(repo, {
    tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    triggerKey: 'lead.followup',
    channel: 'email',
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'MISSING_VARIABLES',
    matchedScope: 'TENANT',
    templateId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    version: 2,
    missingVariables: ['name'],
  });
});

test('repository failures propagate and are never converted into a successful render', async () => {
  const repo: CommunicationTemplateRepository = {
    async resolveActive() {
      throw new Error('template store unavailable');
    },
  };

  await assert.rejects(
    resolveAndRenderCommunicationTemplate(repo, {
      tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      triggerKey: 'lead.followup',
      channel: 'email',
    }),
    /template store unavailable/,
  );
});
