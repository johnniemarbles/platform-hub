import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateVoiceIntelligenceIntent,
  validateVoiceIntelligenceObservation,
  type VoiceIntelligenceIntent,
  type VoiceIntelligenceObservation,
} from '../src/index.ts';

const intent: VoiceIntelligenceIntent = {
  requestId: 'voice-request-1',
  tenantId: 'tenant-1',
  callId: 'call-1',
  operation: 'TRANSCRIBE',
  purpose: 'Create a governed call transcript.',
  inputReference: 'object://tenant-1/call-1/audio',
  languageTag: 'en-CA',
  governance: {
    recordingConsentEvidenceReference: 'consent://call-1/recording',
    callerDisclosureEvidenceReference: 'disclosure://call-1/ai',
    recordingRetentionPolicy: { key: 'recording-retention', version: 2 },
    transcriptRetentionPolicy: { key: 'transcript-retention', version: 3 },
    redactionPolicy: { key: 'regulated-redaction', version: 4 },
    jurisdictionTags: ['CA-ON'],
    requiredResidencyTags: ['ca'],
    requiredComplianceTags: ['regulated'],
    maximumCostMinorUnits: 20,
  },
  idempotencyKey: 'transcribe:call-1:v3',
  requestedAt: '2026-08-25T15:00:00.000Z',
};

const observation: VoiceIntelligenceObservation = {
  requestId: intent.requestId,
  tenantId: intent.tenantId,
  callId: intent.callId,
  operation: intent.operation,
  outputReference: 'object://tenant-1/call-1/transcript',
  provenance: {
    connectorKey: 'tenant-stt',
    providerKey: 'customer-provider',
    modelKey: 'stt-model',
    sourceReferences: [intent.inputReference],
    processedAt: '2026-08-25T15:00:03.000Z',
    region: 'ca-central',
    audioDurationMilliseconds: 120000,
    costMinorUnits: 8,
  },
};

test('validates governed reference-only transcription intent', () => {
  assert.deepEqual(
    validateVoiceIntelligenceIntent(intent),
    { valid: true, issues: [] },
  );
});

test('requires recording-consent evidence for transcription', () => {
  const result = validateVoiceIntelligenceIntent({
    ...intent,
    governance: {
      ...intent.governance,
      recordingConsentEvidenceReference: '',
    },
  });
  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.equal(
    result.issues.some((issue) =>
      issue.code === 'VOICE_RECORDING_CONSENT_EVIDENCE_REQUIRED'
    ),
    true,
  );
});

test('validates output identity and provider provenance', () => {
  assert.deepEqual(
    validateVoiceIntelligenceObservation(intent, observation),
    { valid: true, issues: [] },
  );
});

test('rejects cross-tenant observations and invalid usage metrics', () => {
  const result = validateVoiceIntelligenceObservation(intent, {
    ...observation,
    tenantId: 'tenant-2',
    outputReference: '',
    provenance: {
      ...observation.provenance,
      connectorKey: '',
      sourceReferences: [],
      processedAt: 'invalid',
      audioDurationMilliseconds: -1,
      costMinorUnits: -1,
    },
  });

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.deepEqual(
    new Set(result.issues.map((issue) => issue.code)),
    new Set([
      'VOICE_OBSERVATION_IDENTITY_MISMATCH',
      'VOICE_OUTPUT_REFERENCE_REQUIRED',
      'VOICE_PROVENANCE_REQUIRED',
      'VOICE_PROVENANCE_SOURCE_REQUIRED',
      'VOICE_PROCESSED_AT_INVALID',
      'VOICE_AUDIO_DURATION_INVALID',
      'VOICE_COST_INVALID',
    ]),
  );
});
