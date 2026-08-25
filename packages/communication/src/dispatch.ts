import type {
  CommunicationChannel,
  CommunicationDispatchResult,
  CommunicationPreflightDecision,
  CommunicationPurpose,
  CommunicationRecipient,
} from './index.ts';
import type { CommunicationTemplateMatchedScope } from './template.ts';
import type { RenderedCommunicationTemplate } from './template-renderer.ts';

export type AllowedCommunicationPreflightDecision = CommunicationPreflightDecision & {
  readonly allowed: true;
  readonly reasonCode: 'OK';
};

export interface CommunicationDispatchComplianceEvidence {
  readonly preflight: AllowedCommunicationPreflightDecision;
  readonly evaluatedAt: string;
}

export interface CommunicationDispatchRoutingRequirements {
  readonly capabilityKey: string;
  readonly requiredRegions?: readonly string[];
  readonly requiredResidencyTags?: readonly string[];
  readonly requiredComplianceTags?: readonly string[];
}

/**
 * Provider-neutral handoff produced only after recipient identity, persisted
 * consent/suppression preflight, active template resolution and rendering have
 * succeeded. Provider/connector keys and credentials are intentionally absent.
 */
export interface PreparedCommunicationDispatch {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly triggerKey: string;
  readonly purpose: CommunicationPurpose;
  readonly channel: CommunicationChannel;
  readonly recipient: CommunicationRecipient;
  readonly recipientKey: string;
  readonly idempotencyKey: string;
  readonly templateScope: Exclude<CommunicationTemplateMatchedScope, 'NONE'>;
  readonly rendered: RenderedCommunicationTemplate;
  readonly compliance: CommunicationDispatchComplianceEvidence;
  readonly routing: CommunicationDispatchRoutingRequirements;
  readonly requestedAt: string;
}

/**
 * Port implemented by the dispatch/routing runtime. A caller supplies a fully
 * prepared provider-neutral envelope; implementations may route to platform or
 * tenant-owned connectors without exposing credentials to this package.
 */
export interface CommunicationDispatchPort {
  dispatch(input: PreparedCommunicationDispatch): Promise<CommunicationDispatchResult>;
}
