import { checkEnvMappings } from 'test-support';
import { envSchema } from './env.schema';

// Every env var worker reads must be mapped in its production task def
// (infra/terraform/envs/production/main.tf), or be listed here with the reason
// it is fine unset in production (OS-655). A missing mapping otherwise ships
// green and only fails at boot. Checklist: infra/terraform/README.md.
const FINE_UNSET_IN_PRODUCTION: Record<string, string> = {
  LOG_LEVEL: 'unset → info in production (docs/observability.md)',
  SMTP_HOST:
    'read only when EMAIL_TRANSPORT=smtp (local Mailpit); production is ses',
  SMTP_PORT:
    'read only when EMAIL_TRANSPORT=smtp (local Mailpit); production is ses',
};

describe('worker env → production task def', () => {
  it('maps every env schema key, or allowlists it with a reason', () => {
    expect(
      checkEnvMappings({
        moduleName: 'ecs_service_worker',
        schemaKeys: Object.keys(envSchema.shape),
        allow: FINE_UNSET_IN_PRODUCTION,
      }),
    ).toEqual([]);
  });
});
