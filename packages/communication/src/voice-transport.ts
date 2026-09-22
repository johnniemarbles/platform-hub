export type VoiceCallDirection = 'INBOUND' | 'OUTBOUND';

export type VoiceCallState =
  | 'REQUESTED'
  | 'RINGING'
  | 'ANSWERED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface VoiceParticipant {
  readonly address: string;
  readonly subjectId?: string;
  readonly displayName?: string;
}

export interface VoiceTransportSession {
  readonly callId: string;
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly connectorKey: string;
  readonly providerCallId?: string;
  readonly direction: VoiceCallDirection;
  readonly from: VoiceParticipant;
  readonly to: VoiceParticipant;
  readonly state: VoiceCallState;
  readonly requestedAt: string;
  readonly answeredAt?: string;
  readonly endedAt?: string;
  readonly recordingRef?: string;
  readonly transcriptRef?: string;
  readonly conversationId?: string;
  readonly agentId?: string;
  readonly humanHandoffRequestedAt?: string;
  readonly lastReasonCode?: string;
}

export interface VoiceCallTransition {
  readonly from: VoiceCallState;
  readonly to: VoiceCallState;
  readonly occurredAt: string;
  readonly providerEventId?: string;
  readonly providerCallId?: string;
  readonly recordingRef?: string;
  readonly transcriptRef?: string;
  readonly reasonCode?: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<VoiceCallState, readonly VoiceCallState[]>> = {
  REQUESTED: ['RINGING', 'ANSWERED', 'FAILED', 'CANCELLED'],
  RINGING: ['ANSWERED', 'FAILED', 'CANCELLED'],
  ANSWERED: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/**
 * Communication owns voice transport lifecycle only. STT, TTS, semantic
 * extraction, conversational reasoning and voice-model execution live in the
 * AI/Voice intelligence layer and reference this session by callId.
 */
export function assertVoiceCallTransition(from: VoiceCallState, to: VoiceCallState): void {
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new Error(`VOICE_CALL_TRANSITION_INVALID:${from}->${to}`);
  }
}
