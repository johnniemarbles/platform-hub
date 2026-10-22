/**
 * Governed prompt configuration resolution.
 * Callers supply an intent prompt key+version; the gateway may resolve
 * template text without embedding prompts in business modules.
 *
 * Default resolver is identity (returns empty system/user overlays) so
 * existing adapters keep using inputReference/contextReference until a
 * tenant prompt store is wired.
 */

export interface ResolvedPromptConfiguration {
  readonly key: string;
  readonly version: number;
  /** Optional system overlay injected ahead of context. */
  readonly systemOverlay?: string;
  /** Optional user overlay prefixed to input. */
  readonly userOverlay?: string;
}

export interface AiPromptResolver {
  resolve(input: {
    readonly tenantId: string;
    readonly key: string;
    readonly version: number;
  }): Promise<ResolvedPromptConfiguration>;
}

/** Fail-open identity resolver — preserves current adapter behavior. */
export const identityPromptResolver: AiPromptResolver = {
  async resolve(input) {
    if (input.key.trim() === '' || !Number.isInteger(input.version) || input.version <= 0) {
      throw new Error('AI_PROMPT_CONFIGURATION_INVALID');
    }
    return { key: input.key, version: input.version };
  },
};

export function applyPromptOverlays(input: {
  readonly resolved: ResolvedPromptConfiguration;
  readonly inputReference: string;
  readonly contextReference?: string;
}): { readonly inputReference: string; readonly contextReference?: string } {
  const user = input.resolved.userOverlay
    ? `${input.resolved.userOverlay}\n\n${input.inputReference}`
    : input.inputReference;
  let context = input.contextReference;
  if (input.resolved.systemOverlay) {
    context = context
      ? `${input.resolved.systemOverlay}\n\n${context}`
      : input.resolved.systemOverlay;
  }
  return {
    inputReference: user,
    ...(context === undefined ? {} : { contextReference: context }),
  };
}
