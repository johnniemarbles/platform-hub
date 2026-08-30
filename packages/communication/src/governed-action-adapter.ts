import type { GovernedActionIntent } from '@expadio/governed-actions';
import type {
  ConnectorDefinition,
  RoutingPolicy,
} from '@platform-hub/provider-registry';
import {
  resolveCommunicationIntentIdentity,
  type CommunicationChannel,
  type CommunicationIntent,
  type CommunicationPurpose,
  type CommunicationRecipient,
} from './index.ts';
import type {
  CommunicationDeliveryRecord,
  CommunicationDeliveryRepository,
} from './delivery-repository.ts';
import type { PreparedCommunicationDispatch } from './dispatch.ts';
import {
  routePreparedCommunicationDispatch,
  type RoutedCommunicationConnector,
} from './dispatch-routing.ts';
import {
  evaluatePersistedCommunicationPreflight,
  type PersistedCommunicationPreflightRepositories,
} from './persisted-preflight.ts';
import type { CommunicationTemplateRepository } from './template.ts';
import { resolveAndRenderCommunicationTemplate } from './template-resolve-render.ts';

export interface GovernedCommunicateConfiguration {
  readonly triggerKey: string;
  readonly recipient: CommunicationRecipient;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly purpose: CommunicationPurpose;
  readonly consentRequired: boolean;
  readonly channel?: CommunicationChannel;
  readonly locale?: string;
  readonly organizationId?: string;
  readonly capabilityKey: string;
  readonly requiredRegions?: readonly string[];
  readonly requiredResidencyTags?: readonly string[];
  readonly requiredComplianceTags?: readonly string[];
}

export interface GovernedCommunicateQueuePorts {
  readonly compliance: PersistedCommunicationPreflightRepositories;
  readonly templates: CommunicationTemplateRepository;
  readonly delivery: CommunicationDeliveryRepository;
  readonly connectors: readonly ConnectorDefinition[];
  readonly routingPolicy?: RoutingPolicy;
  readonly adapterKeyFor?: (input: {
    readonly providerKey: string;
    readonly channel: CommunicationChannel;
  }) => string | null;
  /** Execution-time clock for consent/suppression evaluation and queue evidence. */
  readonly now?: () => string;
}

export type GovernedCommunicateQueueResult =
  | {
      readonly queued: false;
      readonly reasonCode:
        | 'WRONG_EXECUTOR_CLASS'
        | 'CONFIGURATION_INVALID'
        | 'INVALID_RECIPIENT'
        | 'CONSENT_MISSING'
        | 'SUPPRESSED'
        | 'TEMPLATE_MISSING'
        | 'MISSING_VARIABLES'
        | 'NOT_CONFIGURED'
        | 'PROVIDER_UNAVAILABLE'
        | 'RESIDENCY_BLOCKED'
        | 'GOVERNANCE_BLOCKED'
        | 'ADAPTER_UNAVAILABLE';
      readonly reason: string;
    }
  | {
      readonly queued: true;
      readonly communicationIntent: CommunicationIntent;
      readonly preparedDispatch: PreparedCommunicationDispatch;
      readonly connector: RoutedCommunicationConnector;
      readonly delivery: CommunicationDeliveryRecord;
    };

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`GOVERNED_COMMUNICATE_CONFIGURATION_REQUIRED:${field}`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized === '' ? undefined : normalized;
}

function stringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new Error(`GOVERNED_COMMUNICATE_CONFIGURATION_ARRAY_INVALID:${field}`);
  }
  return value.map((item) => item.trim());
}

function parseRecipient(value: unknown): CommunicationRecipient {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('GOVERNED_COMMUNICATE_RECIPIENT_INVALID');
  }
  const raw = value as Record<string, unknown>;
  const recipient: CommunicationRecipient = {};
  for (const key of ['subjectId', 'email', 'phone', 'whatsapp', 'pushEndpoint'] as const) {
    const normalized = optionalText(raw[key]);
    if (normalized !== undefined) {
      Object.assign(recipient, { [key]: normalized });
    }
  }
  if (Object.keys(recipient).length === 0) {
    throw new Error('GOVERNED_COMMUNICATE_RECIPIENT_EMPTY');
  }
  return recipient;
}

function parsePurpose(value: unknown): CommunicationPurpose {
  const purpose = requiredText(value, 'purpose');
  if (purpose !== 'transactional' && purpose !== 'marketing' && purpose !== 'system') {
    throw new Error('GOVERNED_COMMUNICATE_PURPOSE_INVALID');
  }
  return purpose;
}

