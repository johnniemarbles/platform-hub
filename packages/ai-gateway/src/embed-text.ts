import { randomUUID } from 'node:crypto';
import type { AiGateway, AiInvocationIntent } from './index.ts';

export class EmbedTextError extends Error {
  readonly code: 'EMBED_OUTPUT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'EmbedTextError';
    this.code = 'EMBED_OUTPUT_INVALID';
  }
}

export interface EmbeddedText {
  readonly vector: readonly number[];
  /** Model that produced the vector (from the proposal's provenance); vectors only compare within one model. */
  readonly modelKey: string;
}

/** Embeds text via AiGateway.invoke({operation: 'EMBED'}) and unwraps the adapter's {dimensions, embedding} JSON payload. */
export async function embedTextWithModel(
  gateway: AiGateway,
  input: { readonly tenantId: string; readonly text: string; readonly purpose: string },
): Promise<EmbeddedText> {
  const invocationId = randomUUID();
  const intent: AiInvocationIntent = {
    invocationId,
    tenantId: input.tenantId,
    operation: 'EMBED',
    purpose: input.purpose,
    inputReference: input.text.slice(0, 8000),
    promptConfiguration: { key: 'brain.embed', version: 1 },
    governance: { requiredResidencyTags: [], requiredComplianceTags: [] },
    idempotencyKey: `${invocationId}:embed`,
    requestedAt: new Date().toISOString(),
  };
  const proposal = await gateway.invoke(intent);
  let vector: number[];
  try {
    const parsed = JSON.parse(proposal.outputContent?.value ?? '') as { embedding?: unknown };
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0 || parsed.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('missing or invalid embedding array');
    }
    vector = parsed.embedding as number[];
  } catch (err) {
    throw new EmbedTextError(`EMBED output was not the expected {dimensions, embedding} JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { vector, modelKey: proposal.provenance.modelKey };
}

export async function embedText(
  gateway: AiGateway,
  input: { readonly tenantId: string; readonly text: string; readonly purpose: string },
): Promise<readonly number[]> {
  return (await embedTextWithModel(gateway, input)).vector;
}

/**
 * Embed many texts with bounded concurrency. Results keep input order; a text
 * that fails is null so callers can store what succeeded.
 */
export async function embedTexts(
  gateway: AiGateway,
  input: { readonly tenantId: string; readonly texts: readonly string[]; readonly purpose: string; readonly concurrency?: number },
): Promise<Array<EmbeddedText | null>> {
  const results: Array<EmbeddedText | null> = new Array(input.texts.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < input.texts.length) {
      const index = next++;
      results[index] = await embedTextWithModel(gateway, {
        tenantId: input.tenantId,
        text: input.texts[index]!,
        purpose: input.purpose,
      }).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(input.concurrency ?? 4, input.texts.length)) }, worker));
  return results;
}
