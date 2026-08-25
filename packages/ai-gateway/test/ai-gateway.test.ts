import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateAiInvocationIntent,
  validateAiProposal,
  type AiInvocationIntent,
  type AiProposal,
} from '../src/index.ts';

const intent: AiInvocationIntent = {
  invocationId: 'invocation-1',
  tenantId: 'tenant-1',
  operation: 'EXTRACT',
  purpose: 'Extract appointment facts for review.',
  inputReference: 'object://tenant-1/inbound/document-1',
  promptConfiguration: { key: 'appointment-extraction', version: 3 },
  governance: {
    requiredResidencyTags: ['eu'],
    requiredComplianceTags: ['health-data'],
    maximumCostMinorUnits: 20,
  },
  idempotencyKey: 'extract:document-1:v3',
  requestedAt: '2026-08-25T15:00:00.000Z',
};

const proposal: AiProposal = {
  invocationId: intent.invocationId,
  tenantId: intent.tenantId,
  status: 'PROPOSAL',
  outputReference: 'object://tenant-1/ai-output/proposal-1',
  confidence: 0.91,
  provenance: {
    connectorKey: 'tenant-ai-primary',
    providerKey: 'customer-provider',
    modelKey: 'extract-model',
    promptConfigurationKey: 'appointment-extraction',
    promptConfigurationVersion: 3,
    sourceReferences: [intent.inputReference],
    processedAt: '2026-08-25T15:00:02.000Z',
    region: 'eu-west',
    costMinorUnits: 7,
  },
};

test('validates a provider-neutral AI invocation intent', () => {
  assert.deepEqual(
    validateAiInvocationIntent(intent),
    { valid: true, issues: [] },
  );
});

test('validates observation provenance against the originating intent', () => {
  assert.deepEqual(
    validateAiProposal(intent, proposal),
    { valid: true, issues: [] },
  );
});

test('rejects invalid prompt versions, timestamps, and cost limits', () => {
  const result = validateAiInvocationIntent({
    ...intent,
    promptConfiguration: { key: '', version: 0 },
    governance: {
      ...intent.governance,
      maximumCostMinorUnits: -1,
    },
    requestedAt: 'not-a-time',
  });

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.deepEqual(
    new Set(result.issues.map((issue) => issue.code)),
    new Set([
      'AI_PROMPT_KEY_REQUIRED',
      'AI_PROMPT_VERSION_INVALID',
      'AI_REQUESTED_AT_INVALID',
      'AI_COST_LIMIT_INVALID',
    ]),
  );
});

test('rejects cross-tenant or unprovenanced AI proposals', () => {
  const result = validateAiProposal(intent, {
    ...proposal,
    invocationId: 'other-invocation',
    tenantId: 'other-tenant',
    outputReference: '',
    confidence: 2,
    provenance: {
      ...proposal.provenance,
      connectorKey: '',
      promptConfigurationVersion: 2,
      sourceReferences: [],
      processedAt: 'invalid',
      costMinorUnits: -1,
    },
  });

  assert.equal(result.valid, false);
  if (result.valid) return;
  assert.deepEqual(
    new Set(result.issues.map((issue) => issue.code)),
    new Set([
      'AI_PROPOSAL_INVOCATION_MISMATCH',
      'AI_PROPOSAL_TENANT_MISMATCH',
      'AI_OUTPUT_REFERENCE_REQUIRED',
      'AI_CONFIDENCE_INVALID',
      'AI_PROVENANCE_REQUIRED',
      'AI_PROVENANCE_PROMPT_MISMATCH',
      'AI_PROVENANCE_SOURCE_REQUIRED',
      'AI_PROVENANCE_PROCESSED_AT_INVALID',
      'AI_PROVENANCE_COST_INVALID',
    ]),
  );
});
