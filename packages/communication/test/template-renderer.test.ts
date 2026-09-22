import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommunicationTemplate } from '../src/template.ts';
import { sanitizeCommunicationHtml } from '../src/html-sanitizer.ts';
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

test('HTML template variables are escaped before provider output', () => {
  const result = renderCommunicationTemplate({
    template,
    variables: {
      person: { name: '<img src=x onerror=alert(1)>' },
      case: { status: '<script>alert(2)</script>' },
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.rendered.body,
    '<p>&lt;img src=x onerror=alert(1)&gt;, your case is &lt;script&gt;alert(2)&lt;/script&gt;.</p>',
  );
});

test('HTML sanitizer removes blocked elements, contents, unsafe URLs and unsafe attributes', () => {
  const sanitized = sanitizeCommunicationHtml(
    '<div onclick="steal()"><script>alert(1)</script><a href="javascript:alert(2)" target="_blank">open</a><img src="https://cdn.example/logo.png" onerror="steal()"></div>',
  );

  assert.equal(sanitized.html.value, '<div><a target="_blank" rel="noopener noreferrer">open</a><img src="https://cdn.example/logo.png"></div>');
  assert.ok(sanitized.violations.some((violation) => violation.code === 'UNSAFE_HTML_ELEMENT'));
  assert.ok(sanitized.violations.some((violation) => violation.code === 'UNSAFE_HTML_ATTRIBUTE'));
  assert.ok(sanitized.violations.some((violation) => violation.code === 'UNSAFE_HTML_URL'));
});

test('rendered HTML is centrally sanitized before adapters receive it', () => {
  const result = renderCommunicationTemplate({
    template: {
      ...template,
      content: {
        ...template.content,
        body: '<p>Hello {{person.name}}</p><iframe src="https://evil.example">payload</iframe><a href="javascript:alert(1)">bad</a>',
      },
    },
    variables: { person: { name: 'Maya' } },
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rendered.body, '<p>Hello Maya</p><a>bad</a>');
  assert.ok(result.rendered.contentPolicyViolations?.some((violation) => violation.code === 'UNSAFE_HTML_ELEMENT'));
  assert.ok(result.rendered.contentPolicyViolations?.some((violation) => violation.code === 'UNSAFE_HTML_URL'));
});
