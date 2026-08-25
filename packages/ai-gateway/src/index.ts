export type AiOperation =
  | 'GENERATE'
  | 'CLASSIFY'
  | 'SUMMARIZE'
  | 'EXTRACT'
  | 'EMBED'
  | 'RERANK'
  | 'VISION_ANALYZE'
  | 'TRANSLATE';

export interface AiInvocationIntent {
  readonly invocationId: string;
  readonly tenantId: string;
  readonly operation: AiOperation;
  readonly purpose: string;
  readonly inputReference: string;
  readonly contextReference?: string;
  readonly promptConfiguration: {
    readonly key: string;
    readonly version: number;
  };
  readonly governance: {
    readonly requiredResidencyTags: readonly string[];
    readonly requiredComplianceTags: readonly string[];
    readonly maximumCostMinorUnits?: number;
  };
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}

export interface AiGateway {
  /**
   * Returns an observation or proposal. The gateway has no domain-mutation
   * method; callers must validate and submit a separate authorized command.
   */
  invoke(intent: AiInvocationIntent): Promise<AiProposal>;
}

export interface AiProposal {
  readonly invocationId: string;
  readonly tenantId: string;
  readonly status: 'OBSERVATION' | 'PROPOSAL';
  readonly outputReference: string;
  readonly confidence?: number;
  readonly provenance: AiProvenance;
}

export interface AiProvenance {
  readonly connectorKey: string;
  readonly providerKey: string;
  readonly modelKey: string;
  readonly promptConfigurationKey: string;
  readonly promptConfigurationVersion: number;
  readonly sourceReferences: readonly string[];
  readonly processedAt: string;
  readonly region?: string;
  readonly costMinorUnits?: number;
}

export type AiContractValidationCode =
  | 'AI_INVOCATION_ID_REQUIRED'
  | 'AI_TENANT_REQUIRED'
  | 'AI_PURPOSE_REQUIRED'
  | 'AI_INPUT_REFERENCE_REQUIRED'
  | 'AI_PROMPT_KEY_REQUIRED'
  | 'AI_PROMPT_VERSION_INVALID'
  | 'AI_IDEMPOTENCY_KEY_REQUIRED'
  | 'AI_REQUESTED_AT_INVALID'
  | 'AI_COST_LIMIT_INVALID'
  | 'AI_PROPOSAL_INVOCATION_MISMATCH'
  | 'AI_PROPOSAL_TENANT_MISMATCH'
  | 'AI_OUTPUT_REFERENCE_REQUIRED'
  | 'AI_CONFIDENCE_INVALID'
  | 'AI_PROVENANCE_REQUIRED'
  | 'AI_PROVENANCE_PROMPT_MISMATCH'
  | 'AI_PROVENANCE_SOURCE_REQUIRED'
  | 'AI_PROVENANCE_PROCESSED_AT_INVALID'
  | 'AI_PROVENANCE_COST_INVALID';

export interface AiContractValidationIssue {
  readonly code: AiContractValidationCode;
  readonly path: string;
}

export type AiContractValidationResult =
  | { readonly valid: true; readonly issues: readonly [] }
  | {
      readonly valid: false;
      readonly issues: readonly AiContractValidationIssue[];
    };

