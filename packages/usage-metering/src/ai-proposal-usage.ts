import { randomUUID } from 'node:crypto';
import {
  validateIntelligenceUsageEvent,
  type IntelligenceUsageEvent,
  type ProviderCostOwnership,
} from './index.ts';

/** Minimal proposal shape so usage-metering does not import @platform-hub/ai-gateway. */
export interface AiProposalUsageSource {
  readonly invocationId: string;
  readonly tenantId: string;
  readonly operation: string;
  readonly provenance: {
    readonly connectorKey: string;
    readonly providerKey: string;
    readonly modelKey: string;
    readonly processedAt: string;
    readonly costMinorUnits?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly sourceReferences: readonly string[];
  };
}

export interface ComposeAiProposalUsageInput {
  readonly proposal: AiProposalUsageSource;
  readonly organizationId?: string | null;
  readonly providerCostOwnership?: ProviderCostOwnership;
  readonly correlationId?: string;
  readonly recordedAt?: string;
  readonly workReference?: string;
  readonly currency?: string;
}

function capabilityKey(operation: string): string {
  return `ai.${operation.trim().toLowerCase()}`;
}

function deterministicEventId(parts: readonly string[]): string {
  // Prefer randomUUID at record time; this is only used when caller needs stable tests.
  void parts;
  return randomUUID();
}

/**
 * Build immutable usage meters for a successful AI proposal.
 * - AI_REQUEST (quantity 1, full cost on this meter)
 * - AI_INPUT_TOKEN / AI_OUTPUT_TOKEN (quantity = tokens, cost 0 to avoid double-count)
 * Callers record via IntelligenceUsageRepository; cost position uses sum(cost_minor_units).
 */
export function composeAiProposalUsageEvents(
  input: ComposeAiProposalUsageInput,
): readonly IntelligenceUsageEvent[] {
  const { proposal } = input;
  const occurredAt = proposal.provenance.processedAt;
  const recordedAt = input.recordedAt ?? occurredAt;
  const correlationId = input.correlationId ?? proposal.invocationId;
  const ownership = input.providerCostOwnership ?? 'BYOK';
  const currency = (input.currency ?? 'USD').toUpperCase();
  const workReference =
    input.workReference ?? `ai-invocation://${proposal.invocationId}`;
  const evidenceRefs =
    proposal.provenance.sourceReferences.length > 0
      ? proposal.provenance.sourceReferences
      : [`ai-proposal://${proposal.invocationId}`];
  const cost = proposal.provenance.costMinorUnits ?? 0;
  const inputTokens = proposal.provenance.inputTokens ?? 0;
  const outputTokens = proposal.provenance.outputTokens ?? 0;
  const cap = capabilityKey(proposal.operation);

  const base = {
    tenantId: proposal.tenantId,
    organizationId: input.organizationId ?? null,
    currency,
    capabilityKey: cap,
    connectorKey: proposal.provenance.connectorKey,
    providerKey: proposal.provenance.providerKey,
    modelKey: proposal.provenance.modelKey,
    providerCostOwnership: ownership,
    workReference,
    occurredAt,
    recordedAt,
    correlationId,
    evidenceRefs,
  } as const;

  const events: IntelligenceUsageEvent[] = [
    validateIntelligenceUsageEvent({
      ...base,
      eventId: deterministicEventId([proposal.invocationId, 'AI_REQUEST']),
      meter: 'AI_REQUEST',
      quantity: 1,
      costMinorUnits: cost,
    }),
  ];

  if (inputTokens > 0) {
    events.push(
      validateIntelligenceUsageEvent({
        ...base,
        eventId: deterministicEventId([proposal.invocationId, 'AI_INPUT_TOKEN']),
        meter: 'AI_INPUT_TOKEN',
        quantity: inputTokens,
        costMinorUnits: 0,
      }),
    );
  }
  if (outputTokens > 0) {
    events.push(
      validateIntelligenceUsageEvent({
        ...base,
        eventId: deterministicEventId([proposal.invocationId, 'AI_OUTPUT_TOKEN']),
        meter: 'AI_OUTPUT_TOKEN',
        quantity: outputTokens,
        costMinorUnits: 0,
      }),
    );
  }

  return events;
}
