# Infrastructure (Terraform)

All AWS infrastructure for Ordersail. Region `us-east-1`, account `084375572674`.

```
infra/terraform/
├── bootstrap/          # S3 state bucket + DynamoDB lock table — LOCAL state, run once
├── modules/            # reusable modules (network, rds, ecs-service, alb, s3-static-site, …)
└── envs/
    └── production/     # the live stack — S3 remote state
```

## Layer order

### 1. `bootstrap/` — run once, manually, from an admin identity

Creates `ordersail-terraform-state-084375572674` (S3, versioned, encrypted) and
`ordersail-terraform-locks` (DynamoDB). Its own state is **local** (chicken-and-egg)
— the `terraform.tfstate` file lives in the directory and is gitignored.

```bash
cd infra/terraform/bootstrap
terraform init && terraform apply
```

Already applied (2026-08-26). Only re-run to move the backend to a new account —
then update the hardcoded values in `envs/production/backend.tf`.

### 2. `envs/production/` — the live stack

```bash
cd infra/terraform/envs/production
terraform init      # configures the S3 backend
terraform plan
terraform apply
```

Contains: VPC + NAT, RDS Postgres 17 (`ordersail-production`), ElastiCache Redis,
ECS cluster + 4 Fargate services (merchant-api, storefront-api, worker, pos-api —
pos-api runs nothing until its first image is pushed, OS-35) + a migrator task,
1 shared API ALB (host-routed: `storefront.` → storefront-api, `pos.` → pos-api,
`merchant.` → merchant-api via merchant-web's CloudFront `/api/*`), 2
CloudFront distributions (merchant-web, website) + S3 origin buckets, ACM cert
(`*.ordersail.com`), Secrets Manager (one secret per API + the DB URL), ECR
(5 repos, **IMMUTABLE** — `cd.yml` pushes exactly one tag per build, the git SHA;
no `:latest`), the GitHub OIDC provider, and two GitHub-Actions deploy roles
(`-platform`, `-website`).

**State as of 2026-08-31:** fully applied and `merchant-*`-named. Previously the
stack was applied under the pre-rename `shop-admin-*` names; the rename apply
(31 create / 31 destroy — every resource an empty shell) landed this date and
also replaced RDS to pick up `db_name = "ordersail"` (was `"shop"`).

## GitHub configuration (consumed by `.github/workflows/`)

### Environment

A **`production`** GitHub Environment with **one required reviewer**. Gates the
approval-sensitive jobs in `cd.yml` (`migrate`, `deploy-services`,
`deploy-frontends`) and `deploy-website.yml` — there is no staging (M4 / OS-38).

### Repo variables (`gh variable list`)

| variable | value | source |
|---|---|---|
| `AWS_REGION` | `us-east-1` | fixed |
| `AWS_DEPLOY_ROLE_ARN` | `…:role/ordersail-github-actions-deploy-platform` | `terraform output deploy_role_platform_arn` |
| `AWS_DEPLOY_ROLE_ARN_WEBSITE` | `…:role/ordersail-github-actions-deploy-website` | `terraform output deploy_role_website_arn` |
| `VITE_STRIPE_PUBLISHABLE_KEY` | `pk_test_…` | platform Stripe publishable key — `merchant-web`'s Stripe Connect view (OS-31) |

### OIDC trust

Both deploy roles trust GitHub Actions OIDC tokens for this repo. GitHub issues
the token `sub` claim with an **immutable ID-suffixed prefix**
(`repo:noel-vega@179352624/ordersail@1292329338:…`, the default since 2025) — the
trust policies list both that and the legacy `repo:noel-vega/ordersail:…` form.
The two numeric ids live in `terraform.tfvars` as `github_owner_id` /
`github_repo_id` (`gh api repos/noel-vega/ordersail --jq '.owner.id, .id'`); they
change only on a GitHub owner/repo **transfer** — update the tfvars and re-apply
`module.deploy_role_*` if that ever happens.

## Pre-launch frontend gate (OS-363)

`merchant.ordersail.com` sits behind a shared HTTP Basic credential, enforced by
a CloudFront Function on `viewer-request` over the distribution's default cache
behavior (`/api/*` is **not** gated). **`ordersail.com` is public** since OS-666:
a pre-launch "coming soon" site with no route into the merchant app (OS-663). Its
distribution keeps its viewer-request function for the directory-index rewrite
(OS-365), just without the auth check. The credential lives in a Secrets Manager secret, created out of band —
never in git or tfvars.

**Prerequisite — the secret must exist before `terraform apply`** (same as the
per-app secrets in `modules/secrets`; a plan run before it exists fails on the
data source):

```bash
aws secretsmanager create-secret --region us-east-1 \
  --name ordersail/production/frontend/basic-auth \
  --secret-string '{"crew":"<long-passphrase>"}'      # add keys for more logins
```

Terraform turns the `{"user":"pass"}` map into a `["user:pass"]` allow-list baked
into the function. An empty `{}` (or no secret) means the gate is off — plan and
apply are unaffected.

Gating or ungating a site is per module: the `basic_auth_credentials` line on
that `module "frontend_*"` block. For a site with `directory_index` (the
website), toggling it only re-publishes the function's code in place. Each
distribution update takes ~15–20 min.

**Rotate:** `aws secretsmanager put-secret-value --secret-id
ordersail/production/frontend/basic-auth --secret-string '{"crew":"…"}'`, then
`terraform apply` (re-renders + re-publishes the function). The value is only
base64-embedded in the published function, never in git — keep it that way.

**Lift at launch:** open a PR that deletes `envs/production/frontend-auth.tf` and
the `basic_auth_credentials` line on `module "frontend_merchant_web"`, then apply
(emptying the secret to `{}` also works). Emergency: detach the `viewer-request`
function on the merchant-web distribution in the CloudFront console (~5 min to
propagate), reconcile Terraform after. **Don't detach the website's function**:
it also does the directory-index rewrite, and `/features` etc. would 404.

**Verify:**

```bash
curl -sI https://ordersail.com                              # 200 (public since OS-666)
curl -sI https://ordersail.com/features/                    # 200 (directory index, trailing slash)
curl -sI https://ordersail.com/features                     # 200 (directory index, bare path)
curl -sI https://merchant.ordersail.com                     # 401
curl -sI -u 'crew:<pass>' https://merchant.ordersail.com    # 200
curl -sI https://merchant.ordersail.com/api/                # not the Basic realm
```

## Alerts & alarms (OS-80)

`envs/production/monitoring.tf` creates two SNS topics
(`ordersail-alerts-{critical,warning}`) and the CloudWatch alarm suite
(`modules/{ecs-service,alb,rds,elasticache}/alarms.tf`, the worker's
order-job dead-letter page, and the SES bounce/complaint-rate alarms in
`envs/production/ses.tf`) routes to them.

**Prerequisite — the recipients secret must exist before `terraform apply`**
(the `alerts-recipients.tf` data source fails if it's absent, same as the
frontend gate):

```bash
aws secretsmanager create-secret --region us-east-1 \
  --name ordersail/production/alerts/recipients \
  --secret-string '{"emails":["you@example.com"],"sms":[]}'
```

`terraform apply` then creates one `email` subscription per address per topic.
Each sends a one-time confirmation email from `no-reply@sns.amazonaws.com` that
must be clicked — **check Spam / the Promotions tab**. `sms` stays `[]` until the
SNS SMS sandbox is exited. Full runbook: `docs/runbooks/alerts.md`.

## Logs Insights saved queries (OS-98)

`envs/production/log-queries.tf` saves the Logs Insights queries in the
`ordersail/` folder, each over all four service log groups. Add or change a query
there and apply; the list and what each is for is in `docs/observability.md` →
"Tracing a bug", so update that table too.

## Mailboxes: Google Workspace (OS-665)

`envs/production/mail.tf` publishes Google Workspace's MX, the apex TXT (Google verification and
SPF) and Google's DKIM key, from `google_site_verification` / `google_dkim_txt` in
`terraform.tfvars`, plus the domain-wide DMARC record that covers both Workspace and SES mail.
Users and groups are managed in the Workspace admin console. App mail is SES (`ses.tf`),
independent of this. Runbook: `docs/runbooks/alerts.md` → Email (SES) → Mailboxes.