function parseChannel(value: unknown): CommunicationChannel | undefined {
  const channel = optionalText(value);
  if (channel === undefined) return undefined;
  if (
    channel !== 'email'
    && channel !== 'sms'
    && channel !== 'whatsapp'
    && channel !== 'voice'
    && channel !== 'in_app'
    && channel !== 'push'
    && channel !== 'rcs'
  ) {
    throw new Error('GOVERNED_COMMUNICATE_CHANNEL_INVALID');
  }
  return channel;
}

export function parseGovernedCommunicateConfiguration(
  configuration: Readonly<Record<string, unknown>>,
): GovernedCommunicateConfiguration {
  const raw = configuration as Record<string, unknown>;
  const variables = raw.variables ?? {};
  if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) {
    throw new Error('GOVERNED_COMMUNICATE_VARIABLES_INVALID');
  }
  if (typeof raw.consentRequired !== 'boolean') {
    throw new Error('GOVERNED_COMMUNICATE_CONSENT_REQUIRED_INVALID');
  }

  const channel = parseChannel(raw.channel);
  const locale = optionalText(raw.locale);
  const organizationId = optionalText(raw.organizationId);
  const requiredRegions = stringArray(raw.requiredRegions, 'requiredRegions');
  const requiredResidencyTags = stringArray(
    raw.requiredResidencyTags,
    'requiredResidencyTags',
  );
  const requiredComplianceTags = stringArray(
    raw.requiredComplianceTags,
    'requiredComplianceTags',
  );

  return {
    triggerKey: requiredText(raw.triggerKey, 'triggerKey'),
    recipient: parseRecipient(raw.recipient),
    variables: variables as Readonly<Record<string, unknown>>,
    purpose: parsePurpose(raw.purpose),
    consentRequired: raw.consentRequired,
    ...(channel === undefined ? {} : { channel }),
    ...(locale === undefined ? {} : { locale }),
    ...(organizationId === undefined ? {} : { organizationId }),
    capabilityKey: requiredText(raw.capabilityKey, 'capabilityKey'),
    ...(requiredRegions === undefined ? {} : { requiredRegions }),
    ...(requiredResidencyTags === undefined ? {} : { requiredResidencyTags }),
    ...(requiredComplianceTags === undefined ? {} : { requiredComplianceTags }),
  };
}

export function defaultCommunicationAdapterKey(input: {
  readonly providerKey: string;
  readonly channel: CommunicationChannel;
}): string | null {
  const providerKey = input.providerKey.trim().toLowerCase();
  if (providerKey === 'resend' && input.channel === 'email') {
    return 'resend-email-v1';
  }
  if (
    providerKey === 'twilio'
    && (input.channel === 'sms' || input.channel === 'whatsapp')
  ) {
    return 'twilio-sms-whatsapp-v1';
  }
  if (providerKey === 'twilio' && input.channel === 'voice') {
    return 'twilio-voice-v1';
  }
  return null;
}

/**
 * Convert one immutable COMMUNICATE Action Intent into the existing durable
 * Communications queue.
 *
 * This function does not invoke a provider. It reuses persisted consent /
 * suppression, active template resolution, Provider Registry routing, and
 * communication-delivery idempotency before producing a PENDING delivery.
 */
