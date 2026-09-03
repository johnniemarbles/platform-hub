import {
  COMMUNICATION_ALLOWED_HTML_ATTRIBUTES,
  COMMUNICATION_ALLOWED_HTML_TAGS,
  escapeHtmlText,
  isSafeCommunicationUrl,
  sanitizedHtml,
  type CommunicationContentPolicyResult,
  type CommunicationContentPolicyViolation,
} from './content-policy.ts';

const BLOCKED_ELEMENT_RE = /<\s*(script|style|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/giu;
const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype\b[^>]*>|<\/?[a-zA-Z][^>]*>/giu;
const TAG_RE = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*?)(\/?)\s*>$/u;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9:._-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gu;
const URL_ATTRIBUTES = new Set(['href', 'src']);

export function sanitizeCommunicationHtml(input: string): CommunicationContentPolicyResult {
  const violations: CommunicationContentPolicyViolation[] = [];
  const withoutBlockedContainers = input.replace(BLOCKED_ELEMENT_RE, (_match, rawTag: string) => {
    const tagName = rawTag.toLowerCase();
    violations.push({ code: 'UNSAFE_HTML_ELEMENT', detail: `<${tagName}> is not allowed in communication templates.` });
    return '';
  });
  let cursor = 0;
  let output = '';

  for (const match of withoutBlockedContainers.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    output += withoutBlockedContainers.slice(cursor, index);
    output += sanitizeToken(match[0], violations);
    cursor = index + match[0].length;
  }
  output += withoutBlockedContainers.slice(cursor);

  return { html: sanitizedHtml(output), violations };
}

function sanitizeToken(
  token: string,
  violations: CommunicationContentPolicyViolation[],
): string {
  const lower = token.toLowerCase();
  if (lower.startsWith('<!--')) {
    violations.push({ code: 'UNSAFE_HTML_COMMENT', detail: 'HTML comments are removed.' });
    return '';
  }
  if (lower.startsWith('<![cdata[')) {
    violations.push({ code: 'UNSAFE_HTML_CDATA', detail: 'CDATA sections are removed.' });
    return '';
  }
  if (lower.startsWith('<!doctype')) {
    violations.push({ code: 'UNSAFE_HTML_DOCTYPE', detail: 'Doctype declarations are removed.' });
    return '';
  }

  const parsed = TAG_RE.exec(token);
  if (parsed === null) return escapeHtmlText(token);
  const closing = parsed[1] ?? '';
  const rawName = parsed[2];
  const rawAttrs = parsed[3] ?? '';
  const selfClosing = parsed[4] ?? '';
  if (rawName === undefined) return escapeHtmlText(token);

  const tagName = rawName.toLowerCase();
  if (!COMMUNICATION_ALLOWED_HTML_TAGS.has(tagName)) {
    violations.push({ code: 'UNSAFE_HTML_ELEMENT', detail: `<${tagName}> is not allowed in communication templates.` });
    return '';
  }
  if (closing) return `</${tagName}>`;

  const attrs = sanitizeAttributes(tagName, rawAttrs, violations);
  return `<${tagName}${attrs}${selfClosing ? ' /' : ''}>`;
}

function sanitizeAttributes(
  tagName: string,
  source: string,
  violations: CommunicationContentPolicyViolation[],
): string {
  const safe: string[] = [];
  for (const match of source.matchAll(ATTR_RE)) {
    const rawName = match[1];
    if (rawName === undefined) continue;
    const name = rawName.toLowerCase();
    if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
      violations.push({ code: 'UNSAFE_HTML_ATTRIBUTE', detail: `${rawName} is not allowed on <${tagName}>.` });
      continue;
    }
    if (!COMMUNICATION_ALLOWED_HTML_ATTRIBUTES.has(name)) {
      violations.push({ code: 'UNSAFE_HTML_ATTRIBUTE', detail: `${rawName} is not an allowed communication-template attribute.` });
      continue;
    }

    const value = parseAttributeValue(match[2]);
    if (value === null) {
      safe.push(name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name) && !isSafeCommunicationUrl(value)) {
      violations.push({ code: 'UNSAFE_HTML_URL', detail: `${rawName} contains an unsafe URL.` });
      continue;
    }
    if (name === 'target' && value !== '_blank' && value !== '_self') {
      violations.push({ code: 'UNSAFE_HTML_ATTRIBUTE', detail: 'Only _blank and _self link targets are allowed.' });
      continue;
    }
    const escaped = escapeHtmlText(value);
    safe.push(`${name}="${escaped}"`);
  }
  if (tagName === 'a' && safe.some((attr) => attr.startsWith('target="_blank"')) && !safe.some((attr) => attr.startsWith('rel='))) {
    safe.push('rel="noopener noreferrer"');
  }
  return safe.length === 0 ? '' : ` ${safe.join(' ')}`;
}

function parseAttributeValue(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
