import { envSchema } from './env.schema';

describe('envSchema — OpenTelemetry export', () => {
  const otel = envSchema.pick({
    OTEL_EXPORTER_OTLP_ENDPOINT: true,
    OTEL_EXPORTER_OTLP_HEADERS: true,
  });

  it('reads an empty value as unset, the way packages/tracing does', () => {
    expect(
      otel.parse({
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
        OTEL_EXPORTER_OTLP_HEADERS: '',
      }),
    ).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
      OTEL_EXPORTER_OTLP_HEADERS: undefined,
    });
    expect(otel.parse({})).toEqual({});
  });

  it('keeps a set endpoint and rejects one that is not a URL', () => {
    expect(
      otel.parse({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })
        .OTEL_EXPORTER_OTLP_ENDPOINT,
    ).toBe('http://localhost:4318');
    expect(() =>
      otel.parse({ OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' }),
    ).toThrow();
  });
});