## Runbooks

### Changing an RDS identity attribute (`db_name`, `identifier`, `engine`, …)

These force a **replacement**, which the instance's `deletion_protection = true`
blocks. Before `terraform apply`:

```bash
aws rds modify-db-instance --db-instance-identifier ordersail-production \
  --no-deletion-protection --apply-immediately
# wait for PendingModifiedValues to clear
terraform apply          # old instance destroyed (final snapshot taken), new one created
```

The new instance comes up with `deletion_protection = true` from
`modules/rds/main.tf` — no code change and no manual re-enable needed. The final
snapshot is `ordersail-production-final`; delete it manually once you're sure.

### RDS master password

Terraform-managed (`modules/rds` → `random_password.master`), **not**
`manage_master_user_password`. RDS-side auto-rotation rotates the password
out-of-band every 7 days, which the composed `database-url` app secret can't
follow without an `apply` — that was a recurring prod outage (OS-366). The
password lives in the (encrypted, versioned, access-restricted) remote state.

To rotate it: `terraform apply -replace=module.rds.random_password.master`, then
`aws ecs update-service --cluster ordersail --service ordersail-<svc>
--force-new-deployment` for each of merchant-api / storefront-api / worker /
pos-api so they re-read `database-url`. Managed rotation comes back — properly —
with **RDS Proxy** (OS-45).

### CloudFront changes

Creating or destroying a distribution takes ~15–20 min each (Terraform waits for
`Deployed`). A rename touches two distributions serially — budget 30–45 min for
that apply.

