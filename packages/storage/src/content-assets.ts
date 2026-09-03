export const CONTENT_ASSET_STATES = [
  'PENDING_UPLOAD',
  'UPLOADED',
  'QUARANTINED',
  'AVAILABLE',
  'REJECTED',
  'DELETED',
] as const;
export type ContentAssetState = (typeof CONTENT_ASSET_STATES)[number];

export const CONTENT_ASSET_PURPOSES = [
  'LEARNING_CONTENT',
  'LEARNING_SUBMISSION',
  'COMMUNICATION_ATTACHMENT',
  'KNOWLEDGE_SOURCE',
  'DOMAIN_DOCUMENT',
] as const;
export type ContentAssetPurpose = (typeof CONTENT_ASSET_PURPOSES)[number];

export interface ContentAssetRegistrationInput {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly requestedBySubjectId: string;
  readonly purpose: ContentAssetPurpose;
  readonly filename: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly idempotencyKey: string;
  readonly retentionPolicy: {
    readonly key: string;
    readonly version: number;
  };
  readonly requiredResidencyTags: readonly string[];
  readonly requiredComplianceTags: readonly string[];
  readonly correlationId: string;
}

export interface ValidatedContentAssetRegistration extends ContentAssetRegistrationInput {
  readonly filename: string;
  readonly contentType: string;
  readonly sha256: string;
}

export class ContentAssetValidationError extends Error {
  readonly field: string;
  readonly code: string;

  constructor(field: string, code: string, message: string) {
    super(message);
    this.name = 'ContentAssetValidationError';
    this.field = field;
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const POLICY_KEY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MAX_ASSET_BYTES = 5 * 1024 * 1024 * 1024;

function fail(field: string, code: string, message: string): never {
  throw new ContentAssetValidationError(field, code, message);
}

function required(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') fail(field, 'REQUIRED', `${field} is required.`);
  const normalized = (value as string).trim();
  if (normalized.length > max) fail(field, 'TOO_LONG', `${field} exceeds ${max} characters.`);
  return normalized;
}

function uuid(value: unknown, field: string): string {
  const normalized = required(value, field, 64);
  if (!UUID.test(normalized)) fail(field, 'INVALID_UUID', `${field} must be a UUID.`);
  return normalized;
}

function tags(value: unknown, field: string, requiredList: boolean): readonly string[] {
  if (!Array.isArray(value)) fail(field, 'INVALID_LIST', `${field} must be an array.`);
  if (requiredList && value.length === 0) fail(field, 'REQUIRED', `${field} must not be empty.`);
  const normalized = value.map((tag, index) => required(tag, `${field}[${index}]`, 120).toLowerCase());
  if (new Set(normalized).size !== normalized.length) fail(field, 'DUPLICATE_TAG', `${field} must be unique.`);
  return normalized;
}

export function validateContentAssetRegistration(value: unknown): ValidatedContentAssetRegistration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('asset', 'INVALID_OBJECT', 'Content asset registration must be an object.');
  }
  const input = value as Record<string, unknown>;
  const purpose = required(input.purpose, 'purpose', 80);
  if (!(CONTENT_ASSET_PURPOSES as readonly string[]).includes(purpose)) {
    fail('purpose', 'INVALID_PURPOSE', 'Unknown content asset purpose.');
  }
  const filename = required(input.filename, 'filename', 500);
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) {
    fail('filename', 'UNSAFE_FILENAME', 'filename must not contain a path.');
  }
  const contentType = required(input.contentType, 'contentType', 255).toLowerCase();
  if (!MIME.test(contentType)) fail('contentType', 'INVALID_CONTENT_TYPE', 'contentType must be a MIME type.');
  if (!Number.isSafeInteger(input.byteLength) || Number(input.byteLength) < 1 || Number(input.byteLength) > MAX_ASSET_BYTES) {
    fail('byteLength', 'INVALID_BYTE_LENGTH', 'byteLength is outside the supported range.');
  }
  const sha256 = required(input.sha256, 'sha256', 64).toLowerCase();
  if (!SHA256.test(sha256)) fail('sha256', 'INVALID_SHA256', 'sha256 must be a complete digest.');

  const retention = input.retentionPolicy;
  if (retention === null || typeof retention !== 'object' || Array.isArray(retention)) {
    fail('retentionPolicy', 'INVALID_POLICY', 'retentionPolicy must be an object.');
  }
  const policy = retention as Record<string, unknown>;
  const key = required(policy.key, 'retentionPolicy.key', 120).toLowerCase();
  if (!POLICY_KEY.test(key)) fail('retentionPolicy.key', 'INVALID_POLICY', 'Invalid retention policy key.');
  if (!Number.isInteger(policy.version) || Number(policy.version) < 1) {
    fail('retentionPolicy.version', 'INVALID_POLICY', 'Retention policy version must be positive.');
  }

  return {
    tenantId: uuid(input.tenantId, 'tenantId'),
    organizationId: uuid(input.organizationId, 'organizationId'),
    requestedBySubjectId: required(input.requestedBySubjectId, 'requestedBySubjectId', 255),
    purpose: purpose as ContentAssetPurpose,
    filename,
    contentType,
    byteLength: Number(input.byteLength),
    sha256,
    idempotencyKey: required(input.idempotencyKey, 'idempotencyKey', 255),
    retentionPolicy: { key, version: Number(policy.version) },
    requiredResidencyTags: tags(input.requiredResidencyTags, 'requiredResidencyTags', true),
    requiredComplianceTags: tags(input.requiredComplianceTags ?? [], 'requiredComplianceTags', false),
    correlationId: required(input.correlationId, 'correlationId', 255),
  };
}

const TRANSITIONS: Readonly<Record<ContentAssetState, readonly ContentAssetState[]>> = {
  PENDING_UPLOAD: ['UPLOADED', 'REJECTED', 'DELETED'],
  UPLOADED: ['QUARANTINED', 'AVAILABLE', 'REJECTED', 'DELETED'],
  QUARANTINED: ['AVAILABLE', 'REJECTED', 'DELETED'],
  AVAILABLE: ['QUARANTINED', 'DELETED'],
  REJECTED: ['DELETED'],
  DELETED: [],
};

export function canTransitionContentAsset(from: ContentAssetState, to: ContentAssetState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertContentAssetTransition(from: ContentAssetState, to: ContentAssetState): void {
  if (!canTransitionContentAsset(from, to)) {
    fail('state', 'INVALID_STATE_TRANSITION', `Content asset cannot transition from ${from} to ${to}.`);
  }
}

export function contentAssetObjectReference(input: {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly assetId: string;
}): string {
  return `content-assets/${uuid(input.tenantId, 'tenantId')}/${uuid(input.organizationId, 'organizationId')}/${uuid(input.assetId, 'assetId')}`;
}
