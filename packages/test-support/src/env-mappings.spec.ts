import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { taskDefEnvNames, unmappedEnvKeys } from './env-mappings.ts';

// The guard is only worth having if it still catches what it was written for,
// so these replay each case against the same functions the app specs use.

const HCL = `
module "ecs_service_demo_api" {
  source = "../../modules/ecs-service"
  name   = "demo-api"

  environment = [
    { name = "NODE_ENV", value = "production" },
    # a comment with { braces } must not end the block early
    { name = "REDIS_HOST", value = local.redis_host },
  ]

  secrets = [
    { name = "DATABASE_URL", valueFrom = module.secrets.database_url_secret_arn },
    { name = "API_SECRET", valueFrom = "\${module.secrets.app_secret_arns["demo-api"]}:API_SECRET::" },
  ]
}

module "ecs_service_other_api" {
  environment = [
    { name = "ONLY_IN_OTHER", value = "x" },
  ]
}
`;

describe('taskDefEnvNames', () => {
  it('reads environment and secrets names from one module block only', () => {
    assert.deepEqual(
      [...taskDefEnvNames(HCL, 'ecs_service_demo_api')].sort(),
      ['API_SECRET', 'DATABASE_URL', 'NODE_ENV', 'REDIS_HOST'],
    );
  });

  it("does not mistake the module's own name attribute for an env var", () => {
    assert.ok(!taskDefEnvNames(HCL, 'ecs_service_demo_api').has('demo-api'));
  });

  it('throws on an unknown module rather than reporting everything unmapped', () => {
    assert.throws(() => taskDefEnvNames(HCL, 'ecs_service_missing'), /no module "ecs_service_missing"/);
  });
});

describe('unmappedEnvKeys', () => {
  const mapped = taskDefEnvNames(HCL, 'ecs_service_demo_api');

  it('catches an unmapped required key (the OS-652 shape, one step earlier)', () => {
    const schema = z.object({ DATABASE_URL: z.url(), NEW_REQUIRED_KEY: z.string() });
    const found = unmappedEnvKeys(Object.keys(schema.shape), mapped, {});
    assert.deepEqual(found.map((p) => p.variable), ['NEW_REQUIRED_KEY']);
  });

  it('catches an unmapped key with a localhost default (dev default reaching production)', () => {
    const schema = z.object({ SMTP_HOST: z.string().default('localhost') });
    const found = unmappedEnvKeys(Object.keys(schema.shape), mapped, {});
    assert.deepEqual(found.map((p) => p.variable), ['SMTP_HOST']);
  });

  it('passes mapped keys (environment or secrets) and allowlisted keys', () => {
    const schema = z.object({
      NODE_ENV: z.string(),
      API_SECRET: z.string(),
      LOG_LEVEL: z.string().optional(),
    });
    assert.deepEqual(unmappedEnvKeys(Object.keys(schema.shape), mapped, { LOG_LEVEL: 'unset → info' }), []);
  });

  it('flags a stale allowlist entry — one since mapped, or gone from the schema', () => {
    const found = unmappedEnvKeys(['NODE_ENV'], mapped, { NODE_ENV: 'stale', REMOVED_KEY: 'stale' });
    assert.deepEqual(found.map((p) => p.variable).sort(), ['NODE_ENV', 'REMOVED_KEY']);
  });
});
