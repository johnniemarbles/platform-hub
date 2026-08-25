import {
  communicationChannelMetadata,
  evaluateCommunicationPreflight,
  resolveCommunicationIntentIdentity,
  type CommunicationConsentRepository,
  type CommunicationIntent,
  type CommunicationPreflightDecision,
  type CommunicationSuppressionRepository,
} from './index.ts';

export interface PersistedCommunicationPreflightRepositories {
  readonly consent: CommunicationConsentRepository;
  readonly suppression: CommunicationSuppressionRepository;
}

export interface PersistedCommunicationPreflightInput {
  readonly intent: CommunicationIntent;
  readonly repositories: PersistedCommunicationPreflightRepositories;
  readonly at?: string;
}

/**
 * Resolves persisted consent and suppression state before delegating the final
 * deterministic decision to the pure communication preflight evaluator.
 * Repository errors are intentionally not swallowed: unavailable compliance
 * evidence must never be interpreted as permission to send.
 */
export async function evaluatePersistedCommunicationPreflight(
  input: PersistedCommunicationPreflightInput,
): Promise<CommunicationPreflightDecision> {
  const identity = resolveCommunicationIntentIdentity(input.intent);
  const metadata = communicationChannelMetadata(identity.channel);
  const consentRequired = input.intent.consentRequired || metadata.requiresConsent;

  const consent = consentRequired
    ? await input.repositories.consent.resolveEffective({
        tenantId: input.intent.tenantId,
        ...(input.intent.organizationId !== undefined
          ? { organizationId: input.intent.organizationId }
          : {}),
        recipientKey: identity.recipientKey,
        channel: identity.channel,
        purpose: input.intent.purpose,
        ...(input.at !== undefined ? { at: input.at } : {}),
      })
    : null;

  const suppression = metadata.supportsSuppression
    ? await input.repositories.suppression.findActive({
        tenantId: input.intent.tenantId,
        ...(input.intent.organizationId !== undefined
          ? { organizationId: input.intent.organizationId }
          : {}),
        recipientKey: identity.recipientKey,
        channel: identity.channel,
        ...(input.at !== undefined ? { at: input.at } : {}),
      })
    : null;

  return evaluateCommunicationPreflight({
    intent: input.intent,
    channel: identity.channel,
    ...(consentRequired ? { consentGranted: consent?.granted === true } : {}),
    ...(suppression !== null ? { suppression } : {}),
  });
}
