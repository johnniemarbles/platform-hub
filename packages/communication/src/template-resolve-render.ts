import type {
  CommunicationTemplateMatchedScope,
  CommunicationTemplateRepository,
  CommunicationTemplateResolutionInput,
} from './template.ts';
import {
  renderCommunicationTemplate,
  type RenderedCommunicationTemplate,
} from './template-renderer.ts';

export interface ResolveAndRenderCommunicationTemplateInput
  extends CommunicationTemplateResolutionInput {
  readonly variables?: Readonly<Record<string, unknown>>;
}

export type ResolveAndRenderCommunicationTemplateResult =
  | {
      readonly ok: true;
      readonly matchedScope: Exclude<CommunicationTemplateMatchedScope, 'NONE'>;
      readonly rendered: RenderedCommunicationTemplate;
    }
  | {
      readonly ok: false;
      readonly reasonCode: 'TEMPLATE_MISSING';
      readonly matchedScope: 'NONE';
    }
  | {
      readonly ok: false;
      readonly reasonCode: 'MISSING_VARIABLES';
      readonly matchedScope: Exclude<CommunicationTemplateMatchedScope, 'NONE'>;
      readonly templateId: string;
      readonly version: number;
      readonly missingVariables: readonly string[];
    };

/**
 * Provider-neutral orchestration boundary between active-template resolution
 * and pure rendering. It performs no dispatch or provider selection.
 */
export async function resolveAndRenderCommunicationTemplate(
  repository: CommunicationTemplateRepository,
  input: ResolveAndRenderCommunicationTemplateInput,
): Promise<ResolveAndRenderCommunicationTemplateResult> {
  const resolution = await repository.resolveActive({
    tenantId: input.tenantId,
    ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
    triggerKey: input.triggerKey,
    channel: input.channel,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
  });

  if (resolution.template === null || resolution.matchedScope === 'NONE') {
    return {
      ok: false,
      reasonCode: 'TEMPLATE_MISSING',
      matchedScope: 'NONE',
    };
  }

  const rendered = renderCommunicationTemplate({
    template: resolution.template,
    ...(input.variables === undefined ? {} : { variables: input.variables }),
  });

  if (!rendered.ok) {
    return {
      ok: false,
      reasonCode: 'MISSING_VARIABLES',
      matchedScope: resolution.matchedScope,
      templateId: resolution.template.templateId,
      version: resolution.template.version,
      missingVariables: rendered.missingVariables,
    };
  }

  return {
    ok: true,
    matchedScope: resolution.matchedScope,
    rendered: rendered.rendered,
  };
}
