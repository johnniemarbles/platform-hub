import type {
  VoiceCallDirection,
  VoiceCallTransition,
  VoiceParticipant,
  VoiceTransportSession,
} from './voice-transport.ts';

export interface CreateVoiceTransportSessionInput {
  readonly callId: string;
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly connectorKey: string;
  readonly providerCallId?: string;
  readonly direction: VoiceCallDirection;
  readonly from: VoiceParticipant;
  readonly to: VoiceParticipant;
  readonly requestedAt: string;
  readonly conversationId?: string;
  readonly agentId?: string;
}

export interface ApplyVoiceTransportTransitionInput {
  readonly tenantId: string;
  readonly callId: string;
  readonly transition: VoiceCallTransition;
}

export interface ApplyVoiceTransportTransitionResult {
  readonly applied: boolean;
  readonly session: VoiceTransportSession;
}

/**
 * Persistence port for the Communication-owned telephony lifecycle. AI speech
 * and reasoning services may reference callId but do not own these mutations.
 */
export interface VoiceTransportRepository {
  create(input: CreateVoiceTransportSessionInput): Promise<VoiceTransportSession>;
  findByCallId(input: {
    readonly tenantId: string;
    readonly callId: string;
  }): Promise<VoiceTransportSession | null>;
  findByProviderCallId(input: {
    readonly tenantId: string;
    readonly connectorKey: string;
    readonly providerCallId: string;
  }): Promise<VoiceTransportSession | null>;
  applyTransition(input: ApplyVoiceTransportTransitionInput): Promise<ApplyVoiceTransportTransitionResult>;
}
