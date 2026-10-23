export type DnsRecordType = 'TXT' | 'CNAME' | 'MX';

export type DnsRecordPurpose = 'SPF' | 'DKIM' | 'DMARC' | 'RETURN_PATH';

export interface RequiredDnsRecord {
  readonly purpose: DnsRecordPurpose;
  readonly type: DnsRecordType;
  readonly name: string;
  readonly content: string;
  readonly ttl: number;
  readonly priority?: number;
  /** Plain-language explanation rendered beside the row (§6.2). */
  readonly explanation: string;
}

export interface DnsAuthorityConfig {
  /** e.g. "k1.domainkey.expadio.com" */
  readonly dkimTarget: string;
  /** SPF include mechanisms for the providers in use. */
  readonly spfIncludes: readonly string[];
  /** e.g. "feedback-smtp.us-east-1.amazonses.com" */
  readonly returnPathHost: string;
  readonly dmarcReportMailbox?: string;
}

export function requiredDnsRecords(
  sendingDomain: string,
  authority: DnsAuthorityConfig,
): readonly RequiredDnsRecord[] {
  const domain = sendingDomain.trim().toLowerCase();
  const includes = authority.spfIncludes.map((entry) => `include:${entry}`).join(' ');
  const reportTo = authority.dmarcReportMailbox ?? `dmarc-reports@${domain}`;

  return [
    {
      purpose: 'SPF',
      type: 'TXT',
      name: domain,
      content: `v=spf1 ${includes} ~all`,
      ttl: 3600,
      explanation:
        'Lists which servers are allowed to send email using your domain. Receiving servers check this first.',
    },
    {
      purpose: 'DKIM',
      type: 'CNAME',
      name: `k1._domainkey.${domain}`,
      content: authority.dkimTarget,
      ttl: 3600,
      explanation:
        'Lets us sign your messages so receiving servers can prove they were not altered in transit.',
    },
    {
      purpose: 'DMARC',
      type: 'TXT',
      name: `_dmarc.${domain}`,
      content: `v=DMARC1; p=quarantine; rua=mailto:${reportTo}; pct=100;`,
      ttl: 3600,
      explanation:
        'Tells receiving servers what to do when a message fails the checks above, and where to send reports.',
    },
    {
      purpose: 'RETURN_PATH',
      type: 'MX',
      name: domain,
      content: authority.returnPathHost,
      priority: 10,
      ttl: 3600,
      explanation:
        'Routes bounce notifications back to us so we can suppress addresses that no longer exist.',
    },
  ];
}

/** BEMP: mail.brand.com -> brand.com */
export function extractRootDomain(domain: string): string {
  const parts = domain.trim().toLowerCase().split('.');
  if (parts.length <= 2) return domain.trim().toLowerCase();
  return parts.slice(-2).join('.');
}

// ---------------------------------------------------------------------------
// SPF merge detection — §6.2
// ---------------------------------------------------------------------------

export interface SpfMergeAnalysis {
  readonly hasExistingSpf: boolean;
  readonly existingRecord?: string;
  /** True when publishing our standalone record would create a second SPF TXT. */
  readonly wouldBreakAuthentication: boolean;
  /** The record the tenant should publish instead. */
  readonly mergedRecord: string;
  readonly addedIncludes: readonly string[];
  /** True when the merged record exceeds SPF's 10-lookup limit. */
  readonly exceedsLookupLimit: boolean;
  readonly warning?: string;
}

const SPF_LOOKUP_MECHANISMS = /\b(include|a|mx|ptr|exists|redirect)[:=]/g;

export function analyseSpfMerge(input: {
  readonly existingTxtRecords: readonly string[];
  readonly requiredIncludes: readonly string[];
}): SpfMergeAnalysis {
  const existing = input.existingTxtRecords.find((record) =>
    record.trim().toLowerCase().startsWith('v=spf1'),
  );

  if (existing === undefined) {
    const merged = `v=spf1 ${input.requiredIncludes.map((i) => `include:${i}`).join(' ')} ~all`;
    return {
      hasExistingSpf: false,
      wouldBreakAuthentication: false,
      mergedRecord: merged,
      addedIncludes: input.requiredIncludes,
      exceedsLookupLimit: countSpfLookups(merged) > 10,
    };
  }

  const present = new Set(
    [...existing.matchAll(/include:([^\s]+)/g)].map((match) => (match[1] ?? '').toLowerCase()),
  );
  const missing = input.requiredIncludes.filter((entry) => !present.has(entry.toLowerCase()));

  // Preserve the tenant's existing qualifier (~all / -all / ?all) — replacing
  // a strict -all with a soft ~all silently weakens their policy.
  const allMatch = existing.match(/([-~?+])all\s*$/);
  const qualifier = allMatch?.[1] ?? '~';
  const body = existing.replace(/\s*[-~?+]all\s*$/, '').trim();
  const merged =
    missing.length === 0
      ? existing.trim()
      : `${body} ${missing.map((i) => `include:${i}`).join(' ')} ${qualifier}all`;

  const lookups = countSpfLookups(merged);

  return {
    hasExistingSpf: true,
    existingRecord: existing.trim(),
    wouldBreakAuthentication: missing.length > 0,
    mergedRecord: merged,
    addedIncludes: missing,
    exceedsLookupLimit: lookups > 10,
    ...(missing.length > 0
      ? {
          warning:
            'This domain already has an SPF record. Publishing a second one breaks email authentication for your whole company — receiving servers treat two SPF records as none. Replace your existing record with the merged value below.',
        }
      : lookups > 10
        ? {
            warning: `This merged record needs ${lookups} DNS lookups. SPF allows 10. Remove an unused include or switch one to an IP range.`,
          }
        : {}),
  };
}

export function countSpfLookups(record: string): number {
  SPF_LOOKUP_MECHANISMS.lastIndex = 0;
  return [...record.matchAll(SPF_LOOKUP_MECHANISMS)].length;
}

// ---------------------------------------------------------------------------
// Registrar quirks — §6.2
// ---------------------------------------------------------------------------

export type Registrar = 'cloudflare' | 'godaddy' | 'route53' | 'namecheap' | 'other';

/**
 * "Cloudflare appends the domain to the record name; GoDaddy strips it; both
 * cause the same silent failure." Returns the exact string to paste into the
 * name field for that registrar.
 */
export function recordNameForRegistrar(
  record: RequiredDnsRecord,
  domain: string,
  registrar: Registrar,
): { readonly name: string; readonly hint?: string } {
  const root = domain.trim().toLowerCase();
  const isApex = record.name === root;
  const subdomain = isApex ? '@' : record.name.slice(0, record.name.length - root.length - 1);

  switch (registrar) {
    case 'cloudflare':
      return {
        name: isApex ? root : subdomain,
        hint: 'Cloudflare appends your domain automatically. Enter only the part before it, and set the record to DNS-only (grey cloud), not proxied.',
      };
    case 'godaddy':
      return {
        name: subdomain,
        hint: 'GoDaddy strips your domain from the name. Enter only the part before it — use @ for the domain itself.',
      };
    case 'route53':
      return {
        name: record.name,
        hint: 'Route 53 wants the full record name including your domain.',
      };
    case 'namecheap':
      return {
        name: subdomain,
        hint: 'Namecheap calls this the Host field. Use @ for the domain itself.',
      };
    case 'other':
      return { name: record.name };
  }
}
