export function looksLikeTwilioSignalingUrl(value: string): boolean {
  return /^https:\/\//u.test(value.trim());
}

function publicBase(input: { readonly baseUrl?: string }): string | null {
  const base = (input.baseUrl ?? process.env.EXPADIO_VOICE_TWIML_BASE ?? process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/u, '');
  return looksLikeTwilioSignalingUrl(`${base}/`) ? base : null;
}

export function resolveTwilioVoiceSignalingUrl(input: {
  readonly renderedBody?: string;
  readonly tenantId: string;
  readonly connectorKey?: string;
  readonly baseUrl?: string;
}): string | null {
  const body = input.renderedBody?.trim() ?? '';
  if (looksLikeTwilioSignalingUrl(body)) return body;
  const base = publicBase(input);
  if (base === null) return null;
  const params = new URLSearchParams({ tenantId: input.tenantId });
  if (input.connectorKey) params.set('connectorKey', input.connectorKey);
  return `${base}/api/voice/twilio/inbound?${params.toString()}`;
}

export function resolveTwilioVoiceStatusCallbackUrl(input: {
  readonly tenantId: string;
  readonly connectorKey?: string;
  readonly baseUrl?: string;
}): string | null {
  const base = publicBase(input);
  if (base === null || !input.connectorKey) return null;
  const params = new URLSearchParams({
    tenantId: input.tenantId,
    connectorKey: input.connectorKey,
  });
  return `${base}/api/webhooks/twilio?${params.toString()}`;
}
