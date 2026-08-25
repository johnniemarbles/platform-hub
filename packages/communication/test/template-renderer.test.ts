import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommunicationTemplate } from '../src/template.ts';
import { renderCommunicationTemplate } from '../src/template-renderer.ts';

const template: CommunicationTemplate = {
  templateId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  scope: { kind: 'TENANT', tenantId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
  key: {
    triggerKey: 'lead.followup',
    channel: 'email',
    locale: 'en',
  },
  content: {
    format: 'HTML',
    subject: 'Hello {{person.name}}',
    title: 'Follow-up for {{company}}',
    body: '<p>{{person.name}}, your case is {{case.status}}.</p>',
  },
  requiredVariables: ['person.name'],
  defaultVariables: {
    company: 'EXPADIO',
    case: { status: 'OPEN' },
  },
  version: 3,
  status: 'ACTIVE',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

test('renders subject, title and body using defaults plus runtime variables', () => {
  const result = renderCommunicationTemplate({
    template,
    variables: {
      person: { name: 'Maya' },
      case: { status: 'READY' },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.rendered.subject, 'Hello Maya');
  assert.equal(result.rendered.title, 'Follow-up for EXPADIO');
  assert.equal(result.rendered.body, '<p>Maya, your case is READY.</p>');
  assert.equal(result.rendered.version, 3);
  assert.equal(result.rendered.channel, 'email');
});

test('fails closed when a declared required variable is missing', () => {
  const result = renderCommunicationTemplate({ template });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'MISSING_VARIABLES',
    missingVariables: ['person.name'],
  });
});

test('fails closed when any referenced placeholder is unresolved even if it was not declared required', () => {
  const result = renderCommunicationTemplate({
    template: {
      ...template,
      requiredVariables: [],
      content: {
        ...template.content,
        body: 'Hello {{person.name}} from {{unknown.value}}',
      },
    },
    variables: { person: { name: 'Maya' } },
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'MISSING_VARIABLES',
    missingVariables: ['unknown.value'],
  });
});

test('runtime variables override template defaults', () => {
  const result = renderCommunicationTemplate({
    template,
    variables: {
      person: { name: 'Maya' },
      company: 'DREAMWARE',
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rendered.title, 'Follow-up for DREAMWARE');
});

test('renders false and zero without treating them as missing', () => {
  const result = renderCommunicationTemplate({
    template: {
      ...template,
      content: {
        format: 'TEXT',
        body: 'active={{active}} count={{count}}',
      },
      requiredVariables: ['active', 'count'],
      defaultVariables: {},
    },
    variables: { active: false, count: 0 },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rendered.body, 'active=false count=0');
});
