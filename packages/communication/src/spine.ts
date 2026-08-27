import type {
  CommunicationDispatchResult,
  CommunicationIntent,
  CommunicationPreflightDecision,
} from './index.js';
import { derivePlane, planeCharacteristics, type CommunicationPlane } from './plane.js';
import {
  DecisionTraceBuilder,
  redactRecipient,
  type DecisionTrace,
  type DecisionTraceRepository,
  type TraceOutcome,
} from './decision-trace.js';
import type {
  CommunicationSpendRepository,
  CommunicationThrottleRepository,
  ThrottleLimits,
} from './throttle.js';

/**
 * Design spec §3.1 — the enforcement spine.
 *
 * Every gate, in order, each returning a structured reason, each appearing in
 * the Decision Trace. This ordering is not arbitrary: cheap and absolute
 * checks precede expensive and conditional ones, and nothing that costs money
 * or touches a provider happens before every refusal path has been evaluated.
 *
 * Step 12 (credential lease) precedes step 13 (quota consume) deliberately:
 * leasing is cheaper and more reversible than consuming a quota slot, and a
 * tenant whose credential is revoked should not also lose quota headroom to a
 * send that was never going to happen.
 */

export interface ExpiryPolicy {
  /** B17 — OTP 10 min · operational 4 h · marketing send window. */
  readonly expiresAt?: string;
}

export interface SenderResolution {
  readonly resolved: boolean;
  readonly senderIdentityId?: string;
  readonly fromAddress?: string;
  readonly domain?: string;
  readonly domainStatus?: 'VERIFIED' | 'PENDING' | 'FAILED' | 'RETIRED';
  readonly reasonCode?: string;
  readonly remediation?: string;
  readonly remediationHref?: string;
}

export interface ConnectorResolution {
  readonly connectorKey: string | null;
  readonly reason: string;
  readonly considered: readonly string[];
  readonly rejected: Readonly<Record<string, readonly string[]>>;
  readonly residencyPinned: boolean;
}

export interface CredentialLeaseResolution {
  readonly leased: boolean;
  readonly leaseReference?: string;
  readonly expiresAt?: string;
  readonly reasonCode?: string;
}

export interface RenderResolution {
  readonly rendered: boolean;
  readonly templateKey?: string;
  readonly templateVersion?: number;
  readonly bytes?: number;
  readonly reasonCode?: string;
}

export interface SpinePorts {
  readonly throttle: CommunicationThrottleRepository;
  readonly spend: CommunicationSpendRepository;
  readonly traces: DecisionTraceRepository;
}

export interface SpineInput {
  readonly intent: CommunicationIntent;
  readonly correlationId: string;
  readonly traceId: string;
  readonly kind: 'DISPATCH' | 'SIMULATION';
  readonly preflight: CommunicationPreflightDecision;
  readonly compliancePackVersions: Readonly<Record<string, string>>;
  readonly quietHours?: { readonly withinQuietWindow: boolean; readonly localTime: string; readonly window: string };
  readonly frequencyCap?: { readonly used: number; readonly limit: number };
  readonly expiry?: ExpiryPolicy;
  readonly render: RenderResolution;
  readonly sender: SenderResolution;
  readonly connector: ConnectorResolution;
  readonly lease: CredentialLeaseResolution;
  readonly throttleLimits: ThrottleLimits;
  readonly estimatedCostMinorUnits: number;
  readonly now?: () => string;
  readonly clock?: () => number;
}

export interface SpineResult {
  readonly trace: DecisionTrace;
  readonly dispatch: CommunicationDispatchResult;
  readonly plane: CommunicationPlane;
}

/**
 * Runs every gate and produces the trace. A SIMULATION runs the identical
 * path and consumes nothing — §7.3: "the simulator runs the real resolver,
 * so the trace is the same object. There is no second implementation to drift."
 */
