/**
 * Design spec §7 — Decision Trace.
 *
 * routeConnector() in @platform-hub/provider-registry already returns
 * { connector, reason, considered, rejected } — the exact structure a trace
 * UI needs — and the pipeline currently discards it at the function boundary.
 * This module is where it stops being discarded.
 *
 * A refusal a customer's security team cannot audit is indistinguishable
 * from a bug.
 */

export type GateVerdict = 'PASS' | 'FAIL' | 'NOT_EVALUATED';

/**
 * §3.1 — the enforcement spine, in order.
 *
 * The ordering is not arbitrary: cheap and absolute checks precede expensive
 * and conditional ones, and nothing that costs money or touches a provider
 * happens before every refusal path has been evaluated.
 */
export const ENFORCEMENT_GATES = [
  'INTENT_VALIDATION',
  'PLANE_DERIVATION',
  'COMPLIANCE_PACK',
  'CONSENT',
  'SUPPRESSION',
  'FREQUENCY_CAP',
  'QUIET_HOURS',
  'EXPIRY',
  'TEMPLATE_RENDER',
  'SENDER_DOMAIN',
  'CONNECTOR_ROUTING',
  'CREDENTIAL_LEASE',
  'QUOTA_THROTTLE',
  'SPEND_CAP',
  'DISPATCH',
  'OUTCOME_CLASSIFICATION',
] as const;

export type EnforcementGate = (typeof ENFORCEMENT_GATES)[number];

export function gateOrdinal(gate: EnforcementGate): number {
  return ENFORCEMENT_GATES.indexOf(gate) + 1;
}

export interface GateRecord {
  readonly gate: EnforcementGate;
  readonly ordinal: number;
  readonly verdict: GateVerdict;
  /** The value that decided it. Recipient identifiers arrive already redacted. */
  readonly detail: string;
  readonly elapsedMs: number;
  /** Present only on FAIL. Plain language, ends with what to do (§7.2). */
  readonly remediation?: string;
  /** Deep link into the screen that fixes it. A diagnosis without a route is a log file. */
  readonly remediationHref?: string;
}

export type TraceKind = 'DISPATCH' | 'SIMULATION' | 'WEBHOOK' | 'REVOCATION';

export type TraceOutcome =
  | 'SENT'
  | 'QUEUED'
  | 'REFUSED'
  | 'THROTTLED'
  | 'SUPPRESSED'
  | 'CANCELLED'
  | 'FAILED';

export interface DecisionTrace {
  readonly traceId: string;
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly messageId?: string;
  readonly kind: TraceKind;
  readonly outcome: TraceOutcome;
  readonly reasonCode?: string;
  readonly stoppedAtGate?: number;
  readonly gates: readonly GateRecord[];
  readonly connectorsConsidered: readonly string[];
  readonly connectorsRejected: Readonly<Record<string, readonly string[]>>;
  readonly compliancePackVersions: Readonly<Record<string, string>>;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Accumulates gate records as the pipeline runs. One builder per dispatch or
 * simulation. Gates not reached are emitted as NOT_EVALUATED, never omitted
 * and never shown as passed — showing later gates as blank misrepresents the
 * system, and `not evaluated` teaches the ordering (§7.2).
 */
/**
 * Where a gate outcome goes as it happens, in addition to the trace.
 *
 * Optional, and injected rather than imported, so this module keeps no opinion
 * about logging and no dependency on a logger. Absent, nothing changes.
 *
 * The point of driving the live log from the same recorder as the durable trace
 * is that they cannot drift: an incident reconstructed from logs and one
 * reconstructed from traces are reading the same fields, written once.
 */
export interface GateObserver {
  (record: {
    readonly gate: string;
    readonly ordinal: number;
    readonly verdict: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
    readonly detail: string;
    readonly elapsedMs: number;
    readonly remediation?: string;
  }): void;
}

export class DecisionTraceBuilder {
  private readonly records: GateRecord[] = [];
  private readonly startedAt: number;
  private readonly clock: () => number;
  private readonly observe: GateObserver | undefined;
  private stopped: EnforcementGate | null = null;
  private considered: readonly string[] = [];
  private rejected: Readonly<Record<string, readonly string[]>> = {};
  private packs: Record<string, string> = {};

  constructor(clock: () => number = () => Date.now(), observe?: GateObserver) {
    this.clock = clock;
    this.startedAt = clock();
    this.observe = observe;
  }

  pass(gate: EnforcementGate, detail: string): this {
    if (this.stopped !== null) return this;
    const record = {
      gate,
      ordinal: gateOrdinal(gate),
      verdict: 'PASS' as const,
      detail,
      elapsedMs: this.clock() - this.startedAt,
    };
    this.records.push(record);
    this.observe?.(record);
    return this;
  }