export function validateAiInvocationIntent(
  intent: AiInvocationIntent,
): AiContractValidationResult {
  const issues: AiContractValidationIssue[] = [];
  required(intent.invocationId, 'AI_INVOCATION_ID_REQUIRED', 'invocationId', issues);
  required(intent.tenantId, 'AI_TENANT_REQUIRED', 'tenantId', issues);
  required(intent.purpose, 'AI_PURPOSE_REQUIRED', 'purpose', issues);
  required(
    intent.inputReference,
    'AI_INPUT_REFERENCE_REQUIRED',
    'inputReference',
    issues,
  );
  required(
    intent.promptConfiguration.key,
    'AI_PROMPT_KEY_REQUIRED',
    'promptConfiguration.key',
    issues,
  );
  if (
    !Number.isInteger(intent.promptConfiguration.version)
    || intent.promptConfiguration.version <= 0
  ) {
    issues.push({
      code: 'AI_PROMPT_VERSION_INVALID',
      path: 'promptConfiguration.version',
    });
  }
  required(
    intent.idempotencyKey,
    'AI_IDEMPOTENCY_KEY_REQUIRED',
    'idempotencyKey',
    issues,
  );
  if (!validInstant(intent.requestedAt)) {
    issues.push({ code: 'AI_REQUESTED_AT_INVALID', path: 'requestedAt' });
  }
  if (
    intent.governance.maximumCostMinorUnits !== undefined
    && (
      !Number.isInteger(intent.governance.maximumCostMinorUnits)
      || intent.governance.maximumCostMinorUnits < 0
    )
  ) {
    issues.push({
      code: 'AI_COST_LIMIT_INVALID',
      path: 'governance.maximumCostMinorUnits',
    });
  }
  return result(issues);
}

export function validateAiProposal(
  intent: AiInvocationIntent,
  proposal: AiProposal,
): AiContractValidationResult {
  const issues: AiContractValidationIssue[] = [];
  if (proposal.invocationId !== intent.invocationId) {
    issues.push({
      code: 'AI_PROPOSAL_INVOCATION_MISMATCH',
      path: 'invocationId',
    });
  }
  if (proposal.tenantId !== intent.tenantId) {
    issues.push({ code: 'AI_PROPOSAL_TENANT_MISMATCH', path: 'tenantId' });
  }
  required(
    proposal.outputReference,
    'AI_OUTPUT_REFERENCE_REQUIRED',
    'outputReference',
    issues,
  );
  if (
    proposal.confidence !== undefined
    && (
      !Number.isFinite(proposal.confidence)
      || proposal.confidence < 0
      || proposal.confidence > 1
    )
  ) {
    issues.push({ code: 'AI_CONFIDENCE_INVALID', path: 'confidence' });
  }

  for (const [path, value] of [
    ['provenance.connectorKey', proposal.provenance.connectorKey],
    ['provenance.providerKey', proposal.provenance.providerKey],
    ['provenance.modelKey', proposal.provenance.modelKey],
  ] as const) {
    required(value, 'AI_PROVENANCE_REQUIRED', path, issues);
  }
  if (
    proposal.provenance.promptConfigurationKey
      !== intent.promptConfiguration.key
    || proposal.provenance.promptConfigurationVersion
      !== intent.promptConfiguration.version
  ) {
    issues.push({
      code: 'AI_PROVENANCE_PROMPT_MISMATCH',
      path: 'provenance.promptConfiguration',
    });
  }
  if (proposal.provenance.sourceReferences.length === 0) {
    issues.push({
      code: 'AI_PROVENANCE_SOURCE_REQUIRED',
      path: 'provenance.sourceReferences',
    });
  }
  if (!validInstant(proposal.provenance.processedAt)) {
    issues.push({
      code: 'AI_PROVENANCE_PROCESSED_AT_INVALID',
      path: 'provenance.processedAt',
    });
  }
  if (
    proposal.provenance.costMinorUnits !== undefined
    && (
      !Number.isInteger(proposal.provenance.costMinorUnits)
      || proposal.provenance.costMinorUnits < 0
    )
  ) {
    issues.push({
      code: 'AI_PROVENANCE_COST_INVALID',
      path: 'provenance.costMinorUnits',
    });
  }
  return result(issues);
}

function required(
  value: string,
  code: AiContractValidationCode,
  path: string,
  issues: AiContractValidationIssue[],
): void {
  if (value.trim() === '') issues.push({ code, path });
}

function validInstant(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function result(
  issues: AiContractValidationIssue[],
): AiContractValidationResult {
  return issues.length === 0
    ? { valid: true, issues: [] }
    : { valid: false, issues };
}

export * from './routing.ts';

export * from './jobs.ts';

export * from './job-repository.ts';
