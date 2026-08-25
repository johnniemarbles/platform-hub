import type { CommunicationProviderWebhookRequest } from './provider-webhook.ts';
import type {
  CreateVoiceTransportSessionInput,
  VoiceTransportRepository,
} from './voice-transport-repository.ts';
import type {
  CommunicationProviderVoiceEvent,
  CommunicationProviderVoiceWebhookNormalizer,
} from './voice-webhook.ts';

export interface VoiceInboundBootstrapResolution {
  readonly callId: string;
  readonly organizationId?: string;
  readonly conversationId?: string;
  readonly agentId?: string;
}

/**
 * The composition root owns ID generation and business-context resolution for
 * inbound calls. Communication never guesses organization/conversation/agent.
 */
export interface VoiceInboundBootstrapResolver {
  resolve(input: {
    readonly tenantId: string;
    readonly event: CommunicationProviderVoiceEvent;
  }): Promise<VoiceInboundBootstrapResolution | null>;
}

export interface IngestCommunicationVoiceWebhookInput {
  readonly tenantId: string;
  readonly request: CommunicationProviderWebhookRequest;
  readonly normalizer: CommunicationProviderVoiceWebhookNormalizer;
  readonly voiceRepository: VoiceTransportRepository;
  readonly inboundBootstrap?: VoiceInboundBootstrapResolver;
}

export type IngestCommunicationVoiceWebhookResult =
  | {
      readonly accepted: false;
      readonly reasonCode: 'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_PAYLOAD_INVALID';
      readonly reason?: string;
    }
  | {
      readonly accepted: true;
      readonly applied: number;
      readonly duplicateOrNoop: number;
      readonly unmatched: number;
      readonly bootstrappedInbound: number;
      readonly ignoredRegressions: number;
    };

export async function ingestCommunicationVoiceWebhook(
  input: IngestCommunicationVoiceWebhookInput,
): Promise<IngestCommunicationVoiceWebhookResult> {
  const normalized = await input.normalizer.verifyAndNormalize(input.request);
  if (!normalized.verified) {
    return {
      accepted: false,
      reasonCode: normalized.reasonCode,
      ...(normalized.reason === undefined ? {} : { reason: normalized.reason }),
    };
  }

  const inboundBootstrap = input.inboundBootstrap;
  let applied = 0;
  let duplicateOrNoop = 0;
  let unmatched = 0;
  let bootstrappedInbound = 0;
  let ignoredRegressions = 0;

  for (const event of normalized.events) {
    let session = await input.voiceRepository.findByProviderCallId({
      tenantId: input.tenantId,
      connectorKey: event.connectorKey,
      providerCallId: event.providerCallId,
    });

    if (
      session === null
      && inboundBootstrap !== undefined
      && canBootstrapInbound(event)
    ) {
      const resolved = await inboundBootstrap.resolve({
        tenantId: input.tenantId,
        event,
      });
      if (resolved !== null) {
        const createInput: CreateVoiceTransportSessionInput = {
          callId: resolved.callId,
          tenantId: input.tenantId,
          ...(resolved.organizationId === undefined ? {} : { organizationId: resolved.organizationId }),
          connectorKey: event.connectorKey,
          providerCallId: event.providerCallId,
          direction: 'INBOUND',
          from: { address: event.fromAddress },
          to: { address: event.toAddress },
          requestedAt: event.occurredAt,
          ...(resolved.conversationId === undefined ? {} : { conversationId: resolved.conversationId }),
          ...(resolved.agentId === undefined ? {} : { agentId: resolved.agentId }),
        };
        session = await input.voiceRepository.create(createInput);
        bootstrappedInbound += 1;
      }
    }

    if (session === null) {
      unmatched += 1;
      continue;
    }

    try {
      const result = await input.voiceRepository.applyTransition({
        tenantId: input.tenantId,
        callId: session.callId,
        transition: {
          from: session.state,
          to: event.state,
          occurredAt: event.occurredAt,
          providerEventId: event.providerEventId,
          providerCallId: event.providerCallId,
          ...(event.recordingRef === undefined ? {} : { recordingRef: event.recordingRef }),
          ...(event.transcriptRef === undefined ? {} : { transcriptRef: event.transcriptRef }),
          ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
        },
      });
      if (result.applied) applied += 1;
      else duplicateOrNoop += 1;
    } catch (error) {
      if (isRegression(error)) {
        ignoredRegressions += 1;
        continue;
      }
      throw error;
    }
  }

  return {
    accepted: true,
    applied,
    duplicateOrNoop,
    unmatched,
    bootstrappedInbound,
    ignoredRegressions,
  };
}

function canBootstrapInbound(
  event: CommunicationProviderVoiceEvent,
): event is CommunicationProviderVoiceEvent & {
  readonly direction: 'INBOUND';
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly state: 'REQUESTED' | 'RINGING' | 'ANSWERED';
} {
  return event.direction === 'INBOUND'
    && event.fromAddress !== undefined
    && event.toAddress !== undefined
    && (event.state === 'REQUESTED' || event.state === 'RINGING' || event.state === 'ANSWERED');
}

function isRegression(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith('VOICE_CALL_TRANSITION_INVALID:')
    || error.message.startsWith('VOICE_CALL_STALE_FROM_STATE:');
}
