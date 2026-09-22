import { probeFor as baseProbeFor } from './probe.ts';
import { LLM_COMPAT_PROBES, anthropicProbe } from './llm-probes.ts';
import type { CredentialProbe } from './probe.ts';

export function probeFor(providerKey: string): CredentialProbe | null {
  const key = providerKey.trim().toLowerCase();
  if (key === 'anthropic') return anthropicProbe;
  return LLM_COMPAT_PROBES[key] ?? baseProbeFor(key);
}
