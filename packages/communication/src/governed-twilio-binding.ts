import type {
  ConnectorDefinition,
  CredentialLease,
  CredentialLeaseRequest,
  GovernedCredentialLeaseService,
} from '@platform-hub/provider-registry';
import type {
  ConnectorCredentialRepository,
  SecretResolver,
} from '@platform-hub/provider-registry/repository';
import type {
  TwilioCredentialRequest,
  TwilioCredentialsProvider,
} from './twilio-sms-whatsapp-adapter.ts';

const TWILIO_PROVIDER_KEYS = new Set(['twilio-sms', 'twilio-whatsapp', 'twilio-voice']);
const CAPABILITY_BY_PROVIDER: Readonly<Record<string, string>> = {
  'twilio-sms': 'communication.sms.send',
  'twilio-whatsapp': 'communication.whatsapp.send',
  'twilio-voice': 'communication.voice.dial',
};

export type TwilioCredentialLeaseService = Pick<GovernedCredentialLeaseService, 'issue'>;

export interface GovernedTwilioCredentialProviderOptions {
  readonly connector: ConnectorDefinition;
  readonly credentialRepository: ConnectorCredentialRepository;
  readonly leaseService: TwilioCredentialLeaseService;
  readonly secretResolver: SecretResolver;
  readonly requestedBySubjectId: string;
  readonly requestId: () => string;
  readonly correlationId: () => string;
  readonly now?: () => string;
}

export type GovernedTwilioCredentialErrorCode =
  | 'TWILIO_CONNECTOR_INVALID'
  | 'TWILIO_CREDENTIAL_REFERENCE_UNAVAILABLE'
  | 'TWILIO_SECRET_EXPIRED'
  | 'TWILIO_SECRET_INVALID';

export class GovernedTwilioCredentialError extends Error {
  readonly code: GovernedTwilioCredentialErrorCode;

  constructor(code: GovernedTwilioCredentialErrorCode, message: string) {
    super(message);
    this.name = 'GovernedTwilioCredentialError';
    this.code = code;
  }
}

/**
 * Resolves Twilio credentials only after the routed connector has obtained an
 * authorized, audited, short-lived credential lease. The referenced secret is
 * expected to be JSON containing accountSid/authToken and, optionally,
 * messagingServiceSid. Raw values never enter connector or communication
 * domain records.
 */
export function governedTwilioCredentialsProvider(
  options: GovernedTwilioCredentialProviderOptions,
): TwilioCredentialsProvider {
  const capabilityKey = validateConnector(options.connector);
  stable(options.requestedBySubjectId, 'requested subject id');

  return async (request: TwilioCredentialRequest) => {
    const credentialReference = await options.credentialRepository.loadCredentialReference(
      request.tenantId,
      options.connector.connectorKey,
    );
    if (credentialReference === null) {
      throw new GovernedTwilioCredentialError(
        'TWILIO_CREDENTIAL_REFERENCE_UNAVAILABLE',
        'Twilio connector has no managed credential reference.',
      );
    }

    const leaseRequest: CredentialLeaseRequest = {
      requestId: stable(options.requestId(), 'credential request id'),
      tenantId: request.tenantId,
      requestedBySubjectId: options.requestedBySubjectId,
      connectorKey: options.connector.connectorKey,
      purpose: `${capabilityKey}:${request.purpose}`,
      requestedAt: request.requestedAt,
      correlationId: stable(options.correlationId(), 'credential correlation id'),
      evidenceRefs: [
        `communication://trigger/${encodeURIComponent(request.triggerKey)}`,
        `communication://idempotency/${encodeURIComponent(request.idempotencyKey)}`,
      ],
    };
    const connector = { ...options.connector, credentialRef: credentialReference };
    const lease = await options.leaseService.issue(leaseRequest, connector);
    const resolvedAt = options.now?.() ?? new Date().toISOString();
    assertLeaseIsCurrent(lease, resolvedAt);

    const secret = await options.secretResolver.resolve(lease.credentialReference);
    if (secret.expiresAt !== undefined && secret.expiresAt.getTime() <= Date.parse(resolvedAt)) {
      throw new GovernedTwilioCredentialError(
        'TWILIO_SECRET_EXPIRED',
        'Resolved Twilio credential is expired.',
      );
    }

    return parseTwilioSecret(secret.value);
  };
}

function validateConnector(connector: ConnectorDefinition): string {
  const providerKey = connector.providerKey.trim().toLowerCase();
  const capabilityKey = CAPABILITY_BY_PROVIDER[providerKey];
  const valid = connector.enabled
    && TWILIO_PROVIDER_KEYS.has(providerKey)
    && typeof capabilityKey === 'string'
    && connector.capabilityKeys.includes(capabilityKey);
  if (!valid || capabilityKey === undefined) {
    throw new GovernedTwilioCredentialError(
      'TWILIO_CONNECTOR_INVALID',
      'Connector is not an enabled Twilio communication connector with its required capability.',
    );
  }
  return capabilityKey;
}

function parseTwilioSecret(value: string): {
  accountSid: string;
  authToken: string;
  messagingServiceSid?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidSecret();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidSecret();
  }
  const record = parsed as Record<string, unknown>;
  const accountSid = typeof record.accountSid === 'string' ? record.accountSid.trim() : '';
  const authToken = typeof record.authToken === 'string' ? record.authToken.trim() : '';
  const messagingServiceSid = typeof record.messagingServiceSid === 'string'
    ? record.messagingServiceSid.trim()
    : '';
  if (accountSid.length === 0 || authToken.length === 0) {
    throw invalidSecret();
  }
  return {
    accountSid,
    authToken,
    ...(messagingServiceSid.length === 0 ? {} : { messagingServiceSid }),
  };
}

function invalidSecret(): GovernedTwilioCredentialError {
  return new GovernedTwilioCredentialError(
    'TWILIO_SECRET_INVALID',
    'Resolved Twilio credential must be JSON with accountSid and authToken.',
  );
}

function assertLeaseIsCurrent(lease: CredentialLease, requestedAt: string): void {
  const at = Date.parse(requestedAt);
  const issuedAt = Date.parse(lease.issuedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(at) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > at || expiresAt <= at) {
    throw new GovernedTwilioCredentialError(
      'TWILIO_SECRET_EXPIRED',
      'Twilio credential lease is not active for this send attempt.',
    );
  }
}

function stable(value: string, label: string): string {
  if (value.trim().length === 0 || value !== value.trim() || /[\r\n\t]/u.test(value)) {
    throw new GovernedTwilioCredentialError(
      'TWILIO_CONNECTOR_INVALID',
      `${label} is invalid.`,
    );
  }
  return value;
}
