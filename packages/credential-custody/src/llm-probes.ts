import type { CredentialProbe, ProbeInput, ProbeResult, ProbeWarning } from './probe.ts';

const DEFAULT_TIMEOUT_MS = 8_000;

const COMPAT: readonly {
  readonly providerKey: string;
  readonly displayName: string;
  readonly modelsUrl: string;
  readonly freeTier: boolean;
  readonly docsUrl: string;
}[] = [
  { providerKey: 'deepseek', displayName: 'DeepSeek', modelsUrl: 'https://api.deepseek.com/v1/models', freeTier: false, docsUrl: 'https://api-docs.deepseek.com/' },
  { providerKey: 'nvidia', displayName: 'NVIDIA NIM', modelsUrl: 'https://integrate.api.nvidia.com/v1/models', freeTier: true, docsUrl: 'https://docs.api.nvidia.com/nim/' },
  { providerKey: 'groq', displayName: 'Groq', modelsUrl: 'https://api.groq.com/openai/v1/models', freeTier: true, docsUrl: 'https://console.groq.com/docs/openai' },
  { providerKey: 'together', displayName: 'Together AI', modelsUrl: 'https://api.together.xyz/v1/models', freeTier: true, docsUrl: 'https://docs.together.ai/docs/openai-api-compatibility' },
  { providerKey: 'fireworks', displayName: 'Fireworks', modelsUrl: 'https://api.fireworks.ai/inference/v1/models', freeTier: false, docsUrl: 'https://docs.fireworks.ai/guides/querying-text-models' },
  { providerKey: 'openrouter', displayName: 'OpenRouter', modelsUrl: 'https://openrouter.ai/api/v1/models', freeTier: true, docsUrl: 'https://openrouter.ai/docs' },
  { providerKey: 'mistral', displayName: 'Mistral', modelsUrl: 'https://api.mistral.ai/v1/models', freeTier: false, docsUrl: 'https://docs.mistral.ai/api/' },
  { providerKey: 'xai', displayName: 'xAI', modelsUrl: 'https://api.x.ai/v1/models', freeTier: false, docsUrl: 'https://docs.x.ai/docs' },
];

async function call(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

function nowIso(input: ProbeInput): string {
  return input.now?.() ?? new Date().toISOString();
}

function compatProbe(item: (typeof COMPAT)[number]): CredentialProbe {
  return {
    providerKey: item.providerKey,
    async probe(input) {
      const fetchImpl = input.fetchImpl ?? fetch;
      const result = await call(fetchImpl, item.modelsUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${input.secret}` },
      });
      if (!result.ok) {
        const body = result.body as { error?: { message?: string }; message?: string } | null;
        return {
          valid: false,
          providerKey: item.providerKey,
          detectedCapabilities: [],
          warnings: [],
          error: body?.error?.message ?? body?.message ?? result.error ?? `${item.displayName} returned HTTP ${result.status}.`,
          checkedAt: nowIso(input),
        } satisfies ProbeResult;
      }
      const payload = result.body as { data?: unknown[]; models?: unknown[] } | null;
      const models = payload?.data ?? payload?.models ?? [];
      const warnings: ProbeWarning[] = [];
      if (Array.isArray(models) && models.length === 0) {
        warnings.push({
          code: `${item.providerKey.toUpperCase()}_NO_MODELS`,
          severity: 'WARNING',
          message: `This ${item.displayName} key authenticated but listed no models.`,
        });
      }
      if (item.freeTier) {
        warnings.push({
          code: `${item.providerKey.toUpperCase()}_FREE_TIER`,
          severity: 'WARNING',
          message: `${item.displayName} is on a free or credit grant. Rate limits apply; this is not an SLA.`,
          actionUrl: item.docsUrl,
        });
      }
      return {
        valid: true,
        providerKey: item.providerKey,
        detectedCapabilities: ['ai.generate'],
        warnings,
        checkedAt: nowIso(input),
      };
    },
  };
}

export const LLM_COMPAT_PROBES: Readonly<Record<string, CredentialProbe>> =
  Object.fromEntries(COMPAT.map((item) => [item.providerKey, compatProbe(item)]));

export const anthropicProbe: CredentialProbe = {
  providerKey: 'anthropic',
  async probe(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const result = await call(fetchImpl, 'https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: { 'x-api-key': input.secret, 'anthropic-version': '2023-06-01' },
    });
    if (!result.ok) {
      const body = result.body as { error?: { message?: string } } | null;
      return {
        valid: false,
        providerKey: 'anthropic',
        detectedCapabilities: [],
        warnings: [],
        error: body?.error?.message ?? result.error ?? `Anthropic returned HTTP ${result.status}.`,
        checkedAt: nowIso(input),
      };
    }
    return {
      valid: true,
      providerKey: 'anthropic',
      detectedCapabilities: ['ai.generate'],
      warnings: [],
      checkedAt: nowIso(input),
    };
  },
};