  fail(
    gate: EnforcementGate,
    detail: string,
    remediation?: { readonly message: string; readonly href?: string },
  ): this {
    if (this.stopped !== null) return this;
    const record = {
      gate,
      ordinal: gateOrdinal(gate),
      verdict: 'FAIL' as const,
      detail,
      elapsedMs: this.clock() - this.startedAt,
      ...(remediation !== undefined ? { remediation: remediation.message } : {}),
      ...(remediation?.href !== undefined ? { remediationHref: remediation.href } : {}),
    };
    this.records.push(record);
    this.observe?.(record);
    this.stopped = gate;
    return this;
  }

  /** Records routeConnector()'s output verbatim — the structure it already returns. */
  routing(input: {
    readonly considered: readonly string[];
    readonly rejected: Readonly<Record<string, readonly string[]>>;
  }): this {
    this.considered = input.considered;
    this.rejected = input.rejected;
    return this;
  }

  compliancePacks(packs: Readonly<Record<string, string>>): this {
    this.packs = { ...this.packs, ...packs };
    return this;
  }

  build(input: {
    readonly traceId: string;
    readonly tenantId: string;
    readonly organizationId?: string;
    readonly messageId?: string;
    readonly kind: TraceKind;
    readonly outcome: TraceOutcome;
    readonly reasonCode?: string;
    readonly correlationId: string;
    readonly createdAt?: string;
  }): DecisionTrace {
    const reached = new Set(this.records.map((record) => record.gate));
    const elapsed = this.clock() - this.startedAt;

    // Everything the pipeline never got to is explicitly NOT_EVALUATED.
    const complete: GateRecord[] = [...this.records];
    for (const gate of ENFORCEMENT_GATES) {
      if (!reached.has(gate)) {
        complete.push({
          gate,
          ordinal: gateOrdinal(gate),
          verdict: 'NOT_EVALUATED',
          detail: this.stopped === null ? 'not reached' : `not evaluated — stopped at gate ${gateOrdinal(this.stopped)}`,
          elapsedMs: elapsed,
        });
      }
    }
    complete.sort((a, b) => a.ordinal - b.ordinal);

    const createdAt = input.createdAt ?? new Date().toISOString();

    return {
      traceId: input.traceId,
      tenantId: input.tenantId,
      ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
      kind: input.kind,
      outcome: input.outcome,
      ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
      ...(this.stopped !== null ? { stoppedAtGate: gateOrdinal(this.stopped) } : {}),
      gates: complete,
      connectorsConsidered: this.considered,
      connectorsRejected: this.rejected,
      compliancePackVersions: this.packs,
      correlationId: input.correlationId,
      createdAt,
      expiresAt: traceExpiry(input.outcome, createdAt),
    };
  }
}

/**
 * §4.3 — the retention asymmetry.
 *
 * 30 days for successes, 400 days for every refusal. Refusals are the audit
 * artifact and are rare; successes are the metric. Storing refusals ten times
 * longer costs almost nothing and is exactly the asymmetry an auditor needs.
 */
export function traceExpiry(outcome: TraceOutcome, createdAt: string): string {
  const days = outcome === 'SENT' || outcome === 'QUEUED' ? 30 : 400;
  return new Date(Date.parse(createdAt) + days * 86_400_000).toISOString();
}

/**
 * §3.4 / §7.2 — recipient addresses are redacted in the UI and present in the
 * export only for users holding the PII-read entitlement. One predicate,
 * used by the API serialiser and by every CSV/JSON export.
 */
export function redactRecipient(value: string): string {
  const at = value.indexOf('@');
  if (at > 0) {
    const domain = value.slice(at + 1);
    const dot = domain.indexOf('.');
    const tld = dot > 0 ? domain.slice(dot) : '';
    return `${value[0] ?? ''}***@${domain[0] ?? ''}***${tld}`;
  }
  if (value.length > 4) {
    return `${value.slice(0, 2)}${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-2)}`;
  }
  return '***';
}

export interface DecisionTraceRepository {
  record(trace: DecisionTrace): Promise<void>;
  findById(input: { readonly tenantId: string; readonly traceId: string }): Promise<DecisionTrace | null>;
  list(input: {
    readonly tenantId: string;
    readonly messageId?: string;
    readonly outcome?: TraceOutcome;
    readonly reasonCode?: string;
    readonly from?: string;
    readonly to?: string;
    readonly limit: number;
    readonly offset: number;
  }): Promise<{ readonly traces: readonly DecisionTrace[]; readonly total: number }>;
}
