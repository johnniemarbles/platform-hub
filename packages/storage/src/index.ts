export type ObjectStorageOperation = 'STORE' | 'READ' | 'DELETE';

export interface VersionedStoragePolicyReference {
  readonly key: string;
  readonly version: number;
}

export interface ObjectStorageIntent {
  readonly requestId: string;
  readonly tenantId: string;
  readonly requestedBySubjectId: string;
  readonly operation: ObjectStorageOperation;
  readonly purpose: string;
  readonly objectReference: string;
  readonly sourceReference: string | null;
  readonly expectedSha256: string | null;
  readonly contentType: string | null;
  readonly retentionPolicy: VersionedStoragePolicyReference;
  readonly requiredResidencyTags: readonly string[];
  readonly requiredComplianceTags: readonly string[];
  readonly deletionAuthorizationDecisionId: string | null;
  readonly idempotencyKey: string;
  readonly requestedAt: string;
  readonly correlationId: string;
  readonly evidenceRefs: readonly string[];
}

export interface ObjectStorageObservation {
  readonly requestId: string;
  readonly tenantId: string;
  readonly operation: ObjectStorageOperation;
  readonly objectReference: string;
  readonly status: 'STORED' | 'AVAILABLE' | 'DELETED';
  readonly contentReference: string | null;
  readonly sha256: string | null;
  readonly connectorKey: string;
  readonly providerKey: string;
  readonly region: string;
  readonly completedAt: string;
  readonly sourceReferences: readonly string[];
}

export interface DurableArtifactWriteInput {
  readonly tenantId: string;
  readonly artifactKind:
    | 'AI_TEXT'
    | 'AI_EMBEDDING'
    | 'VOICE_TRANSCRIPT'
    | 'VOICE_AUDIO';
  readonly sourceKind: 'AI_INVOCATION' | 'VOICE_REQUEST';
  readonly sourceId: string;
  readonly content: string | Uint8Array;
  readonly contentType: string;
  readonly providerKey: string;
  readonly connectorKey: string;
  readonly modelKey?: string;
  readonly capabilityKey: string;
  readonly costMinorUnits: number;
  readonly providerCostOwnership: 'BYOK' | 'EXPADIO_MANAGED';
  readonly confidence?: number;
  readonly correlationId?: string;
  readonly requiredResidencyTags: readonly string[];
  readonly requiredComplianceTags: readonly string[];
}

export interface DurableArtifactWriteResult {
  readonly contentReference: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface DurableArtifactSink {
  write(
    input: DurableArtifactWriteInput,
  ): Promise<DurableArtifactWriteResult>;
}

export interface DurableArtifactReadContext {
  readonly tenantId: string;
  readonly reference: string;
  readonly purpose: string;
  readonly requiredResidencyTags: readonly string[];
  readonly requiredComplianceTags: readonly string[];
}

export interface DurableArtifactTextReadResult {
  readonly content: string;
  readonly contentReference: string;
}

export interface DurableArtifactProviderFetchResult {
  readonly providerFetchUrl: string;
  readonly contentReference: string;
  readonly expiresAt: string;
}

export interface DurableArtifactSource {
  readText(
    input: DurableArtifactReadContext,
  ): Promise<DurableArtifactTextReadResult>;

