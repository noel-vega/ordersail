# Alerts & alarm channels

How production tells us something is wrong, and what to do when it does.
Part of the **Observability & alerting** Linear project (M1 — "Know when it breaks").

## Channels

Two SNS topics, created in `infra/terraform/envs/production/monitoring.tf`:

| Topic | ARN name | Subscribers | Use for |
|---|---|---|---|
| **critical** | `ordersail-alerts-critical` | email (+ SMS once the sandbox is exited) | pages — a human needs to act now |
| **warning** | `ordersail-alerts-warning` | email | elevated but not down; look when convenient |

### Adding / changing recipients

Recipients live in a Secrets Manager secret — **not** in git or tfvars — read by
`infra/terraform/envs/production/alerts-recipients.tf` (same pattern as the frontend
basic-auth gate). JSON shape (both keys optional, default `[]`):

```json
{ "emails": ["you@example.com", "oncall@example.com"], "sms": [] }
```

**First time** (the secret is an apply prerequisite — Terraform's data source fails if
it's absent):

```bash
aws secretsmanager create-secret --region us-east-1 \
  --name ordersail/production/alerts/recipients \
  --secret-string '{"emails":["you@example.com"],"sms":[]}'
```

**Later changes:**

```bash
aws secretsmanager put-secret-value --region us-east-1 \
  --secret-id ordersail/production/alerts/recipients \
  --secret-string '{"emails":["you@example.com","oncall@example.com"],"sms":[]}'
```

Then `terraform apply` (adds/removes `aws_sns_topic_subscription.email`), and **click
"Confirm subscription"** in each "AWS Notification - Subscription Confirmation" email from
`no-reply@sns.amazonaws.com`. Unconfirmed subscriptions receive nothing — and the mail
often lands in **Spam** or Gmail's **Promotions** tab.

### SMS (deferred)

AWS SNS SMS starts in a **sandbox**: it can only send to phone numbers you've verified in
the SNS console, and there's a monthly spend limit. To use it: verify the destination
number(s) (SNS → Text messaging → Sandbox destination phone numbers), optionally request
production access, set a spending limit, then add them to the secret's `sms` array.

## Testing

```bash
CRIT=$(terraform -chdir=infra/terraform/envs/production output -raw alerts_critical_topic_arn)
aws sns publish --topic-arn "$CRIT" --subject "test" --message "alert channel test $(date)"
```
The confirmed email addresses should receive it within a minute.

## Silencing during maintenance

Per alarm, disable its actions (it still evaluates, just doesn't notify):

```bash
aws cloudwatch disable-alarm-actions --alarm-names ordersail-<alarm-name>
# ... maintenance ...
aws cloudwatch enable-alarm-actions  --alarm-names ordersail-<alarm-name>
```

Or force an alarm out of `ALARM` state temporarily:

```bash
aws cloudwatch set-alarm-state --alarm-name ordersail-<name> --state-value OK \
  --state-reason "maintenance window"
```

## Alarm inventory

Each row is added by its issue's PR. `→` is the topic the alarm notifies.

| Alarm | Source | Fires when | → |
|---|---|---|---|
| _ECS RunningTaskCount_ | OS-76 `modules/ecs-service` | running < desired for N min (per service) | critical |
| _ECS container-exit rate_ | OS-76 | ≥3 "Essential container … exited" in 15 min | critical |
| _ALB 5xx rate_ | OS-77 `modules/alb` | target+ELB 5xx / requests > 5% for 5 min | critical |
| _ALB 5xx absolute_ | OS-77 | ELB 5xx > 10 in 5 min | warning |
| _ALB p95 latency_ | OS-77 | `TargetResponseTime` p95 > threshold for 5 min | warning |
| _ALB unhealthy hosts_ | OS-77 | `UnHealthyHostCount` > 0 for 3 min | critical |
| _RDS free storage_ | OS-78 `modules/rds` | `FreeStorageSpace` < GB floor | critical |
| _RDS CPU / memory / connections_ | OS-78 | sustained high | warning |
| _ElastiCache memory %_ | OS-79 `modules/elasticache` | `DatabaseMemoryUsagePercentage` > 80% for 10 min | critical |
| _ElastiCache evictions_ | OS-79 | `Evictions` > 0 for 5 min | critical |
| _ElastiCache CPU / swap / connections_ | OS-79 | sustained high | warning |
| _Order-job dead-letter_ | OS-73 `apps/worker` | an `orders` job exhausts all 8 attempts | critical |
| _Alert lines_ | OS-99 `modules/ecs-service` | the service logs any `alert: true` line (≥1 in 5 min) | critical |
| _Error lines_ | OS-99 `modules/ecs-service` | > 10 `level >= 50` lines in 5 min (per service, `alarm_error_lines_threshold`) | warning |
| _SES bounce rate_ | OS-659 `envs/production/ses.tf` | account `Reputation.BounceRate` > 2% (warning) / > 4% (critical) | warning / critical |
| _SES complaint rate_ | OS-659 `envs/production/ses.tf` | account `Reputation.ComplaintRate` > 0.05% (warning) / > 0.08% (critical) | warning / critical |

## When "order-job dead-letter" fires

A customer paid via Stripe and no order was created. The job's data is persisted in the
`failed_orders` table (independent of Redis). Reconcile from there:

The worker also logs one `error` line with `alert: true` /
`event: "order_job.dead_lettered"` carrying `checkoutSessionId`, `paymentIntentId` and the
unresolved count (`failedOrderRecorded: false` if the row write failed too).

1. merchant-web → the failed-orders view (OS-116) shows the row and a **Retry** action.
2. Once the root cause is fixed, retry re-drives the order from the persisted
   `OrderJobData` — it does not touch Redis/BullMQ.
3. Cross-check the Stripe payment intent to confirm the charge before/after.

A dead-letter also trips **alert lines** on the worker (`ordersail-worker-alert-lines`), so
it arrives twice: the worker's direct SNS page with the details, and the alarm. The alarm is
the backstop for when the worker's own SNS publish fails.

## When "alert lines" fires

Alarm `ordersail-<service>-alert-lines`. The service logged a line with `alert: true` — a
human has to act. Find it with the saved Logs Insights query **`ordersail/Alerts`** (see
[Tracing a bug](../observability.md#tracing-a-bug)); the `service` column shows which one.

Then follow the `event`:

| `event` | Service | Runbook |
|---|---|---|
| `order_job.dead_lettered` | worker | [When "order-job dead-letter" fires](#when-order-job-dead-letter-fires) above |
| `dispute.opened` | merchant-api | `docs/runbooks/refunds-disputes.md` |

The alarm returns to OK after a 5-minute window with no `alert: true` lines, so an OK
notification doesn't mean the problem is fixed — only that no new line was logged.

## When "error lines" fires

Alarm `ordersail-<service>-error-lines`, warning topic. More than 10 error-level lines in 5
minutes — something is failing repeatedly, but nothing asked for a page. Group them with the
saved query **`ordersail/Errors by service`**.

Take one line's `correlationId` and pull the whole request with **`ordersail/Request
timeline`**. If a service is legitimately noisy, raise its
`alarm_error_lines_threshold` on the `ecs_service_*` module call in
`infra/terraform/envs/production/main.tf` rather than silencing the alarm.

Both log alarms treat missing data as OK, so a service with no log lines — including one
parked by the environment on/off switch (OS-380) — never fires them. They don't need
disarming in `environment.yml`.

## When "SES bounce/complaint rate" fires

Alarms `ordersail-ses-bounce-rate-{warning,critical}` and
`ordersail-ses-complaint-rate-{warning,critical}`. The account's rolling bounce or complaint
rate is climbing toward the level where SES **reviews** the account (5% bounce, 0.1% complaint)
and then **pauses sending** (10%, 0.5%). A pause stops every email: verification, reset,
invites and order confirmations.

1. See where it stands: `aws sesv2 get-account` (`EnforcementStatus`, `Details`), and the SES
   console's **Reputation metrics** page.
2. See who's bouncing or complaining. SES has already stopped sending to them (the account
   suppression list, `BOUNCE` + `COMPLAINT`):

   ```bash
   aws sesv2 list-suppressed-destinations --start-date "$(date -u -d '-2 days' +%FT%TZ)"
   ```
3. Look for the source: a burst of signups with fake or typo'd addresses, a staff member
   inviting a bad list, or order confirmations to guest-checkout typos. The worker's
   `email.sent` lines carry `jobName`. Use `ordersail/Request timeline` on one to see which flow
   sent it.
4. Fix the source rather than the list. Remove an address from suppression only when you know
   it's good again: `aws sesv2 delete-suppressed-destination --email-address <addr>`.

Mailbox-simulator addresses (`bounce@simulator.amazonses.com`, `complaint@…`) exercise bounce
and complaint handling without touching the reputation rates.

