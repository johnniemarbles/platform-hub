# @expadio/custody-service

**WO-E8-B** — separate process for credential custody (design spec §2.2).

## Invariants

| Rule | Enforcement |
|------|-------------|
| No `DATABASE_URL` / `pg` / `dbPool` | `test/custody-service-no-database.test.ts` |
| No request-body logging | Structured info-only logger (TODO) |
| Egress allowlist | Ops policy: providers + Vault/KMS only |
| Secrets never returned | Routes return `credentialRef` only |

## Status (scaffold)

- HTTP surface mirrors platform-web: `GET /health`, `GET /api/custody/wrapping-key`, `POST /api/custody/credentials`
- Auth is **not** production-ready: requires `x-expadio-custody-ticket` placeholder until control-plane issues short-lived tickets
- Vault via `VAULT_ADDR` + `VAULT_TOKEN` only — **no** local AES / Postgres locker in this process
- platform-web routes remain live until cutover (`NEXT_PUBLIC_CUSTODY_SERVICE_URL`)

## Cutover checklist

1. Deploy custody-service with Vault credentials only (no DB env)
2. Control-plane issues custody tickets after step-up
3. Set `NEXT_PUBLIC_CUSTODY_SERVICE_URL` on platform-web
4. Verify BYOK flow against external origin
5. Delete or proxy platform-web `/api/custody/*`
6. Drive `KNOWN_DATABASE_REACHES` on platform-web ratchet to empty for removed imports

## Local run

```bash
cd apps/custody-service
CUSTODY_BIND=127.0.0.1:8787 pnpm start
```
