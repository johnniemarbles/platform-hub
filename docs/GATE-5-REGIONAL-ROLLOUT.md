# Gate 5 — Regional rollout (India/Mumbai cell)

**Objective of this gate.** Stand up the first production country cell — India, region Mumbai — so the first real customer (Tress-Lounge, per the roadmap doc) can sign up into live infrastructure instead of Railway staging. This is infrastructure + policy work, not application code: by the time this gate exits, there is a real AWS prod account for India with Cognito, a database, `hub-api` + `platform-api` deployed, residency enforcement proven, and a passed backup/restore drill.

**Trigger.** Per the plan: "Choosing a country never builds infrastructure: each country's cell is built ahead of time." Gate 5 starts when a real customer is imminent for a country — do not run this gate speculatively for every country in the residency table.

**State at handoff** (confirm before starting):
- Gate 4 has shipped Dentex end-to-end on Railway staging with **test data only** (per the Decisions table in `AI-WORK-ORDER.md`).
- `platform-hub` and `platform-core` both pass their architecture + test suites on `main`.
- AWS MCP connector reconnected (Gate 0 audit flagged this as outstanding — confirm before Step 1).
- No AWS Organization exists yet for this platform (fresh build per the plan's layout).
- Counsel has NOT yet signed off on India residency specifics — Decision #2 in the roadmap doc's "Decisions around Gate 4" section is still open. **This gate produces the infrastructure; it does not substitute for legal sign-off**, which is a separate, parallel track (see "Non-negotiables" below).

**Non-negotiables (plan V3.1):**
1. Residency: each tenant lives in one country cell; no personal data, logs, keys or backups cross cells.
2. One Cognito Essentials user pool per region, behind the identity adapter — never a multi-region replication add-on.
3. One AWS Organization, with a region-deny SCP per country account (exempting global services: IAM, CloudFront, Route 53).
4. Sign-in codes go through each region's own SES, never through the hub — a hub outage must never block sign-in.
5. Legal sign-off is per regulated workload per country, not a single platform-wide approval. **Do not onboard a real paying customer into Mumbai until counsel has signed the India row of the residency table.**
6. Backup/recovery target (operating decision #4): lose at most ~5 minutes of data, restore within ~4 hours, multi-zone, backups in-country, quarterly restore drill.
7. Commit footer:
   ```
   Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_013Qb2YJnq24nNH4Ue57Tig9
   ```

**Order:**
1. Section 1 — AWS Organization + India prod account + region-deny SCP.
2. Section 2 — Cognito pool (Mumbai) + SES sign-in path.
3. Section 3 — Database + `hub-api` + `platform-api` in Mumbai.
4. Section 4 — Edge DNS lookup (workspace → region).
5. Section 5 — Residency enforcement proof (the hub refuses a cell it doesn't hold).
6. Section 6 — Backup/restore drill.
7. Section 7 — Gate 5 exit checklist.

---

# Section 1 — AWS Organization + India prod account

## Objective
Stand up the Organization shape the plan specifies, with the India prod account carrying a region-deny SCP from the moment it exists.

## Preconditions
- AWS root/management account access (or create one).
- AWS MCP connector reconnected in this session (confirm with a trivial call before proceeding — do not assume from the Gate 0 audit note).

## Steps

1. **Create the Organization** (if it doesn't exist) from the management account, with all features enabled (not just consolidated billing) — SCPs require this.

2. **Create the account structure**:
   ```
   AWS Organization
   ├─ Management account      (billing + org settings only — no workloads)
   ├─ Shared services         (CI/CD, container images, global directory)
   ├─ Prod
   │   └─ India prod          (Mumbai — ap-south-1)
   └─ Staging                 (test data only — this can be the existing Railway
                                setup for now; AWS staging account is optional
                                until a second region needs AWS-native staging)
   ```
   Each prod account needs a unique root email — an alias on one mailbox (e.g. `aws+india-prod@yourdomain.com`).

3. **IAM Identity Center** — one sign-in for staff, with access granted per account. Create a permission set scoped to the India prod account for whoever will operate it; do not use long-lived IAM user credentials for human access.

4. **Region-deny SCP** — attach to the India prod account (and to every future prod account the same way):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "DenyAllOutsideApSouth1",
         "Effect": "Deny",
         "NotAction": [
           "iam:*",
           "sts:*",
           "cloudfront:*",
           "route53:*",
           "route53domains:*",
           "support:*",
           "organizations:*",
           "account:*",
           "budgets:*",
           "ce:*",
           "health:*"
         ],
         "Resource": "*",
         "Condition": {
           "StringNotEquals": {
             "aws:RequestedRegion": "ap-south-1"
           }
         }
       }
     ]
   }
   ```
   This is the plan's layered control: "a region-deny policy on each country account blocks every region but its own, exempting AWS's global services." Verify it blocks a test resource creation in, say, `us-east-1` before moving on.

5. **Free-tier awareness** — Cognito's 10,000 MAU free tier and the $0.015/user cost beyond it are shared across the whole Organization, not per account. Note this in the cost model; it matters once a second country opens.

## Verification
- `aws organizations list-accounts` shows the four accounts.
- Attempt (and watch fail) to launch any resource in a non-`ap-south-1` region from the India prod account.
- IAM Identity Center login works for at least one operator, scoped only to India prod.

## Rollback
Organizations and SCPs are reversible — detach the SCP, or close the account (90-day reversal window) if stood up in error. No customer data exists yet at this point, so rollback is low-risk.

---

# Section 2 — Cognito pool (Mumbai) + SES sign-in path

## Objective
One Cognito Essentials user pool in `ap-south-1`, wired to the `CognitoIdentityVerifier` already built in `platform-core/packages/iam-cognito` (section F of `GATE-2-REMAINING.md`), with sign-in mail isolated from marketing reputation.

## Preconditions
- `@platform-core/iam-cognito` exists and passes its tests against a dev pool (confirm — if it was only scaffolded against mocks, validate against a real pool in this section).
- A domain or subdomain for the `auth.` sign-in path, e.g. `auth.in.yourdomain.com`.

## Steps

1. **Create the user pool** in `ap-south-1`:
   - Passwordless by default: email OTP + passkeys. Do not enable password-hash-based sign-in as the primary path (per the plan — password hashes are the hardest thing to migrate between providers later).
   - One pool serves every app for India tenants (Dentex, Tress-Lounge, Realtors, Insurance) — this is deliberate: "one login works across every app a tenant has switched on."
   - Do NOT enable the multi-region replication add-on (explicit plan instruction).

2. **SES for sign-in mail**:
   - Verify `auth.in.yourdomain.com` as a sending domain in SES, `ap-south-1`.
   - Create a **dedicated configuration set** for sign-in mail, separate from any marketing/transactional sending domain, so a marketing reputation problem cannot block sign-in codes.
   - Request production access (move SES out of sandbox) before any real signup.
   - Wire Cognito's custom email sender to this configuration set. Cognito's built-in sender is for testing only per the plan — do not leave it as the production path.

3. **SMS codes (India-specific)**:
   - India SMS requires a custom SMS sender Lambda that attaches DLT-registered entity ID and template IDs — Cognito's built-in SMS sender does not support India's DLT requirements.
   - If SMS sign-in isn't needed at launch, defer this and ship email-OTP + passkeys only; note it as a follow-up rather than blocking the gate.

4. **Wire `@platform-core/iam-cognito`**:
   - Set `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `AWS_REGION=ap-south-1` for the India `platform-api` deployment (Section 3).
   - Run the existing Cognito verifier test suite against this real pool (create one throwaway test user, verify a real ID token end-to-end) — this closes the "Cognito wire-up — blocked on AWS reconnect" item carried since Gate 2.

## Verification
- A test user can sign up, receive an OTP via the `auth.` domain, and sign in.
- `CognitoIdentityVerifier.verify()` against a real ID token from this pool returns a `VerifiedIdentity` with the right `issuer`/`subjectId`.
- SES sending domain shows `Verified` and out of sandbox.
- Confirm emails do NOT flow through hub-api at any point — check the hub has zero code path for OTP delivery (it shouldn't; this is enforced by the identity layer living entirely in platform-core/Cognito).

## Rollback
Delete the user pool (data loss only affects test users created here — no real customer yet). SES domain verification can be left in place harmlessly.

---

# Section 3 — Database + `hub-api` + `platform-api` in Mumbai

## Objective
Move off Railway staging for India production: a real Postgres instance in `ap-south-1`, with `hub-api` and `platform-api` deployed there, multi-AZ, with the backup posture Section 6 will drill.

## Preconditions
- Sections 1–2 complete.
- `hub-api` and `platform-api` both pass their test suites and architecture checks on `main` (platform-api per `GATE-4-WAVE-1a-UNBLOCKED.md` / `1b` whichever has landed).

## Steps

1. **Database** — RDS for PostgreSQL (or Aurora PostgreSQL if you want faster failover), multi-AZ, in `ap-south-1`:
   - Enable automated backups with the retention window needed for the ~4-hour restore target (see Section 6).
   - Enable point-in-time recovery (this is what gets you to the "~5 minutes of data" loss target, not just daily snapshots).
   - Keep it in a private subnet; `hub-api`/`platform-api` reach it via security group, not a public endpoint.

2. **Compute** — this is a judgment call the plan leaves to you (it specifies Railway for dev, AWS for regional cells, not a specific compute service). Reasonable defaults, in order of operational simplicity:
   - **ECS Fargate** behind an ALB — closest to "just run the container," least new surface area versus what you already have working on Railway (same Docker images, same `start` scripts).
   - App Runner — simpler still, less control over VPC placement (matters for reaching the private DB subnet — confirm VPC connector support before choosing this).
   - Avoid standing up EKS for two services; that's disproportionate operational overhead at this stage.

3. **Deploy**:
   - Build the same images Railway builds (reuse the `railway.json`/`nixpacks.toml` build config logic, or a Dockerfile derived from it).
   - Env vars mirror Railway's staging config, swapped to India production values:
     ```
     DATABASE_URL              = <RDS connection string, from Secrets Manager, not plaintext>
     IDENTITY_PROVIDER         = cognito
     AWS_REGION                = ap-south-1
     COGNITO_USER_POOL_ID      = <from Section 2>
     COGNITO_CLIENT_ID         = <from Section 2>
     SCOPE_TOKEN_ALGORITHM     = EdDSA
     SCOPE_TOKEN_ED25519_PRIVATE_KEY = <platform-api only, from Secrets Manager>
     SCOPE_TOKEN_ED25519_PUBLIC_KEY  = <hub-api only, from Secrets Manager>
     HUB_BASE_URL              = <internal service URL, not public>
     PLATFORM_APP_ID           = app_tress_lounge   # or whichever app opens first in Mumbai
     ```
   - **This is the production switch from HS256 to Ed25519** flagged back at Gate 2 ("HS256 for scope tokens in dev; Ed25519 for prod"). Confirm `signScopeTokenEd25519`/`verifyScopeTokenEd25519` round-trip against freshly generated production keys before cutover — don't reuse any dev keys.
   - Store all secrets in AWS Secrets Manager, not environment variables set by hand; grant ECS task role read access scoped to only its own secrets.

4. **Run migrations** via the existing `scripts/migrate.ts` runners (same checksum-table approach as staging) against the new RDS instance, in order: hub-api's migrations, then platform-api's.

## Verification
- `GET /health` on both services from inside the VPC (or via a temporary internal ALB listener) returns `{ok:true}`.
- A scope token signed with the new Ed25519 private key verifies against the new public key end-to-end (repeat the whoami-style check used at the end of Gate 2, this time against India prod).
- `pnpm run migrate` (or its equivalent CI step) completes with all checksums matching what's in source.

## Rollback
No customer data yet at this point in the gate — tear down the ECS services and RDS instance if something is wrong, redo from Section 3. Once Section 7's sign-off happens and a real customer exists, rollback changes character entirely (becomes a failover/restore exercise, not a teardown).

---

# Section 4 — Edge DNS lookup (workspace → region)

## Objective
`acme.yourdomain.com` resolves to the right regional cell without leaking which tenants exist elsewhere, per the plan's "replicated key-value lookup."

## Preconditions
- A Route 53 hosted zone for `yourdomain.com` (or wherever workspaces live).
- `platform.tenants.workspace_name` is the authoritative source (from `platform-api`'s Section 1 migrations in the Wave 1 handoff).

## Steps

1. **Pick the mechanism** — the plan calls for "a replicated key-value lookup," not literal per-tenant DNS records (that doesn't scale and leaks tenant existence via DNS enumeration). Recommended shape:
   - A single wildcard-ish edge: `*.yourdomain.com` → CloudFront (or an ALB) that inspects the `Host` header.
   - A small edge function (CloudFront Function or Lambda@Edge) does a fast lookup — DynamoDB global table or a cached lookup against the directory — mapping `workspace_name` → region, then routes/rewrites to that region's origin.
   - This also matches operating decision #1 ("Workspace name to region only, written to DNS; no emails or hashes") — the lookup carries *only* the workspace-name-to-region mapping, nothing else.

2. **Populate the lookup** whenever a tenant is created: `platform-api`'s tenant-creation path (or a small async worker reading the outbox) writes `{workspace_name, region: 'ap-south-1'}` into the lookup store. This should already be close to what exists for the `makeHostResolver` in `platform-api` (Wave 1 handoff, Section 1.3) — the edge lookup and that in-service resolver are two layers of the same mapping; keep them derived from the same source of truth (`platform.tenants`), never hand-duplicated.

3. **"Forgot my workspace" flow** — per the plan, this asks the user to pick their country first and runs only in that region; it must never fan out a lookup across regions by email address. Implement this as a per-region form, not a global one.

## Verification
- Creating a test tenant via `platform-api` results in a correct edge-lookup entry within the propagation window you choose (seconds, if using DynamoDB global tables + CloudFront Functions).
- A request to `faketenant.yourdomain.com` (no matching workspace) gets a clean "not found," not a stack trace or a region guess.
- Confirm the edge lookup payload contains nothing but workspace name and region — no email, no tenant ID, no hash of anything (operating decision #1).

## Rollback
This is additive edge configuration; remove the CloudFront Function/distribution behavior to fall back to direct ALB access during cutover testing.

---

# Section 5 — Residency enforcement proof

## Objective
Prove the layered control the plan describes: "the region-deny policy is one preventive control, checked together with service-specific data paths" — i.e., even if someone bypasses the edge lookup, the application layer itself refuses to serve a tenant from the wrong cell.

## Steps

1. Confirm `platform.connector_grants` (or wherever credential/region metadata lives per the hub's schema) carries `region` and `residency_tags` for every grant, as the plan specifies.

2. Add (or confirm existing) a check in the hub's `app_may_use_connector` path: a request whose `tenantId` resolves to a tenant whose `region` doesn't match the hub instance's own region is refused with a typed code (introduce `TENANT_WRONG_REGION` if not already in `RefusalCode` — it's referenced in the Wave 1 `platform-api` handler already; confirm hub-api has the equivalent check, not just platform-api).

3. **Test**: from the India prod `hub-api`, send a scope token whose claims carry a `tenantId` that only exists in a different region's database (or, absent a second region yet, a tenant ID that simply doesn't resolve in this cell's DB) — expect a refusal, not a 500 or a silent empty result.

4. Confirm logs: per the plan, "logs stay in their country's account; there is no central log account across regions." Verify CloudWatch Logs for India prod services are not being shipped to any shared/global log destination.

## Verification
- The cross-region refusal test above passes with a clean typed refusal.
- A log export/destination audit shows India prod logs stay in the India prod account.
- Backups (confirmed in Section 6) are also province-scoped — no replication to a shared backup account.

## Rollback
N/A — this section is verification, not infrastructure change. A failure here blocks Gate 5 exit; fix the underlying check and re-test.

---

# Section 6 — Backup/restore drill

## Objective
Meet operating decision #4: lose at most ~5 minutes of data, restore within ~4 hours, multi-zone, backups in-country, and prove it with an actual drill — not just an assumption that RDS backups "just work."

## Steps

1. Confirm RDS automated backups + point-in-time recovery are enabled (Section 3) with a retention period that supports at least one full restore test without needing to touch production.

2. **Run the drill**:
   - Seed a throwaway dataset (tenant + a few rows) into India prod (or a clone of it).
   - Note the time, then perform a destructive action (drop a table, or just note the timestamp and proceed to restore-to-point-in-time).
   - Restore to a new RDS instance using point-in-time recovery to a timestamp ~5 minutes before the destructive action.
   - Time the whole process end-to-end against the ~4 hour target.
   - Verify the restored data matches what existed at that timestamp (the throwaway rows are present; anything after is correctly absent).

3. **Document** the drill in `platform-core/docs/gate-5-backup-drill.md`: timestamp of drill, data-loss window achieved, total restore time, any gaps found (e.g. if restore took longer than 4 hours, that's a finding, not a pass — note the remediation, such as a smaller instance class for faster restore or pre-provisioned standby).

4. Schedule this as a **recurring quarterly drill** — per the plan, this isn't a one-time Gate 5 checkbox. Set a calendar reminder or, if you have scheduled-task tooling available in a later session, a recurring task.

## Verification
- A completed, dated drill record in `gate-5-backup-drill.md` showing both numbers (data-loss window, restore time) meeting or beating the targets, or an explicit documented gap with a remediation plan.

## Rollback
N/A — the drill itself is non-destructive to production (runs against a clone/restore target, not prod directly), unless Step 2 is deliberately run against a disposable pre-production instance, which it should be.

---

# Section 7 — Gate 5 exit checklist

Per the plan's gate structure ("each with an exit test"), Gate 5 for India/Mumbai is done when every row below is checked:

| Item | Evidence |
|---|---|
| AWS Organization + India prod account with region-deny SCP | Section 1 verification |
| Cognito pool live in `ap-south-1`, SES sign-in isolated from marketing | Section 2 verification |
| `hub-api` + `platform-api` live in Mumbai, Ed25519 scope tokens in prod | Section 3 verification |
| Edge DNS lookup routes workspace → region correctly, carries only workspace+region | Section 4 verification |
| Cross-region access attempt refused with a typed code | Section 5 verification |
| Backup/restore drill passed (or gap documented with remediation) | `gate-5-backup-drill.md` |
| **Legal sign-off on the India residency row, from counsel** | Separate deliverable — do not check this box yourself; get the actual signed confirmation and link it here |
| India SMS DLT registration (if SMS sign-in is in scope for launch) | Section 2, Step 3, or explicitly deferred |
| First real tenant NOT yet created | Confirm — Gate 5 infra readiness precedes the first real signup, it doesn't include it |

Once every row is checked, the India cell is open for the first real customer sign-up per the plan's onboarding flow (front door → country picker → regional redirect → Cognito sign-up → tenant creation → app activation → directory registration).

## Rollback for the whole gate
Nothing here touches `expadio` or `PII`. If the India cell needs to be unwound before any real customer signs up: detach SCPs, delete the Cognito pool, delete the RDS instance, tear down ECS services, remove the edge DNS entries. If a real customer already exists when something needs reverting, this is no longer a "rollback" — it becomes an incident response governed by the breach-response runbook (operating decision #9), which should exist before this point and is out of scope for this handoff.

---

# What Gate 5 does NOT cover (explicitly out of scope here)

- **Opening the second country** (Canada/Montreal, next per the roadmap's "Insurance moves to real customers" note) — repeat this entire document with region values swapped, after India's pattern is proven. Don't parallelize the first two regions; let India validate the playbook.
- **SOC 2 Type I** (operating decision #16: "after P3") — separate track, pick an auditor per the roadmap doc's open decision.
- **Enterprise SSO/SCIM** — "on first enterprise ask," not part of initial regional rollout.
- **DLT SMS registration**, if deferred in Section 2 — track as a follow-up before SMS sign-in is offered to India users.
