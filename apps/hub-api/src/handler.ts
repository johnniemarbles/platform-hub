/**
 * The hub's request pipeline.
 *
 *  authorization bearer token
 *      ↓
 *  verifyScopeToken   (@platform-hub/contracts)
 *      ↓
 *  enforceScope       (tenant + app + hierarchy + credential class + grant)
 *      ↓
 *  app_may_use_connector  (only when the handler names a connector)
 *      ↓
 *  withRequestContext (opens tx, sets GUCs, runs the handler, commits)
 *
 * A refused request returns a Refusal JSON object with a traceId and a stable
 * typed `code`. The hub never raises an exception as a business error.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  verifyScopeToken,
  verifyScopeTokenEd25519,
  enforceScope,
  refusal,
  isRefusal,
  type ScopeCheck,
  type VerifyResult,
  type Verified,
  type ScopeTokenClaims,
  type Refusal,
} from '@platform-hub/contracts';
import { withRequestContext, type Db, type Transaction } from './db.ts';

export interface HandlerContext {
  readonly tx: Transaction;
  readonly claims: ScopeTokenClaims;
  readonly traceId: string;
}

export type Route = (ctx: HandlerContext, req: IncomingMessage) => Promise<unknown>;

export interface HubApiConfig {
  readonly db: Db;
  readonly algorithm: 'HS256' | 'EdDSA';
  readonly hs256Secret?: string;
  readonly ed25519PublicKey?: string;
  readonly expectedIssuer?: string;
  readonly expectedAudience?: string;
  readonly now?: () => Date;
}

export interface RouteDefinition {
  readonly method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  readonly path?: string;
  readonly pattern?: RegExp;
  readonly scope: Omit<ScopeCheck, 'tenantId' | 'appId'>;
  readonly handler: Route;
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

const sendRefusal = (res: ServerResponse, r: Refusal): void => {
  const status =
    r.code === 'TOKEN_SIGNATURE_INVALID' || r.code === 'TOKEN_MALFORMED'
      || r.code === 'TOKEN_WRONG_ISSUER' || r.code === 'TOKEN_WRONG_AUDIENCE'
      || r.code === 'TOKEN_EXPIRED' || r.code === 'TOKEN_NOT_YET_VALID'
      ? 401
      : r.code === 'TOKEN_SCOPE_MISMATCH' || r.code === 'CREDENTIAL_CLASS_FORBIDDEN'
        || r.code === 'CREDENTIAL_NOT_GRANTED' || r.code === 'NO_KEY_FALLBACK'
        || r.code === 'TENANT_WRONG_REGION'
        ? 403
        : r.code === 'IDEMPOTENCY_REPLAY' || r.code === 'WEBHOOK_REPLAY'
          ? 409
          : 400;
  sendJson(res, status, r);
};

function verify(token: string, config: HubApiConfig, traceId: string): VerifyResult {
  if (config.algorithm === 'HS256') {
    if (!config.hs256Secret) throw new Error('HS256 selected but no secret configured');
    return verifyScopeToken(token, {
      secret: config.hs256Secret,
      traceId,
      ...(config.expectedIssuer !== undefined ? { expectedIssuer: config.expectedIssuer } : {}),
      ...(config.expectedAudience !== undefined ? { expectedAudience: config.expectedAudience } : {}),
      ...(config.now !== undefined ? { now: config.now } : {}),
    });
  }
  if (!config.ed25519PublicKey) throw new Error('EdDSA selected but no public key configured');
  return verifyScopeTokenEd25519(token, {
    publicKey: config.ed25519PublicKey,
    traceId,
    ...(config.expectedIssuer !== undefined ? { expectedIssuer: config.expectedIssuer } : {}),
    ...(config.expectedAudience !== undefined ? { expectedAudience: config.expectedAudience } : {}),
    ...(config.now !== undefined ? { now: config.now } : {}),
  });
}

/**
 * Builds the one listener function the HTTP server mounts. Pure of
 * server concerns so it is directly testable without a port.
 */
export function makeDispatcher(routes: readonly RouteDefinition[], config: HubApiConfig) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const traceId = (req.headers['x-trace-id'] as string | undefined) ?? randomUUID();

    if (req.url === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, traceId });
    }

    const route = routes.find((r) => {
      if (r.method !== req.method) return false;
      if (r.pattern) return r.pattern.test(req.url ?? '');
      return r.path !== undefined && r.path === req.url;
    });
    if (!route) {
      return sendJson(res, 404, refusal('REFUSED', traceId, 'route not found'));
    }

    const authz = req.headers['authorization'];
    if (typeof authz !== 'string' || !authz.toLowerCase().startsWith('bearer ')) {
      return sendRefusal(res, refusal('TOKEN_MALFORMED', traceId, 'missing bearer token'));
    }
    const token = authz.slice('bearer '.length).trim();

    const verified = verify(token, config, traceId);
    if (!verified.ok) return sendRefusal(res, verified);

    // Scope check keyed off the verified claims; this handler expects any route
    // that names a specific tenant/app to carry that in its URL (via a resource
    // id). Gate 2 is read-only, so for now we enforce the scope's own
    // tenant+app and leave resource routes to Gate 3+.
    const scopeCheck: ScopeCheck = {
      tenantId: verified.claims.tenantId,
      appId: verified.claims.appId,
      ...route.scope,
    };
    const scoped = enforceScope(verified as Verified, scopeCheck, traceId);
    if (scoped !== true) return sendRefusal(res, scoped);

    try {
      const body = await withRequestContext(config.db, {
        tenantId: verified.claims.tenantId,
        appId: verified.claims.appId,
        hierarchyScope: verified.claims.hierarchyScope,
        credentialClass: verified.claims.credentialClass,
        ...(verified.claims.grantId !== undefined ? { grantId: verified.claims.grantId } : {}),
      }, async (tx) => {
        const handlerRes = await route.handler({ tx, claims: verified.claims, traceId }, req);
        if (isRefusal(handlerRes)) throw handlerRes;
        return handlerRes;
      });
      sendJson(res, 200, { ok: true, traceId, result: body });
    } catch (e) {
      if (isRefusal(e)) {
        return sendRefusal(res, e);
      }
      sendJson(res, 500, { ok: false, code: 'REFUSED', traceId, message: 'internal error' });
      // In production this is where the trace flows into OpenTelemetry.
      // Keeping console.error here so dev loop surfaces the stack.
      console.error('[hub-api]', traceId, e);
    }
  };
}
