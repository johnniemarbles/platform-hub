import type { CommunicationTemplate } from './template.ts';
import { escapeHtmlText, type CommunicationContentPolicyViolation } from './content-policy.ts';
import { sanitizeCommunicationHtml } from './html-sanitizer.ts';

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export interface CommunicationTemplateRenderInput {
  readonly template: CommunicationTemplate;
  readonly variables?: Readonly<Record<string, unknown>>;
}

export interface RenderedCommunicationTemplate {
  readonly templateId: string;
  readonly version: number;
  readonly channel: CommunicationTemplate['key']['channel'];
  readonly locale: string;
  readonly format: CommunicationTemplate['content']['format'];
  readonly subject?: string;
  readonly title?: string;
  readonly body: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly contentPolicyViolations?: readonly CommunicationContentPolicyViolation[];
}

export type CommunicationTemplateRenderResult =
  | {
      readonly ok: true;
      readonly rendered: RenderedCommunicationTemplate;
    }
  | {
      readonly ok: false;
      readonly reasonCode: 'MISSING_VARIABLES';
      readonly missingVariables: readonly string[];
    };

/**
 * Pure, provider-neutral renderer. Runtime variables override template defaults.
 * Every referenced placeholder must resolve; the renderer fails closed rather
 * than silently removing unresolved content. HTML output is sanitized centrally
 * before any provider adapter can receive it, and variable substitutions are
 * HTML-escaped by default inside HTML templates.
 */
export function renderCommunicationTemplate(
  input: CommunicationTemplateRenderInput,
): CommunicationTemplateRenderResult {
  const variables = {
    ...input.template.defaultVariables,
    ...(input.variables ?? {}),
  };

  const referenced = new Set<string>(input.template.requiredVariables);
  collectPlaceholders(input.template.content.subject, referenced);
  collectPlaceholders(input.template.content.title, referenced);
  collectPlaceholders(input.template.content.body, referenced);

  const missing = [...referenced]
    .filter((key) => {
      const value = lookupVariable(variables, key);
      return value === undefined || value === null;
    })
    .sort();

  if (missing.length > 0) {
    return {
      ok: false,
      reasonCode: 'MISSING_VARIABLES',
      missingVariables: missing,
    };
  }

  const html = input.template.content.format === 'HTML';
  const subject = renderSource(input.template.content.subject, variables, false);
  const title = renderSource(input.template.content.title, variables, false);
  const rawBody = renderSource(input.template.content.body, variables, html) ?? '';
  const sanitized = html ? sanitizeCommunicationHtml(rawBody) : null;

  return {
    ok: true,
    rendered: {
      templateId: input.template.templateId,
      version: input.template.version,
      channel: input.template.key.channel,
      locale: input.template.key.locale,
      format: input.template.content.format,
      ...(subject === undefined ? {} : { subject }),
      ...(title === undefined ? {} : { title }),
      body: sanitized?.html.value ?? rawBody,
      variables,
      ...(sanitized === null || sanitized.violations.length === 0
        ? {}
        : { contentPolicyViolations: sanitized.violations }),
    },
  };
}

function collectPlaceholders(source: string | undefined, target: Set<string>): void {
  if (source === undefined) return;
  for (const match of source.matchAll(PLACEHOLDER_PATTERN)) {
    const key = match[1];
    if (key !== undefined) target.add(key);
  }
}

function renderSource(
  source: string | undefined,
  variables: Readonly<Record<string, unknown>>,
  htmlContext: boolean,
): string | undefined {
  if (source === undefined) return undefined;
  return source.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    const value = lookupVariable(variables, key);
    const text = stringifyVariable(value);
    return htmlContext ? escapeHtmlText(text) : text;
  });
}

function lookupVariable(
  variables: Readonly<Record<string, unknown>>,
  path: string,
): unknown {
  const segments = path.split('.');
  let cursor: unknown = variables;

  for (const segment of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Readonly<Record<string, unknown>>)[segment];
  }

  return cursor;
}

function stringifyVariable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  const encoded = JSON.stringify(value);
  return encoded ?? String(value);
}
