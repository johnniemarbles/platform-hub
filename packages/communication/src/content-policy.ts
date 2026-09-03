export interface SanitizedHtml {
  readonly __brand: 'SanitizedHtml';
  readonly value: string;
}

export type CommunicationContentPolicyViolationCode =
  | 'UNSAFE_HTML_ELEMENT'
  | 'UNSAFE_HTML_ATTRIBUTE'
  | 'UNSAFE_HTML_URL'
  | 'UNSAFE_HTML_COMMENT'
  | 'UNSAFE_HTML_CDATA'
  | 'UNSAFE_HTML_DOCTYPE';

export interface CommunicationContentPolicyViolation {
  readonly code: CommunicationContentPolicyViolationCode;
  readonly detail: string;
}

export interface CommunicationContentPolicyResult {
  readonly html: SanitizedHtml;
  readonly violations: readonly CommunicationContentPolicyViolation[];
}

export const COMMUNICATION_ALLOWED_HTML_TAGS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'small',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

export const COMMUNICATION_ALLOWED_HTML_ATTRIBUTES: ReadonlySet<string> = new Set([
  'alt',
  'aria-label',
  'colspan',
  'height',
  'href',
  'rel',
  'role',
  'rowspan',
  'src',
  'target',
  'title',
  'width',
]);

export function sanitizedHtml(value: string): SanitizedHtml {
  return { __brand: 'SanitizedHtml', value };
}

export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export function isSafeCommunicationUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  if (/^(?:mailto:|tel:)/iu.test(trimmed)) return !/[\u0000-\u001f\u007f]/u.test(trimmed);
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return trimmed.startsWith('/') && !trimmed.startsWith('//') && !/[\u0000-\u001f\u007f]/u.test(trimmed);
  }
}