export async function queueGovernedCommunicateAction(
  actionIntent: GovernedActionIntent,
  ports: GovernedCommunicateQueuePorts,
): Promise<GovernedCommunicateQueueResult> {
  if (actionIntent.executorClass !== 'COMMUNICATE') {
    return {
      queued: false,
      reasonCode: 'WRONG_EXECUTOR_CLASS',
      reason: 'This adapter only accepts COMMUNICATE Action Intents.',
    };
  }

  let config: GovernedCommunicateConfiguration;
  try {
    config = parseGovernedCommunicateConfiguration(actionIntent.configuration);
  } catch (error) {
    return {
      queued: false,
      reasonCode: 'CONFIGURATION_INVALID',
      reason: error instanceof Error ? error.message : 'Communication configuration is invalid.',
    };
  }

  const communicationIntent: CommunicationIntent = {
    triggerKey: config.triggerKey,
    tenantId: actionIntent.tenantId,
    ...(config.organizationId === undefined
      ? {}
      : { organizationId: config.organizationId }),
    recipient: config.recipient,
    variables: config.variables,
    ...(config.locale === undefined ? {} : { locale: config.locale }),
    idempotencyKey: actionIntent.idempotencyKey,
    purpose: config.purpose,
    consentRequired: config.consentRequired,
    ...(config.channel === undefined ? {} : { channel: config.channel }),
  };

  let identity;
  try {
    identity = resolveCommunicationIntentIdentity(communicationIntent);
  } catch (error) {
    return {
      queued: false,
      reasonCode: 'INVALID_RECIPIENT',
      reason: error instanceof Error ? error.message : 'Recipient is not addressable.',
    };
  }

  const evaluatedAt = ports.now?.() ?? new Date().toISOString();
  const preflight = await evaluatePersistedCommunicationPreflight({
    intent: communicationIntent,
    repositories: ports.compliance,
    at: evaluatedAt,
  });
  if (!preflight.allowed) {
    return {
      queued: false,
      reasonCode: preflight.reasonCode === 'OK'
        ? 'INVALID_RECIPIENT'
        : preflight.reasonCode,
      reason: preflight.reason,
    };
  }

  const rendered = await resolveAndRenderCommunicationTemplate(
    ports.templates,
    {
      tenantId: actionIntent.tenantId,
      ...(config.organizationId === undefined
        ? {}
        : { organizationId: config.organizationId }),
      triggerKey: config.triggerKey,
      channel: identity.channel,
      ...(config.locale === undefined ? {} : { locale: config.locale }),
      variables: config.variables,
    },
  );
  if (!rendered.ok) {
    return {
      queued: false,
      reasonCode: rendered.reasonCode,
      reason: rendered.reasonCode === 'TEMPLATE_MISSING'
        ? 'No active communication template matched this Action Intent.'
        : `Template variables are missing: ${rendered.missingVariables.join(', ')}`,
    };
  }

  const preparedDispatch: PreparedCommunicationDispatch = {
    tenantId: actionIntent.tenantId,
    ...(config.organizationId === undefined
      ? {}
      : { organizationId: config.organizationId }),
    triggerKey: config.triggerKey,
    purpose: config.purpose,
    channel: identity.channel,
    recipient: config.recipient,
    recipientKey: identity.recipientKey,
    idempotencyKey: actionIntent.idempotencyKey,
    templateScope: rendered.matchedScope,
    rendered: rendered.rendered,
    compliance: {
      preflight: {
        allowed: true,
        reasonCode: 'OK',
        reason: preflight.reason,
      },
      evaluatedAt,
    },
    routing: {
      capabilityKey: config.capabilityKey,
      ...(config.requiredRegions === undefined
        ? {}
        : { requiredRegions: config.requiredRegions }),
      ...(config.requiredResidencyTags === undefined
        ? {}
        : { requiredResidencyTags: config.requiredResidencyTags }),
      ...(config.requiredComplianceTags === undefined
        ? {}
        : { requiredComplianceTags: config.requiredComplianceTags }),
    },
    requestedAt: actionIntent.requestedAt.toISOString(),
  };

  const routed = routePreparedCommunicationDispatch(
    preparedDispatch,
    ports.connectors,
    ports.routingPolicy,
  );
  if (!routed.routed) {
    return {
      queued: false,
      reasonCode: routed.reasonCode,
      reason: `No eligible communication connector: ${routed.routeReason}.`,
    };
  }

  const adapterKey = (ports.adapterKeyFor ?? defaultCommunicationAdapterKey)({
    providerKey: routed.connector.providerKey,
    channel: identity.channel,
  });
  if (adapterKey === null) {
    return {
      queued: false,
      reasonCode: 'ADAPTER_UNAVAILABLE',
      reason: `No communication adapter is registered for ${routed.connector.providerKey}/${identity.channel}.`,
    };
  }

  const delivery = await ports.delivery.createOrGet({
    tenantId: actionIntent.tenantId,
    ...(config.organizationId === undefined
      ? {}
      : { organizationId: config.organizationId }),
    idempotencyKey: actionIntent.idempotencyKey,
    channel: identity.channel,
    connectorKey: routed.connector.connectorKey,
    adapterKey,
    requestedAt: evaluatedAt,
  });

  return {
    queued: true,
    communicationIntent,
    preparedDispatch,
    connector: routed.connector,
    delivery,
  };
}
