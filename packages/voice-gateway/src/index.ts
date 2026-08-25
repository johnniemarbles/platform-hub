export type VoiceIntelligenceOperation =
  | 'TRANSCRIBE'
  | 'SYNTHESIZE'
  | 'STREAM_CONVERSATION';

export interface VoiceIntelligenceIntent {
  readonly requestId: string;
  readonly tenantId: string;
  readonly callId: string;
  readonly operation: VoiceIntelligenceOperation;
  readonly purpose: string;
  /** Audio, transcript, or synthesis-input reference; never raw media. */
  readonly inputReference: string;
  readonly languageTag: string;
  readonly governance: {
    readonly recordingConsentEvidenceReference?: string;
    readonly callerDisclosureEvidenceReference?: string;
    readonly recordingRetentionPolicy: VersionedVoicePolicyReference;
    readonly transcriptRetentionPolicy: VersionedVoicePolicyReference;
    readonly redactionPolicy: VersionedVoicePolicyReference;
    readonly jurisdictionTags: readonly string[];
    readonly requiredResidencyTags: readonly string[];
    readonly requiredComplianceTags: readonly string[];
    readonly maximumCostMinorUnits?: number;
  };
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface VersionedVoicePolicyReference {
  readonly key: string;
  readonly version: number;
}

export interface VoiceGateway {
  invoke(intent: VoiceIntelligenceIntent): Promise<VoiceIntelligenceObservation>;
}

export interface VoiceIntelligenceObservation {
  readonly requestId: string;
  readonly tenantId: string;
  readonly callId: string;
  readonly operation: VoiceIntelligenceOperation;
  readonly outputReference: string;
  readonly provenance: VoiceIntelligenceProvenance;
}

export interface VoiceIntelligenceProvenance {
  readonly connectorKey: string;
  readonly providerKey: string;
  readonly modelKey: string;
  readonly sourceReferences: readonly string[];
  readonly processedAt: string;
  readonly region?: string;
  readonly audioDurationMilliseconds?: number;
  readonly costMinorUnits?: number;
}

export type VoiceContractValidationCode =
  | 'VOICE_REQUEST_ID_REQUIRED'
  | 'VOICE_TENANT_REQUIRED'
  | 'VOICE_CALL_ID_REQUIRED'
  | 'VOICE_PURPOSE_REQUIRED'
  | 'VOICE_INPUT_REFERENCE_REQUIRED'
  | 'VOICE_LANGUAGE_REQUIRED'
  | 'VOICE_RECORDING_CONSENT_EVIDENCE_REQUIRED'
  | 'VOICE_POLICY_REFERENCE_INVALID'
  | 'VOICE_JURISDICTION_REQUIRED'
  | 'VOICE_IDEMPOTENCY_REQUIRED'
  | 'VOICE_REQUESTED_AT_INVALID'
  | 'VOICE_COST_LIMIT_INVALID'
  | 'VOICE_OBSERVATION_IDENTITY_MISMATCH'
  | 'VOICE_OUTPUT_REFERENCE_REQUIRED'
  | 'VOICE_PROVENANCE_REQUIRED'
  | 'VOICE_PROVENANCE_SOURCE_REQUIRED'
  | 'VOICE_PROCESSED_AT_INVALID'
  | 'VOICE_AUDIO_DURATION_INVALID'
  | 'VOICE_COST_INVALID';

export interface VoiceContractValidationIssue {
  readonly code: VoiceContractValidationCode;
  readonly path: string;
}

export type VoiceContractValidationResult =
  | { readonly valid: true; readonly issues: readonly [] }
  | {
      readonly valid: false;
      readonly issues: readonly VoiceContractValidationIssue[];
    };

export function validateVoiceIntelligenceIntent(
  intent: VoiceIntelligenceIntent,
): VoiceContractValidationResult {
  const issues: VoiceContractValidationIssue[] = [];
  required(intent.requestId, 'VOICE_REQUEST_ID_REQUIRED', 'requestId', issues);
  required(intent.tenantId, 'VOICE_TENANT_REQUIRED', 'tenantId', issues);
  required(intent.callId, 'VOICE_CALL_ID_REQUIRED', 'callId', issues);
  required(intent.purpose, 'VOICE_PURPOSE_REQUIRED', 'purpose', issues);
  required(
    intent.inputReference,
    'VOICE_INPUT_REFERENCE_REQUIRED',
    'inputReference',
    issues,
  );
  required(intent.languageTag, 'VOICE_LANGUAGE_REQUIRED', 'languageTag', issues);

  if (
    (intent.operation === 'TRANSCRIBE'
      || intent.operation === 'STREAM_CONVERSATION')
    && !nonBlank(intent.governance.recordingConsentEvidenceReference)
  ) {
    issues.push({
      code: 'VOICE_RECORDING_CONSENT_EVIDENCE_REQUIRED',
      path: 'governance.recordingConsentEvidenceReference',
    });
  }

  for (const [path, policy] of [
    [
      'governance.recordingRetentionPolicy',
      intent.governance.recordingRetentionPolicy,
    ],
    [
      'governance.transcriptRetentionPolicy',
      intent.governance.transcriptRetentionPolicy,
    ],
    ['governance.redactionPolicy', intent.governance.redactionPolicy],
  ] as const) {
    if (
      policy.key.trim() === ''
      || !Number.isInteger(policy.version)
      || policy.version <= 0
    ) {
      issues.push({ code: 'VOICE_POLICY_REFERENCE_INVALID', path });
    }
  }

  if (intent.governance.jurisdictionTags.length === 0) {
    issues.push({
      code: 'VOICE_JURISDICTION_REQUIRED',
      path: 'governance.jurisdictionTags',
    });
  }
  required(
    intent.idempotencyKey,
    'VOICE_IDEMPOTENCY_REQUIRED',
    'idempotencyKey',
    issues,
  );
  if (!validInstant(intent.requestedAt)) {
    issues.push({ code: 'VOICE_REQUESTED_AT_INVALID', path: 'requestedAt' });
  }
  if (
    intent.governance.maximumCostMinorUnits !== undefined
    && (
      !Number.isInteger(intent.governance.maximumCostMinorUnits)
      || intent.governance.maximumCostMinorUnits < 0
    )
  ) {
    issues.push({
      code: 'VOICE_COST_LIMIT_INVALID',
      path: 'governance.maximumCostMinorUnits',
    });
  }
  return result(issues);
}

export function validateVoiceIntelligenceObservation(
  intent: VoiceIntelligenceIntent,
  observation: VoiceIntelligenceObservation,
): VoiceContractValidationResult {
  const issues: VoiceContractValidationIssue[] = [];
  if (
    observation.requestId !== intent.requestId
    || observation.tenantId !== intent.tenantId
    || observation.callId !== intent.callId
    || observation.operation !== intent.operation
  ) {
    issues.push({
      code: 'VOICE_OBSERVATION_IDENTITY_MISMATCH',
      path: 'observation',
    });
  }
  required(
    observation.outputReference,
    'VOICE_OUTPUT_REFERENCE_REQUIRED',
    'outputReference',
    issues,
  );
  for (const [path, value] of [
    ['provenance.connectorKey', observation.provenance.connectorKey],
    ['provenance.providerKey', observation.provenance.providerKey],
    ['provenance.modelKey', observation.provenance.modelKey],
  ] as const) {
    required(value, 'VOICE_PROVENANCE_REQUIRED', path, issues);
  }
  if (observation.provenance.sourceReferences.length === 0) {
    issues.push({
      code: 'VOICE_PROVENANCE_SOURCE_REQUIRED',
      path: 'provenance.sourceReferences',
    });
  }
  if (!validInstant(observation.provenance.processedAt)) {
    issues.push({
      code: 'VOICE_PROCESSED_AT_INVALID',
      path: 'provenance.processedAt',
    });
  }
  const duration = observation.provenance.audioDurationMilliseconds;
  if (
    duration !== undefined
    && (!Number.isInteger(duration) || duration < 0)
  ) {
    issues.push({
      code: 'VOICE_AUDIO_DURATION_INVALID',
      path: 'provenance.audioDurationMilliseconds',
    });
  }
  const cost = observation.provenance.costMinorUnits;
  if (cost !== undefined && (!Number.isInteger(cost) || cost < 0)) {
    issues.push({ code: 'VOICE_COST_INVALID', path: 'provenance.costMinorUnits' });
  }
  return result(issues);
}

function required(
  value: string,
  code: VoiceContractValidationCode,
  path: string,
  issues: VoiceContractValidationIssue[],
): void {
  if (value.trim() === '') issues.push({ code, path });
}

function nonBlank(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function validInstant(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function result(
  issues: VoiceContractValidationIssue[],
): VoiceContractValidationResult {
  return issues.length === 0
    ? { valid: true, issues: [] }
    : { valid: false, issues };
}

export * from './routing.ts';