export async function runEnforcementSpine(
  input: SpineInput,
  ports: SpinePorts,
): Promise<SpineResult> {
  const trace = new DecisionTraceBuilder(input.clock);
  const simulate = input.kind === 'SIMULATION';
  const nowIso = input.now?.() ?? new Date().toISOString();

  trace.compliancePacks(input.compliancePackVersions);
  trace.routing({ considered: input.connector.considered, rejected: input.connector.rejected });

  const finish = async (
    outcome: TraceOutcome,
    reasonCode: string,
    refusalReason?: string,
  ): Promise<SpineResult> => {
    const built = trace.build({
      traceId: input.traceId,
      tenantId: input.intent.tenantId,
      ...(input.intent.organizationId !== undefined
        ? { organizationId: input.intent.organizationId }
        : {}),
      kind: input.kind,
      outcome,
      ...(reasonCode !== 'OK' ? { reasonCode } : {}),
      correlationId: input.correlationId,
      createdAt: nowIso,
    });
    await ports.traces.record(built);
    return {
      trace: built,
      plane: derivePlane(input.intent.purpose),
      dispatch: {
        state: outcome === 'SENT' ? 'SENT' : outcome === 'QUEUED' ? 'QUEUED' : 'REFUSED',
        reasonCode: reasonCode as CommunicationDispatchResult['reasonCode'],
        messageId: null,
        ...(input.connector.connectorKey !== null
          ? { providerKey: input.connector.connectorKey }
          : {}),
        ...(refusalReason !== undefined ? { refusalReason } : {}),
        queuedAt: nowIso,
      },
    };
  };

  // ── 01 Intent validation ────────────────────────────────────────────────
  const recipientLabel =
    input.intent.recipient.email ??
    input.intent.recipient.phone ??
    input.intent.recipient.whatsapp ??
    input.intent.recipient.subjectId ??
    '';
  if (recipientLabel === '') {
    trace.fail('INTENT_VALIDATION', 'no addressable recipient field present', {
      message: 'This intent carries no email, phone, WhatsApp number or subject ID. The calling module must supply one.',
    });
    return finish('REFUSED', 'INVALID_RECIPIENT');
  }
  trace.pass(
    'INTENT_VALIDATION',
    `${redactRecipient(recipientLabel)} · ${input.intent.channel ?? 'inferred'}`,
  );

  // ── 02 Plane derivation (BEMP K7 — never accepted from the caller) ──────
  const plane = derivePlane(input.intent.purpose);
  const characteristics = planeCharacteristics(input.intent.purpose);
  trace.pass('PLANE_DERIVATION', `${plane} — derived from purpose '${input.intent.purpose}'`);

  // ── 03 Compliance pack ──────────────────────────────────────────────────
  const packs = Object.entries(input.compliancePackVersions);
  if (packs.length === 0) {
    trace.pass('COMPLIANCE_PACK', 'BASELINE — no jurisdiction pack adopted');
  } else {
    trace.pass('COMPLIANCE_PACK', packs.map(([key, version]) => `${key} ${version}`).join(' · '));
  }

  // ── 04 Consent ──────────────────────────────────────────────────────────
  if (!input.preflight.allowed && input.preflight.reasonCode === 'CONSENT_MISSING') {
    trace.fail('CONSENT', 'no consent assertion on record for this recipient and purpose', {
      message: 'The calling module must assert consent before this message can be sent. EXPADIO does not evaluate consent on your behalf.',
    });
    return finish('REFUSED', 'CONSENT_NOT_ASSERTED');
  }
  trace.pass('CONSENT', input.intent.consentRequired ? 'asserted' : 'not required for this channel');

  // ── 05 Suppression ──────────────────────────────────────────────────────
  if (!input.preflight.allowed && input.preflight.reasonCode === 'SUPPRESSED') {
    trace.fail('SUPPRESSION', 'recipient is on a suppression list', {
      message: 'This address is suppressed. Suppression is never bypassed, including by an explicit override flag.',
      remediationHref: '/communications/suppressions',
    });
    return finish('SUPPRESSED', 'BRAND_SUPPRESSED');
  }
  trace.pass('SUPPRESSION', 'clear — platform tier, brand tier');

  // ── 06 Frequency cap ────────────────────────────────────────────────────
  if (characteristics.frequencyCapApply && input.frequencyCap !== undefined) {
    if (input.frequencyCap.used >= input.frequencyCap.limit) {
      trace.fail(
        'FREQUENCY_CAP',
        `${input.frequencyCap.used} of ${input.frequencyCap.limit} in the trailing window`,
        { message: 'This recipient has reached their frequency cap. Raise the cap in Limits, or wait for the window to roll.', remediationHref: '/communications/limits' },
      );
      return finish('SUPPRESSED', 'FREQUENCY_CAPPED');
    }
    trace.pass('FREQUENCY_CAP', `${input.frequencyCap.used} of ${input.frequencyCap.limit} in the trailing window`);
  } else {
    trace.pass('FREQUENCY_CAP', 'not applicable on the transactional plane');
  }

  // ── 07 Quiet hours ──────────────────────────────────────────────────────
  if (characteristics.quietHoursApply && input.quietHours?.withinQuietWindow === true) {
    trace.fail(
      'QUIET_HOURS',
      `${input.quietHours.localTime} recipient local · window ${input.quietHours.window}`,
      { message: 'This message falls inside the recipient\'s quiet hours. It will send when the window opens, or you can change the window in Limits.', remediationHref: '/communications/limits' },
    );
    return finish('THROTTLED', 'QUIET_HOURS');
  }
  trace.pass(
    'QUIET_HOURS',
    input.quietHours !== undefined
      ? `${input.quietHours.localTime} recipient local · window ${input.quietHours.window}`
      : 'not applicable on the transactional plane',
  );

  // ── 08 Expiry (BEMP C16, K9) ────────────────────────────────────────────
  if (input.expiry?.expiresAt !== undefined && Date.parse(input.expiry.expiresAt) <= Date.parse(nowIso)) {
    trace.fail('EXPIRY', `expired at ${input.expiry.expiresAt}`, {
      message: 'This message passed its expiry before it could be dispatched. A stale reminder is cancelled, not delivered late.',
    });
    return finish('CANCELLED', 'EXPIRED_BEFORE_DISPATCH');
  }
  trace.pass(
    'EXPIRY',
    input.expiry?.expiresAt !== undefined ? `expires ${input.expiry.expiresAt}` : 'no expiry set for this trigger',
  );

  // ── 09 Template render (BEMP K10 — byte-identical per version) ───────────
  if (!input.render.rendered) {
    trace.fail('TEMPLATE_RENDER', input.render.reasonCode ?? 'template could not be rendered', {
      message: 'The template failed to render. Check that every variable the template uses is present in the intent.',
      remediationHref: '/communications/templates',
    });
    return finish('REFUSED', input.render.reasonCode ?? 'TEMPLATE_MISSING');
  }
  trace.pass(
    'TEMPLATE_RENDER',
    `${input.render.templateKey ?? 'template'} v${input.render.templateVersion ?? 0} · ${input.render.bytes ?? 0} bytes`,
  );

  // ── 10 Sender + domain ──────────────────────────────────────────────────
  if (!input.sender.resolved) {
    trace.fail('SENDER_DOMAIN', input.sender.fromAddress ?? input.sender.domain ?? 'no sender resolved', {
      message:
        input.sender.remediation ??
        'No verified sender identity is available for this message. Verify your sending domain, then create a sender identity on it.',
      ...(input.sender.remediationHref !== undefined
        ? { href: input.sender.remediationHref }
        : { href: '/communications/onboarding' }),
    });
    return finish('REFUSED', input.sender.reasonCode ?? 'DOMAIN_UNVERIFIED');
  }
  trace.pass('SENDER_DOMAIN', `${input.sender.fromAddress ?? ''} · domain ${input.sender.domainStatus ?? 'VERIFIED'}`);

  // ── 11 Connector routing ────────────────────────────────────────────────
  if (input.connector.connectorKey === null) {
    const rejectedSummary = Object.entries(input.connector.rejected)
      .map(([key, reasons]) => `${key}: ${reasons.join(', ')}`)
      .join(' · ');
    trace.fail(
      'CONNECTOR_ROUTING',
      rejectedSummary === '' ? input.connector.reason : rejectedSummary,
      {
        message:
          'No connector satisfies this message\'s residency, compliance and health requirements. Connect a provider in the permitted region, or relax the routing policy.',
        href: '/communications/onboarding',
      },
    );
    return finish(
      'REFUSED',
      input.connector.reason === 'NO_COMPLIANT_CONNECTOR' ? 'REGION_UNAVAILABLE' : 'NO_PROVIDER_AVAILABLE',
    );
  }
  trace.pass(
    'CONNECTOR_ROUTING',
    `${input.connector.connectorKey} · ${input.connector.considered.length} considered, ${Object.keys(input.connector.rejected).length} rejected`,
  );

  // ── 12 Credential lease (60 s TTL — §3.5) ───────────────────────────────
  if (!input.lease.leased) {
    trace.fail('CREDENTIAL_LEASE', input.lease.reasonCode ?? 'lease refused', {
      message:
        input.lease.reasonCode === 'CREDENTIAL_REVOKED'
          ? 'This credential has been revoked. Connect a replacement, or point this connector at a new key.'
          : 'A credential lease could not be issued for this connector.',
      href: '/communications/onboarding',
    });
    return finish('REFUSED', input.lease.reasonCode ?? 'CREDENTIAL_LEASE_DENIED');
  }
  trace.pass('CREDENTIAL_LEASE', `leased until ${input.lease.expiresAt ?? 'unknown'} · 60s TTL`);

  // ── 13 Quota + throttle — CONSUME, not read (closes G2) ─────────────────
  if (simulate) {
    const peek = await ports.throttle.peek({ tenantId: input.intent.tenantId, plane });
    trace.pass(
      'QUOTA_THROTTLE',
      `simulation — not consumed · ${peek.minuteCount}/${input.throttleLimits.maxPerMinute} this minute, ${peek.dayCount}/${input.throttleLimits.maxPerDay} today`,
    );
  } else {
    const consumed = await ports.throttle.consume({
      tenantId: input.intent.tenantId,
      plane,
      limits: input.throttleLimits,
    });
    if (!consumed.allowed) {
      trace.fail(
        'QUOTA_THROTTLE',
        `${consumed.reasonCode === 'THROTTLE_EXCEEDED_MINUTE' ? consumed.minuteCount : consumed.dayCount} of ${consumed.limit}`,
        {
          message: `Your ${consumed.reasonCode === 'THROTTLE_EXCEEDED_MINUTE' ? 'per-minute' : 'daily'} limit is reached. Raise it in Limits if your plan allows.`,
          href: '/communications/limits',
        },
      );
      return finish('THROTTLED', plane === 'BULK' ? 'PLANE_BUDGET' : 'BRAND_QUOTA');
    }
    trace.pass(
      'QUOTA_THROTTLE',
      `consumed · ${consumed.minuteCount}/${input.throttleLimits.maxPerMinute} this minute, ${consumed.dayCount}/${input.throttleLimits.maxPerDay} today`,
    );
  }

  // ── 14 Spend cap ────────────────────────────────────────────────────────
  const spend = simulate
    ? await ports.spend.read(input.intent.tenantId)
    : await ports.spend.consume({
        tenantId: input.intent.tenantId,
        estimatedCostMinorUnits: input.estimatedCostMinorUnits,
      });

  if (!spend.allowed) {
    trace.fail('SPEND_CAP', `${spend.spentMinorUnits} of ${spend.capMinorUnits ?? 0} minor units`, {
      message: 'Your daily spend cap is reached and the breaker is open. A platform admin must reset it.',
      href: '/communications/limits',
    });
    return finish('THROTTLED', 'SPEND_CAP_REACHED');
  }
  trace.pass(
    'SPEND_CAP',
    spend.capMinorUnits === null ? 'no cap set' : `${spend.utilisationPct}% of daily cap · breaker ${spend.state}`,
  );

  // ── 15 Dispatch boundary ────────────────────────────────────────────────
  if (simulate) {
    trace.pass('DISPATCH', 'simulation — the provider was not called');
    trace.pass('OUTCOME_CLASSIFICATION', 'simulation — no provider outcome to classify');
    return finish('QUEUED', 'OK');
  }

  trace.pass('DISPATCH', `handing off to ${input.connector.connectorKey}`);
  trace.pass('OUTCOME_CLASSIFICATION', 'awaiting provider acceptance');
  return finish('QUEUED', 'OK');
}
