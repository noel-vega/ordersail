# Alerts & alarm channels

How production tells us something is wrong, and what to do when it does.
Part of the **Observability & alerting** Linear project (M1 — "Know when it breaks").

> **Paging is off pre-launch (OS-731).** `alert_paging_enabled` defaults to `false`
> (`infra/terraform/envs/production/variables.tf`), which removes every SNS subscription, so the
> alarms below still evaluate and publish to the topics, but nobody is notified. Their state
> is in the CloudWatch console. With no users and the environment parked most of the time,
> pages were noise. **Turning it back on is a launch blocker (OS-732)**: flip the default to `true`,
> `terraform apply`, and click the SNS confirmation email again for each address. A deleted
> subscription doesn't come back confirmed.

## Channels

Two SNS topics, created in `infra/terraform/envs/production/monitoring.tf`:

| Topic | ARN name | Subscribers | Use for |
|---|---|---|---|
| **critical** | `ordersail-alerts-critical` | email (+ SMS once the sandbox is exited) | will page (OS-732) — a human needs to act now |
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

Then `terraform apply` (adds/removes `aws_sns_topic_subscription.email`; none while
`alert_paging_enabled` is `false`), and **click
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
The confirmed email addresses should receive it within a minute. While paging is off, the
topics have no subscribers and the publish goes nowhere.

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

Each row is added or removed by its issue's PR. `→` is the topic the alarm notifies.

| Alarm | Source | Fires when | → |
|---|---|---|---|
| _ECS RunningTaskCount_ | OS-76 `modules/ecs-service` | running < desired for N min (per service) | critical |
| _ECS container-exit rate_ | OS-76 | ≥3 "Essential container … exited" in 15 min | critical |
| _ALB 5xx rate_ `<svc>-alb-error-rate` | OS-77 `modules/alb` | target 5xx / requests > 5% for 5 min (per target group) | critical |
| _ALB ELB 5xx_ `api-alb-5xx` | OS-77, OS-705 | LB-generated 5xx ≥ 5 in 5 min — one alarm for the shared ALB (the metric has no target-group dimension) | critical |
| _ALB p95 latency_ `<svc>-alb-p95-latency` | OS-77 | `TargetResponseTime` p95 > threshold for 10 min (per target group) | warning |
| _ALB unhealthy hosts_ `<svc>-alb-unhealthy-hosts` | OS-77 | `UnHealthyHostCount` > 0 for 3 min (per target group) | critical |
| _RDS free storage_ | OS-78 `modules/rds` | `FreeStorageSpace` < GB floor | critical |
| _RDS CPU / memory / connections_ | OS-78 | sustained high | warning |
| _ElastiCache memory %_ | OS-79 `modules/elasticache` | `DatabaseMemoryUsagePercentage` > 80% for 10 min | critical |
| _ElastiCache evictions_ | OS-79 | `Evictions` > 0 for 5 min | critical |
| _ElastiCache CPU / swap / connections_ | OS-79 | sustained high | warning |
| _Order-job dead-letter_ | OS-73 `apps/worker` | an `orders` job exhausts all 8 attempts | critical |
| _SES bounce rate_ | OS-659 `envs/production/ses.tf` | account `Reputation.BounceRate` > 2% (warning) / > 4% (critical) | warning / critical |
| _SES complaint rate_ | OS-659 `envs/production/ses.tf` | account `Reputation.ComplaintRate` > 0.05% (warning) / > 0.08% (critical) | warning / critical |

The log-based alarms, _alert lines_ and _error lines_ (OS-99), were deleted in OS-731.
They were CloudWatch metric filters on the service log groups, which nothing has written to
since the move to Grafana Cloud Loki (OS-699/OS-700), so they could never fire. They come back
as Grafana Loki alert rules before launch (OS-732).

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

The worker publishes a dead-letter straight to `ordersail-alerts-critical`, but **while paging
is off that topic has no subscribers, so a dead-letter notifies nobody**. Check the
failed-orders view and the `alert: true` lines below. Once paging is back on, that publish is
the only notification; until the Loki alert rule (OS-732) exists, nothing backs it up if it fails.

