// Verify every production task-definition contract before anything is deployed.
//
// Terraform renders each service's task definition and publishes it to SSM
// (/ordersail/production/ecs/<app>-taskdef); cd.yml reads that, swaps in the
// freshly-built image tag, and registers it. Terraform can prove the contract
// is well-formed, but not that it will actually *boot* — three things slip
// through, and all three have taken production down or broken a feature:
//
//   1. A `secrets[].valueFrom` naming a JSON key that doesn't exist in the
//      target secret. Terraform validates the mapping, never the contents
//      (deliberately — values must not enter state or git). merchant-api
//      crash-looped on a missing MFA_ENCRYPTION_KEY (OS-652).
//
//   2. A dev default reaching production. Every app's zod schema defaults
//      REDIS_HOST to 'localhost'; a var that falls through to its default
//      *passes* validation and fails at runtime, so there is no boot error.
//
//   3. A raw AWS-generated hostname where a custom domain belongs. The nastiest
//      of the three, because nothing fails at all: the value is a real,
//      reachable HTTPS host. It only breaks when something compares it against
//      the address a user is actually on — MERCHANT_WEB_URL pointed at the
//      CloudFront domain, so the WebAuthn RP ID derived from it made the
//      browser reject every passkey ceremony (OS-654). The same shape produced
//      a wrong `storefront_api_url` output and months of `curl -k` in the
//      deploy workflows (OS-560).
//
// Usage:
//   node scripts/verify-taskdef-contracts.mjs              # check real production (needs AWS creds)
//   node scripts/verify-taskdef-contracts.mjs --self-test  # prove the checks catch each defect (no AWS)
//
// Never prints a secret value — only key names.

import { execFileSync } from 'node:child_process';

// Every contract published under SSM_PREFIX (ssm.tf `ssm_ecs_taskdef`). The
// migrator counts: migrate.yml registers it from its contract and runs it
// before any service deploys, so it is the first thing CD starts.
const APPS = ['merchant-api', 'storefront-api', 'worker', 'pos-api', 'migrator'];
const SSM_PREFIX = '/ordersail/production/ecs';

// Hostnames AWS generates for edge/load-balancing resources that always have a
// custom-domain alternative. Deliberately NOT a blanket *.amazonaws.com match:
// internal endpoints are generated too and are correct as-is — ElastiCache
// (REDIS_HOST) and RDS are never reached by a browser and have no alias.
const RAW_AWS_HOSTS = ['.cloudfront.net', '.elb.amazonaws.com'];

// ---------------------------------------------------------------- pure checks

// arn:aws:secretsmanager:<region>:<acct>:secret:<name>-<suffix>:<jsonKey>:<stage>:<versionId>
// The secret name may contain '/' but never ':', so splitting on ':' is safe.
export function parseValueFrom(valueFrom) {
  const parts = valueFrom.split(':');
  return { secretArn: parts.slice(0, 7).join(':'), jsonKey: parts[7] || null };
}

// `resolveKeys(secretArn)` returns a Set of JSON keys, null for a plain-string
// secret, or undefined when the secret can't be read. Injected so the checks
// stay pure and testable without AWS.
export function checkContract(app, container, resolveKeys) {
  const problems = [];
  const note = (variable, detail, fix) => problems.push({ app, variable, detail, fix });

  for (const { name, valueFrom } of container.secrets ?? []) {
    const { secretArn, jsonKey } = parseValueFrom(valueFrom);
    const keys = resolveKeys(secretArn);

    if (keys === undefined) {
      note(name, `secret is unreadable: ${secretArn}`, 'check the secret exists and CI can read it');
    } else if (jsonKey === null) {
      // No JSON key means the whole secret string is the value — reading it at
      // all proves it exists, so there is nothing further to assert.
    } else if (keys === null) {
      note(name, `expects JSON key "${jsonKey}" but the secret is a plain string`, 'fix the valueFrom mapping, or store the secret as JSON');
    } else if (!keys.has(jsonKey)) {
      note(name, `JSON key "${jsonKey}" is absent from ${secretArn.split(':secret:')[1]}`, `add "${jsonKey}" to that secret — the container exits at boot without it`);
    }
  }

  for (const { name, value } of container.environment ?? []) {
    const v = String(value ?? '');

    if (v.includes('localhost') || v.includes('127.0.0.1')) {
      note(name, `points at localhost in production: "${v}"`, 'set the real value — a defaulted var passes validation and fails at runtime');
    }

    const rawHost = RAW_AWS_HOSTS.find((suffix) => v.includes(suffix));
    if (rawHost) {
      note(name, `uses a raw AWS-generated hostname: "${v}"`, `use the custom domain — a ${rawHost} name is reachable, so nothing errors; it just never matches the address users are on`);
    }
  }

  return problems;
}

function report(problems, checkedCount) {
  if (problems.length === 0) {
    console.log(`\nall ${checkedCount} task-def contracts are deployable`);
    return 0;
  }
  console.error(`\n${problems.length} problem(s) — refusing to deploy:\n`);
  for (const { app, variable, detail, fix } of problems) {
    console.error(`  ${app} / ${variable}`);
    console.error(`    ${detail}`);
    console.error(`    fix: ${fix}\n`);
  }
  return 1;
}

