import { checkEnvMappings } from 'test-support';
import { envSchema } from './env.schema';

// Every env var merchant-api reads must be mapped in its production task def
// (infra/terraform/envs/production/main.tf), or be listed here with the reason
// it is fine unset in production (OS-655). A missing mapping otherwise ships
// green and only fails at boot. Checklist: infra/terraform/README.md.
const FINE_UNSET_IN_PRODUCTION: Record<string, string> = {
  WEBAUTHN_RP_ID:
    'derived from MERCHANT_WEB_URL when unset (identity/auth/webauthn.config.ts); set only to change the RP ID deliberately',
  WEBAUTHN_ORIGINS: 'derived from MERCHANT_WEB_URL when unset',
  WEBAUTHN_RP_NAME: "the default 'OrderSail' is the production value",
  MINIO_ACCESS_KEY: 'S3 credentials come from the ECS task role in production',
  MINIO_SECRET_KEY: 'S3 credentials come from the ECS task role in production',
  LOG_LEVEL: 'unset → info in production (docs/observability.md)',
  OTEL_EXPORTER_OTLP_ENDPOINT:
    'unset → tracing is off; production export is mapped in OS-97',
  OTEL_EXPORTER_OTLP_HEADERS:
    'only needed with OTEL_EXPORTER_OTLP_ENDPOINT; mapped as a secret in OS-97',
};

describe('merchant-api env → production task def', () => {
  it('maps every env schema key, or allowlists it with a reason', () => {
    expect(
      checkEnvMappings({
        moduleName: 'ecs_service_merchant_api',
        schemaKeys: Object.keys(envSchema.shape),
        allow: FINE_UNSET_IN_PRODUCTION,
      }),
    ).toEqual([]);
  });
});