### Changing a container env var or secret

The task definition's `environment` / `secrets` (and roles / cpu / memory) are
authored **once**, in the `module "ecs_service_*"` blocks in
`envs/production/main.tf` (migrator: `migrator.tf`). Each module renders the full
`register-task-definition` payload as its `register_task_definition_input` output;
`ssm.tf` publishes those to `/ordersail/production/ecs/<app>-taskdef`.

To change one:

1. Edit the `module "ecs_service_<app>"` block (or `migrator.tf`).
2. `terraform apply` in `envs/production/` — the only diff is the
   `aws_ssm_parameter.ecs_taskdef["…"]` value. **No ECS resource churn**
   (`ignore_changes = [container_definitions]` still suppresses the rev-1 def).
3. Merge to `main`. `cd.yml`'s `deploy-services` reads the SSM contract, swaps in
   the built image tag, and registers a new revision — the change is live after
   the next deploy. No manual `aws ecs register-task-definition` (OS-361).

For a Secrets Manager **key** rename: rename it in the JSON
(`aws secretsmanager put-secret-value`) *and* update the `valueFrom` suffix in
`main.tf` in the same change, so the next deploy's task def points at the new key.

### Adding a required env var (checklist)

A new required variable has to land in four places. Missing the mapping or the
secret key crash-loops the service at its next restart (OS-652:
`MFA_ENCRYPTION_KEY`), so both are now checked. The mapping is checked on every
PR and the secret key before every deploy. Only `.env.example` is still
convention.

1. **The app's zod schema** (`env.schema.ts`, next to the app's `env.ts`).
   Don't give it a `localhost`-style default that could silently reach
   production.
2. **`.env.example`** for the app, so `npm run setup` gives local dev a value.
3. **The task-def mapping** in `envs/production/main.tf` (migrator:
   `migrator.tf`). Put secrets under `secrets` as
   `"${module.secrets.app_secret_arns["<app>"]}:<JSON_KEY>::"` and plain config under
   `environment`. Then `terraform apply` so the SSM contract picks it up.
   Not every app has an app secret (worker and pos-api don't): for an app's
   first secret, add it to `app_secret_names` in `modules/secrets/main.tf` and
   its ARN to the service's `secrets_manager_secret_arns`.
   **Enforced on every PR (OS-655):** each app's `env.mappings.spec.ts` fails
   if a schema key has no mapping in its `module "ecs_service_<app>"` block.
   If the var is genuinely fine unset in production, add it to that spec's
   `FINE_UNSET_IN_PRODUCTION` allowlist with the reason instead.
4. **The key inside the Secrets Manager secret**, for a secret. Terraform
   never writes secret values, so add it out-of-band:
   `aws secretsmanager get-secret-value` → add the key to the JSON →
   `aws secretsmanager put-secret-value`.

Then prove the contract will boot. Run this with AWS credentials:

```bash
npm run verify:contracts   # node scripts/verify-taskdef-contracts.mjs
```

It checks every contract (the four services plus the migrator). It fails if any
`valueFrom` names a JSON key its secret doesn't have. It also fails if any
`environment` value points at `localhost` or at a raw `*.cloudfront.net` /
`*.elb.amazonaws.com` host. `cd.yml` (`verify-contracts`) and
`environment.yml` (`up-verify-contracts`) run the same check before they start
anything. Running it yourself tells you before merge instead of at deploy time.
`rollback.yml` runs it with `--taskdef <arn>` against the target revision, so
it won't roll back to a revision that maps a secret that has since been deleted.

### First-time image bootstrap

ECR is `IMMUTABLE` and `cd.yml` only pushes `:<git-sha>` — there is no `:latest`.
The Terraform-owned rev-1 task definitions (the `ecs_service_*` modules +
`aws_ecs_task_definition.migrator`) reference `:${var.bootstrap_image_tag}`
(default `bootstrap`); `ignore_changes = [container_definitions]` means Terraform
owns only that rev-1 baseline — every running revision is registered by `cd.yml`
from the SSM contract — so this tag is **never** the running image.

For an already-applied stack: nothing to do (rev-1 task defs already exist and
are ignored).

For a **from-scratch** environment, each `ordersail-*` repo needs a `:bootstrap`
tag before the first `terraform apply`. Either let `cd.yml`'s `build-and-push`
run first and re-tag one of its SHAs, or:

```bash
KNOWN_SHA=<a git sha already built by CI>
for r in merchant-api storefront-api worker migrator pos-api; do
  M=$(aws ecr batch-get-image --repository-name ordersail-$r \
      --image-ids imageTag="$KNOWN_SHA" --query 'images[0].imageManifest' --output text)
  aws ecr put-image --repository-name ordersail-$r --image-tag bootstrap --image-manifest "$M"
done
```

(Or set `-var bootstrap_image_tag=<sha>` on the first apply if that SHA is
already in every repo.)
