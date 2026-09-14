import type { AiGateway, AiInvocationIntent, AiProposal } from './index.ts';
import {
  applyPromptOverlays,
  identityPromptResolver,
  type AiPromptResolver,
} from './prompt-resolver.ts';

export interface PromptResolvingAiGatewayOptions {
  readonly gateway: AiGateway;
  readonly promptResolver?: AiPromptResolver;
}

/**
 * Resolves tenant prompt configuration and applies system/user overlays
 * before delegating to the inner gateway. Only ACTIVE prompts should be
 * returned by the resolver; DRAFT never enters this path.
 */
export class PromptResolvingAiGateway implements AiGateway {
  readonly #gateway: AiGateway;
  readonly #promptResolver: AiPromptResolver;

  constructor(options: PromptResolvingAiGatewayOptions) {
    this.#gateway = options.gateway;
    this.#promptResolver = options.promptResolver ?? identityPromptResolver;
  }

  async invoke(intent: AiInvocationIntent): Promise<AiProposal> {
    const resolved = await this.#promptResolver.resolve({
      tenantId: intent.tenantId,
      key: intent.promptConfiguration.key,
      version: intent.promptConfiguration.version,
    });

    const overlaid = applyPromptOverlays({
      resolved,
      inputReference: intent.inputReference,
      ...(intent.contextReference === undefined
        ? {}
        : { contextReference: intent.contextReference }),
    });

    const nextIntent: AiInvocationIntent = {
      ...intent,
      inputReference: overlaid.inputReference,
      ...(overlaid.contextReference === undefined
        ? {}
        : { contextReference: overlaid.contextReference }),
    };

    return this.#gateway.invoke(nextIntent);
  }
}
