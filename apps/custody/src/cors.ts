/**
 * WO-E8-B4 — CORS for browser BYOK against an external custody origin.
 *
 * CUSTODY_CORS_ORIGINS = comma-separated allowlist (e.g. https://platform.example.com).
 * When unset, no CORS headers are added (same-origin / server-to-server only).
 */

export function allowedCorsOrigins(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return (env.CUSTODY_CORS_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function corsHeadersForRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const allowed = allowedCorsOrigins(env);
  if (!allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, x-expadio-custody-ticket, x-expadio-reauth-at',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
