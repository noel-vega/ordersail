# Parking the production environment (dev-stage cost switch)

Pre-launch, the platform runs a full always-on footprint (~$182/mo) with no real
users. This procedure turns the compute + observability layer **off** while
nobody's developing and back **on** when needed. The architecture is unchanged —
things are scaled to zero or destroyed-and-rebuilt, not re-designed.

Part of **Production readiness / M7 — Cost & tooling** (OS-379 / OS-380 / OS-381),
linked to OS-63.

## What the switch touches

| Layer | Off mechanism | Saving |
|---|---|---|
| 4 ECS services (merchant-api, storefront-api, worker, pos-api) | `desired_count → 0` — the **Environment** workflow (OS-379) | ~$35/mo |
| Container Insights | cluster setting `disabled` — the workflow | ~$21/mo |
| `running-below-desired` alarms | actions disarmed — the workflow (they're `treat_missing_data = breaching`) | — |
| NAT gateway + its EIP | destroyed — `terraform apply` with `environment_on = false` (OS-380) | ~$36/mo |
| ElastiCache Redis | destroyed — same apply | ~$11/mo |

**Stays up:** the 3 ALBs (no stop API; destroying them breaks the Route53
aliases — that's OS-63), RDS (free tier, and a stopped instance auto-restarts
after 7 days), Route53, CloudFront, all Secrets Manager / SSM / ECR.

Off-state run-rate ≈ **$50/mo**.

## Going OFF

1. **Scale down the compute + observability layer.**
   GitHub → Actions → **Environment** → *Run workflow* → `action: down`.
   Approve the `production` environment gate. The run:
   - disarms each `ordersail-<svc>-running-below-desired` alarm, then
     `desired-count 0`, then waits for the service to drain;
   - disables Container Insights on the cluster.

2. **Tear down the NAT gateway + Redis.** From a checkout with AWS creds:

   ```bash
   cd infra/terraform/envs/production
   printf 'environment_on = false\n' > environment.auto.tfvars
   terraform apply
   ```

   Expected plan: **0 add, 3 change, 12 destroy** — NAT gateway + EIP, the
   ElastiCache cluster + its subnet/parameter groups + SG + 5 alarms; the 3
   `*-taskdef` SSM params go to an empty `REDIS_HOST` in place. Nothing else
   (ALBs, DNS, RDS, services, IAM) changes.

   `environment.auto.tfvars` is git-ignored (`*.auto.tfvars`). Leaving it in
   place keeps any later `terraform apply` respecting the off-state.

3. **Verify.**

   ```bash
   aws ec2 describe-nat-gateways --filter Name=state,Values=available --query 'NatGateways[].NatGatewayId'   # []
   aws elasticache describe-cache-clusters --query 'CacheClusters[].CacheClusterId'                          # []
   ```

## Going ON

1. **Rebuild the NAT gateway + Redis first.**

   ```bash
   cd infra/terraform/envs/production
   rm environment.auto.tfvars        # or set environment_on = true
   terraform apply
   ```

   ~3 min for the NAT; the ElastiCache cluster takes ~5–8 min to reach
   `available`. This also re-renders the 3 `*-taskdef` SSM contracts with the
   **new** Redis endpoint hostname.

2. **Bring the services back.**
   Actions → **Environment** → `action: up`. The run:
   - re-enables Container Insights;
   - per service, re-registers a task-def revision from the SSM contract at the
     last-shipped image tag (so the new Redis hostname lands), `desired-count 1`,
     waits stable, health-checks;
   - waits for Container Insights `RunningTaskCount` to resume, then re-arms the
     `running-below-desired` alarms.

   If you skip step 1, `up` fails fast: the task-def contract still has an empty
   `REDIS_HOST`.

3. **Verify.**

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://merchant.ordersail.com/api/health   # 200
   curl -s -o /dev/null -w '%{http_code}\n' https://pos.ordersail.com/health            # 200
   ```

## Caveats

- **Do not merge to `main` / run CD while parked.** `cd.yml`'s migrate job runs
  the migrator task in a private subnet and pulls its image through the NAT —
  which is gone. Bring the environment up first.
- **Redis comes back empty.** It's a pure cache + BullMQ backend; any jobs still
  queued at shutdown are lost. Pre-launch this is effectively never a real order,
  but don't park mid-incident with unprocessed `failed_orders` retries pending.
- **The NAT egress IP changes** on rebuild. Nothing allow-lists it today
  (Stripe / Shippo / SES don't filter source IP) — revisit if that changes.
- **A blackhole route** lingers in the private route table while parked (the
  `0.0.0.0/0 → nat-…` entry, now pointing at a deleted gateway). Harmless —
  nothing in the private subnets needs egress while parked — and the next "on"
  apply re-points it at the fresh NAT.

## Before launch

Remove the switch from routine use: keep NAT + Redis + Container Insights
permanently on, services at `desired_count 1`, and the alarms armed. Add to the
OS-363 pre-launch checklist.
