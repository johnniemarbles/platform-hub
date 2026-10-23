/**
 * The route table for Gate 2 & Gate 4.
 */
import type { RouteDefinition } from './handler.ts';

export const routes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    path: '/v1/_debug/whoami',
    scope: {},
    handler: async ({ tx, claims }) => {
      const r = await tx.query<{ tenant: string | null; app: string | null; cls: string | null; grant: string | null }>(`
        SELECT platform.current_tenant_id()::text AS tenant,
               platform.current_app_id() AS app,
               platform.current_credential_class() AS cls,
               platform.current_grant_id()::text AS grant
      `);
      const row = r.rows[0];
      return {
        claims: {
          sub: claims.sub,
          tenantId: claims.tenantId,
          appId: claims.appId,
          permissions: claims.permissions,
          credentialClass: claims.credentialClass,
        },
        serverContext: {
          tenant: row?.tenant ?? null,
          app: row?.app ?? null,
          credentialClass: row?.cls ?? null,
          grant: row?.grant ?? null,
        },
      };
    },
  },
];
