import { checkEnvMappings } from "test-support";
import { envSchema } from "./env.schema";

// Every env var pos-api reads must be mapped in its production task def
// (infra/terraform/envs/production/main.tf), or be listed here with the reason
// it is fine unset in production (OS-655). A missing mapping otherwise ships
// green and only fails at boot. Checklist: infra/terraform/README.md.
const FINE_UNSET_IN_PRODUCTION: Record<string, string> = {
  POS_WEB_URL:
    "the POS is a native app with no browser Origin; unset → CORS origin:true (see main.tf)",
  LOG_LEVEL: "unset → info in production (docs/observability.md)",
};

describe("pos-api env → production task def", () => {
  it("maps every env schema key, or allowlists it with a reason", () => {
    expect(
      checkEnvMappings({
        moduleName: "ecs_service_pos_api",
        schemaKeys: Object.keys(envSchema.shape),
        allow: FINE_UNSET_IN_PRODUCTION,
      }),
    ).toEqual([]);
  });
});