  issueProviderFetchUrl(
    input: DurableArtifactReadContext,
  ): Promise<DurableArtifactProviderFetchResult>;
}

export interface ObjectStorageGateway {
  execute(
    intent: ObjectStorageIntent,
  ): Promise<ObjectStorageObservation>;
}

export type ObjectStorageValidationCode =
  | 'STORAGE_REQUEST_INVALID'
  | 'STORAGE_POLICY_INVALID'
  | 'STORAGE_SOURCE_REQUIRED'
  | 'STORAGE_DIGEST_REQUIRED'
  | 'STORAGE_DELETE_AUTHORIZATION_REQUIRED'
  | 'STORAGE_OBSERVATION_IDENTITY_MISMATCH'
  | 'STORAGE_OBSERVATION_STATUS_MISMATCH'
  | 'STORAGE_OBSERVATION_INVALID';

export interface ObjectStorageValidationIssue {
  readonly code: ObjectStorageValidationCode;
  readonly path: string;
}

export type ObjectStorageValidationResult =
  | { readonly valid: true; readonly issues: readonly [] }
  | {
      readonly valid: false;
      readonly issues: readonly ObjectStorageValidationIssue[];
    };

export function validateObjectStorageIntent(
  intent: ObjectStorageIntent,
): ObjectStorageValidationResult {
  const issues: ObjectStorageValidationIssue[] = [];
  for (const [path, value] of [
    ['requestId', intent.requestId],
    ['tenantId', intent.tenantId],
    ['requestedBySubjectId', intent.requestedBySubjectId],
    ['purpose', intent.purpose],
    ['objectReference', intent.objectReference],
    ['idempotencyKey', intent.idempotencyKey],
    ['correlationId', intent.correlationId],
  ] as const) {
    if (!nonBlank(value)) {
      issues.push({ code: 'STORAGE_REQUEST_INVALID', path });
    }
  }
  if (!validPolicy(intent.retentionPolicy)) {
    issues.push({
      code: 'STORAGE_POLICY_INVALID',
      path: 'retentionPolicy',
    });
  }
  if (
    !validInstant(intent.requestedAt)
    || intent.requiredResidencyTags.length === 0
    || intent.requiredResidencyTags.some((tag) => !nonBlank(tag))
    || intent.requiredComplianceTags.some((tag) => !nonBlank(tag))
    || intent.evidenceRefs.length === 0
    || intent.evidenceRefs.some((reference) => !nonBlank(reference))
  ) {
    issues.push({
      code: 'STORAGE_REQUEST_INVALID',
      path: 'governance',
    });
  }

  if (
    intent.operation === 'STORE'
    && (
      intent.sourceReference === null
      || !nonBlank(intent.sourceReference)
    )
  ) {
    issues.push({
      code: 'STORAGE_SOURCE_REQUIRED',
      path: 'sourceReference',
    });
  }
  if (
    intent.operation === 'STORE'
    && (
      intent.expectedSha256 === null
      || !validDigest(intent.expectedSha256)
    )
  ) {
    issues.push({
      code: 'STORAGE_DIGEST_REQUIRED',
      path: 'expectedSha256',
    });
  }
  if (
    intent.operation === 'DELETE'
    && (
      intent.deletionAuthorizationDecisionId === null
      || !nonBlank(intent.deletionAuthorizationDecisionId)
    )
  ) {
    issues.push({
      code: 'STORAGE_DELETE_AUTHORIZATION_REQUIRED',
      path: 'deletionAuthorizationDecisionId',
    });
  }

  return result(issues);
}

export function validateObjectStorageObservation(
  intent: ObjectStorageIntent,
  observation: ObjectStorageObservation,
): ObjectStorageValidationResult {
  const issues: ObjectStorageValidationIssue[] = [];
  if (
    observation.requestId !== intent.requestId
    || observation.tenantId !== intent.tenantId
    || observation.operation !== intent.operation
    || observation.objectReference !== intent.objectReference
  ) {
    issues.push({
      code: 'STORAGE_OBSERVATION_IDENTITY_MISMATCH',
      path: 'observation',
    });
  }

  const expectedStatus = {
    STORE: 'STORED',
    READ: 'AVAILABLE',
    DELETE: 'DELETED',
  }[intent.operation];
  if (observation.status !== expectedStatus) {
    issues.push({
      code: 'STORAGE_OBSERVATION_STATUS_MISMATCH',
      path: 'status',
    });
  }

  const contentRequired = intent.operation !== 'DELETE';
  if (
    !nonBlank(observation.connectorKey)
    || !nonBlank(observation.providerKey)
    || !nonBlank(observation.region)
    || !validInstant(observation.completedAt)
    || observation.sourceReferences.length === 0
    || observation.sourceReferences.some(
      (reference) => !nonBlank(reference),
    )
    || (
      contentRequired
      && (
        observation.contentReference === null
        || !nonBlank(observation.contentReference)
        || observation.sha256 === null
        || !validDigest(observation.sha256)
      )
    )
    || (
      !contentRequired
      && (
        observation.contentReference !== null
        || observation.sha256 !== null
      )
    )
  ) {
    issues.push({
      code: 'STORAGE_OBSERVATION_INVALID',
      path: 'provenance',
    });
  }
  if (
    intent.operation === 'STORE'
    && observation.sha256 !== intent.expectedSha256
  ) {
    issues.push({
      code: 'STORAGE_OBSERVATION_INVALID',
      path: 'sha256',
    });
  }
  return result(issues);
}

function validPolicy(
  reference: VersionedStoragePolicyReference,
): boolean {
  return nonBlank(reference.key)
    && Number.isInteger(reference.version)
    && reference.version > 0;
}

function validDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function nonBlank(value: string): boolean {
  return value.trim() !== '';
}

function validInstant(value: string): boolean {
  return nonBlank(value) && Number.isFinite(Date.parse(value));
}

function result(
  issues: ObjectStorageValidationIssue[],
): ObjectStorageValidationResult {
  return issues.length === 0
    ? { valid: true, issues: [] }
    : { valid: false, issues };
}

export * from './routing.ts';
export * from './repository.ts';
export * from './auditing.ts';

export * from './supabase-artifact-store.ts';

export * from './content-assets.ts';

export * from './supabase-content-asset-store.ts';