## `alert: true` lines

A line with `alert: true` means a human has to act. Nothing pages on these yet (OS-732).
Find them in Grafana Cloud Loki:

```logql
{deployment_environment="production"} | json | alert="true"
```

`service_name` shows which service logged it ([Tracing a bug](../observability.md#tracing-a-bug)).
Then follow the `event`:

| `event` | Service | Runbook |
|---|---|---|
| `order_job.dead_lettered` | worker | [When "order-job dead-letter" fires](#when-order-job-dead-letter-fires) above |
| `dispute.opened` | merchant-api | `docs/runbooks/refunds-disputes.md` |

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
   # GNU date; on macOS use: date -u -v-2d +%FT%TZ
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

All four alarms treat missing data as OK. With no mail flowing, including while the environment
is parked by the on/off switch (OS-380), there's no rate and they never fire, so they don't need
disarming in `environment.yml`.

## Email (SES)

How mail leaves production: an API enqueues an email job, and `apps/worker` renders it and
calls the **SES API with its ECS task role** (no SMTP, no credentials, OS-658). It sends
`From: Ordersail <no-reply@ordersail.com>`, a verified domain identity with DKIM, MAIL FROM
`bounce.ordersail.com` and DMARC (OS-657), through the configuration set
`ordersail-transactional` (OS-659). Local dev sends over SMTP to Mailpit instead
(`EMAIL_TRANSPORT=smtp`, http://localhost:8025).

> **The account is still in the SES sandbox** (deliberately, until ~3 weeks before launch,
> OS-61). Only verified addresses receive mail. See
> [Adding a test inbox](#while-in-the-sandbox-adding-a-test-inbox).

A failing email is quiet: nothing alerts on error lines, and no alarm watches email
failures yet (OS-87). On 2026-09-27 a lapsed identity verification silently stopped all prod email. Start
here when someone says an email never arrived.

### 1. Did the worker send it?

Logs Insights, all four service log groups (or `ordersail/Request timeline` with the
request's `x-request-id`):

```
fields @timestamp, event, jobName, err.message, correlationId
| filter event like /^email/
| sort @timestamp desc
```

- **`email.sent`**: SES accepted it. Check the recipient's spam folder, then whether the
  address is suppressed (step 4).
- **`email_job.attempt_failed` → `email_job.failed`**: SES refused it. The `err.message`
  says why (step 2). A job is tried 5 times (backoff 5s → 40s), then gives up.
- **Nothing at all**: the job never ran. Check the worker is up: the
  `ordersail-worker-running-below-desired` alarm, `aws ecs describe-services`, and a boot
  failure (`event = "app.boot_failed"`). A worker that dies at boot stops all email while
  everything else looks healthy.

`jobName` is one of `verify-email`, `password-reset`, `staff-invite`, `order-confirmation`,
`customer-thank-you`.

### 2. Why SES refused it

| `err.message` contains | Cause | Fix |
|---|---|---|
| `Email address is not verified. … identities failed the check: <addr>` | Sandbox: `<addr>` isn't a verified identity, or its verification lapsed (`FAILED`) | `aws sesv2 get-email-identity --email-identity <addr>`, then re-send the link with `aws ses verify-email-identity --email-address <addr>` and click it within 24 h |
| `not authorized to perform 'ses:SendRawEmail' on resource '…:identity/<addr>'` | Sandbox: the worker task role can't send to that recipient | Add `identity/<addr>` to the worker task-role SES statement (`data.aws_iam_policy_document.worker_task`, `envs/production/main.tf`) and apply |
| `… on resource '…:configuration-set/ordersail-transactional'` | The task-role policy lost the configuration-set ARN. The identity's default configuration set is authorized on every send | Restore it in the same statement |
| `… on resource '…:identity/ordersail.com'` | The task-role policy lost the domain identity | Same statement |
| quota / rate limit (`LimitExceeded`, `TooManyRequests`) | Sandbox limits: 200/day, 1/s | Wait for the 24 h window; the real fix is production access (OS-61) |
| sending paused / account suspended | SES reputation enforcement | [When "SES bounce/complaint rate" fires](#when-ses-bouncecomplaint-rate-fires) |

### 3. Account and identity health

```bash
aws sesv2 get-account \
  --query '{production:ProductionAccessEnabled,sending:SendingEnabled,status:EnforcementStatus,quota:SendQuota}'
aws sesv2 list-email-identities
aws sesv2 get-email-identity --email-identity ordersail.com \
  --query '[VerifiedForSendingStatus,DkimAttributes.Status,MailFromAttributes.MailFromDomainStatus,ConfigurationSetName]'
```

Healthy is `sending: true`, `status: HEALTHY`, and
`True SUCCESS SUCCESS ordersail-transactional` for the domain. A DKIM or MAIL FROM status
other than `SUCCESS` means a DNS record in the `ordersail.com` zone changed. They're all in
`envs/production/ses.tf`, and `terraform plan` shows the drift.

### 4. Is the address suppressed?

```bash
aws sesv2 get-suppressed-destination --email-address <addr>
```

SES silently skips an address that hard-bounced or complained. Remove it only when you know
it's good now: `aws sesv2 delete-suppressed-destination --email-address <addr>`.

### Mailboxes (Google Workspace)

People's mail is separate from app mail. The two share `ordersail.com`'s DNS but not the
same servers:

| | Handled by | DNS (Terraform) |
|---|---|---|
| **People's mail**: support@, privacy@, legal@, security@, dmarc@, staff | **Google Workspace** (OS-665) | apex MX `smtp.google.com`, apex SPF `include:_spf.google.com`, DKIM `google._domainkey`, verification TXT, domain-wide DMARC `_dmarc` (`envs/production/mail.tf`) |
| **App mail**: verification, reset, invites, order confirmations | **Amazon SES** as `no-reply@ordersail.com` | SES DKIM CNAMEs, MAIL FROM `bounce.ordersail.com` (`envs/production/ses.tf`) |

- **The role addresses are Google Groups** on one paid seat, with the owner as a member and
  anyone on the web allowed to post. To add someone, add them to the group in the Workspace
  admin console; a new person needs a paid seat only if they want their own inbox.
- **Adding an address:** for a new role address (e.g. `billing@`), create a Google Group in
  Admin console → Directory → Groups, add the owner, and set "who can post" to anyone on the
  web. For a second name on an existing inbox, add an alias instead: Directory → Users (or
  Groups) → the user or group → Add alternate email. **Neither needs a Terraform or DNS
  change**, since the MX already covers all of `@ordersail.com`.
- **A mail "never arrived" at support@ etc.:** check the group's "who can post" setting and its
  spam moderation queue (Groups → the group → Pending messages), then `dig MX ordersail.com`.
- **DMARC aggregate reports** (`rua`) land in `dmarc@`, one XML attachment per receiver per
  day. They show which servers send as `ordersail.com` and whether SPF and DKIM pass. Read them
  before tightening `p=none` (OS-662).
- **Replying as support@:** set it up as a "Send mail as" address in the owner's Gmail. Mail sent
  that way is DKIM-signed by Google with `d=ordersail.com`, so it passes DMARC.

### While in the sandbox: adding a test inbox

Each test recipient needs **both** of these, or its emails fail:

1. Verify it: `aws ses verify-email-identity --email-address <addr>`, and click the link AWS
   emails within 24 h. Check with `aws sesv2 get-email-identity --email-identity <addr>`.
2. Let the worker send to it: add
   `"arn:${data.aws_partition.current.partition}:ses:${var.region}:${data.aws_caller_identity.current.account_id}:identity/<addr>"`
   to the worker task-role SES statement in `envs/production/main.tf`, then plan and apply
   **from an up-to-date `main`**. In the sandbox, SES authorizes a send against the
   recipient's identity as well as the sender's.

Once production access is granted (OS-61), neither step is needed, and the extra identities
and ARNs get removed.