// ------------------------------------------------------------------ self-test

// Each fixture is a defect that actually reached production. If a change to the
// checks stops catching one of these, this fails — which is the point: the
// guard is only worth having if it still catches what it was written for.
function selfTest() {
  const cases = [
    {
      name: 'OS-652 — secret JSON key absent (merchant-api crash-looped)',
      container: {
        secrets: [{ name: 'MFA_ENCRYPTION_KEY', valueFrom: 'arn:aws:secretsmanager:us-east-1:1:secret:ordersail/production/merchant-api-AAAA:MFA_ENCRYPTION_KEY::' }],
      },
      resolveKeys: () => new Set(['STAFF_JWT_SECRET', 'STRIPE_SECRET_KEY']),
      expect: 'MFA_ENCRYPTION_KEY',
    },
    {
      name: 'OS-654 — raw CloudFront domain as a user-facing URL (passkeys broken)',
      container: {
        environment: [{ name: 'MERCHANT_WEB_URL', value: 'https://d2bcbtjs5p1jfd.cloudfront.net' }],
      },
      resolveKeys: () => new Set(),
      expect: 'MERCHANT_WEB_URL',
    },
    {
      name: 'OS-560 shape — raw ALB name as a user-facing URL',
      container: {
        environment: [{ name: 'SOME_API_URL', value: 'https://ordersail-storefront-api-1.us-east-1.elb.amazonaws.com' }],
      },
      resolveKeys: () => new Set(),
      expect: 'SOME_API_URL',
    },
    {
      name: 'dev default reaching production',
      container: { environment: [{ name: 'REDIS_HOST', value: 'localhost' }] },
      resolveKeys: () => new Set(),
      expect: 'REDIS_HOST',
    },
    {
      name: 'a correct contract stays green (no false positives)',
      container: {
        environment: [
          { name: 'MERCHANT_WEB_URL', value: 'https://merchant.ordersail.com' },
          // an internal AWS-generated endpoint must NOT be flagged
          { name: 'REDIS_HOST', value: 'ordersail-production.yaqbmn.0001.use1.cache.amazonaws.com' },
        ],
        secrets: [
          { name: 'STAFF_JWT_SECRET', valueFrom: 'arn:aws:secretsmanager:us-east-1:1:secret:ordersail/production/merchant-api-AAAA:STAFF_JWT_SECRET::' },
          // a plain-string secret carries no JSON key and must not be flagged
          { name: 'DATABASE_URL', valueFrom: 'arn:aws:secretsmanager:us-east-1:1:secret:ordersail/production/database-url-BBBB' },
        ],
      },
      resolveKeys: (arn) => (arn.includes('database-url') ? null : new Set(['STAFF_JWT_SECRET'])),
      expect: null,
    },
  ];

  let failed = 0;
  for (const { name, container, resolveKeys, expect } of cases) {
    const found = checkContract('fixture', container, resolveKeys);
    const caught = found.map((p) => p.variable);
    const ok = expect === null ? caught.length === 0 : caught.includes(expect);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) {
      failed++;
      console.error(`      expected ${expect === null ? 'no findings' : `to catch ${expect}`}, got [${caught.join(', ')}]`);
    }
  }
  console.log(failed === 0 ? '\nself-test passed' : `\n${failed} self-test case(s) failed`);
  return failed === 0 ? 0 : 1;
}

// ----------------------------------------------------------------------- main

function checkProduction() {
  const aws = (...args) =>
    execFileSync('aws', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();

  // Secret contents are fetched once per secret and reduced to key names
  // immediately — values are never retained or logged.
  const cache = new Map();
  const resolveKeys = (secretArn) => {
    if (cache.has(secretArn)) return cache.get(secretArn);
    let keys;
    try {
      const raw = aws('secretsmanager', 'get-secret-value', '--secret-id', secretArn, '--query', 'SecretString', '--output', 'text');
      // A secret is either a JSON object of keys or a single opaque string
      // (DATABASE_URL is the latter, shared by all four services).
      keys = raw.startsWith('{') ? new Set(Object.keys(JSON.parse(raw))) : null;
    } catch {
      keys = undefined;
    }
    cache.set(secretArn, keys);
    return keys;
  };

  const problems = [];
  for (const app of APPS) {
    let contract;
    try {
      contract = JSON.parse(aws('ssm', 'get-parameter', '--name', `${SSM_PREFIX}/${app}-taskdef`, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'));
    } catch {
      problems.push({ app, variable: '(contract)', detail: `no task-def contract at ${SSM_PREFIX}/${app}-taskdef`, fix: 'apply Terraform for envs/production' });
      continue;
    }
    const container = contract.containerDefinitions?.[0];
    if (!container) {
      problems.push({ app, variable: '(contract)', detail: 'contract has no containerDefinitions[0]', fix: 'check the Terraform task-definition template' });
      continue;
    }
    problems.push(...checkContract(app, container, resolveKeys));
    console.log(`checked ${app}`);
  }
  return report(problems, APPS.length);
}

process.exit(process.argv.includes('--self-test') ? selfTest() : checkProduction());
