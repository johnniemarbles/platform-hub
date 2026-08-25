import type { CommunicationChannel } from './index.ts';

export type CommunicationTemplateScope =
  | { readonly kind: 'PLATFORM' }
  | { readonly kind: 'TENANT'; readonly tenantId: string }
  | {
      readonly kind: 'ORGANIZATION';
      readonly tenantId: string;
      readonly organizationId: string;
    };

export type CommunicationTemplateStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type CommunicationTemplateContentFormat = 'TEXT' | 'HTML' | 'MARKDOWN';

export interface CommunicationTemplateKey {
  readonly triggerKey: string;
  readonly channel: CommunicationChannel;
  readonly locale: string;
}

/**
 * Channel-neutral content. Email may use subject, push/in-app may use title,
 * and every channel has a body. Voice templates use text body as script/prompt
 * input; provider-specific markup belongs in adapters, not this contract.
 */
export interface CommunicationTemplateContent {
  readonly format: CommunicationTemplateContentFormat;
  readonly subject?: string;
  readonly title?: string;
  readonly body: string;
}

export interface CommunicationTemplate {
  readonly templateId: string;
  readonly scope: CommunicationTemplateScope;
  readonly key: CommunicationTemplateKey;
  readonly content: CommunicationTemplateContent;
  readonly requiredVariables: readonly string[];
  readonly defaultVariables: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly status: CommunicationTemplateStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateCommunicationTemplateInput {
  readonly scope: CommunicationTemplateScope;
  readonly triggerKey: string;
  readonly channel: CommunicationChannel;
  readonly locale?: string;
  readonly content: CommunicationTemplateContent;
  readonly requiredVariables?: readonly string[];
  readonly defaultVariables?: Readonly<Record<string, unknown>>;
}

export interface CommunicationTemplateResolutionInput {
  readonly tenantId: string;
  readonly organizationId?: string;
  readonly triggerKey: string;
  readonly channel: CommunicationChannel;
  readonly locale?: string;
}

export type CommunicationTemplateMatchedScope =
  | 'ORGANIZATION'
  | 'TENANT'
  | 'PLATFORM'
  | 'NONE';

export interface CommunicationTemplateResolution {
  readonly matchedScope: CommunicationTemplateMatchedScope;
  readonly template: CommunicationTemplate | null;
}

/**
 * Runtime read port. Implementations resolve only ACTIVE templates and apply
 * ownership precedence ORGANIZATION -> TENANT -> PLATFORM. Authoring and
 * version lifecycle are deliberately outside this read boundary.
 */
export interface CommunicationTemplateRepository {
  resolveActive(
    input: CommunicationTemplateResolutionInput,
  ): Promise<CommunicationTemplateResolution>;
}

/**
 * Stable lookup identity for resolution. Provider choice is deliberately
 * absent; locale defaults to `en` when the caller does not provide one.
 */
export function communicationTemplateKey(
  input: Pick<CommunicationTemplateResolutionInput, 'triggerKey' | 'channel' | 'locale'>,
): string {
  const triggerKey = input.triggerKey.trim();
  if (triggerKey.length === 0) throw new Error('Communication template triggerKey is required.');
  const locale = (input.locale ?? 'en').trim();
  if (locale.length === 0) throw new Error('Communication template locale is required.');
  return `${triggerKey}:${input.channel}:${locale.toLowerCase()}`;
}
