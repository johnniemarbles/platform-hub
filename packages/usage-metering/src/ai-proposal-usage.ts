import { createHash } from 'node:crypto';
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
    readonly costStatus?: 'CALCULATED' | 'UNKNOWN_TOKENS';
    readonly priceSource?: 'provider' | 'matrix' | 'cost-tables' | null;
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
  const hex = createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
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
  // Source references may contain full prompt text in provider adapters. Keep
  // raw prompt/context out of the usage ledger's evidence_refs column.
  const evidenceRefs = [`ai-proposal://${proposal.invocationId}`];
  const cost = proposal.provenance.costMinorUnits ?? 0;
  const inputTokens = proposal.provenance.inputTokens ?? 0;
  const outputTokens = proposal.provenance.outputTokens ?? 0;
  const completeTokenEvidence = proposal.provenance.inputTokens !== undefined
    && proposal.provenance.outputTokens !== undefined;
  const costStatus = proposal.provenance.costStatus
    ?? (proposal.provenance.costMinorUnits !== undefined || completeTokenEvidence
      ? 'CALCULATED'
      : 'UNKNOWN_TOKENS');
  const priceSource = proposal.provenance.priceSource
    ?? (proposal.provenance.costMinorUnits === undefined ? null : 'cost-tables');
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
    costStatus,
    priceSource,
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
