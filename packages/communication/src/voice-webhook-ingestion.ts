import type { CommunicationProviderWebhookRequest } from './provider-webhook.ts';
import type { VoiceTransportRepository } from './voice-transport-repository.ts';
import type { CommunicationProviderVoiceWebhookNormalizer } from './voice-webhook.ts';

export interface IngestCommunicationVoiceWebhookInput {
  readonly tenantId: string;
  readonly request: CommunicationProviderWebhookRequest;
  readonly normalizer: CommunicationProviderVoiceWebhookNormalizer;
  readonly voiceRepository: VoiceTransportRepository;
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

  let applied = 0;
  let duplicateOrNoop = 0;
  let unmatched = 0;
  let ignoredRegressions = 0;

  for (const event of normalized.events) {
    const session = await input.voiceRepository.findByProviderCallId({
      tenantId: input.tenantId,
      connectorKey: event.connectorKey,
      providerCallId: event.providerCallId,
    });
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
    ignoredRegressions,
  };
}

function isRegression(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith('VOICE_CALL_TRANSITION_INVALID:')
    || error.message.startsWith('VOICE_CALL_STALE_FROM_STATE:');
}
