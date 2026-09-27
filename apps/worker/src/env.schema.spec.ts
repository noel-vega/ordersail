import { envSchema } from './env.schema';

const base = { DATABASE_URL: 'postgres://postgres@localhost:5432/ordersail' };

describe('worker env schema — email transport', () => {
  it('refuses to boot in production on the localhost smtp default', () => {
    const result = envSchema.safeParse({ ...base, NODE_ENV: 'production' });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['EMAIL_TRANSPORT'],
        message: 'must be "ses" in production',
      }),
    ]);
  });

  it('accepts ses in production', () => {
    const result = envSchema.safeParse({
      ...base,
      NODE_ENV: 'production',
      EMAIL_TRANSPORT: 'ses',
    });

    expect(result.success).toBe(true);
  });

  it('defaults to smtp against local Mailpit outside production', () => {
    const result = envSchema.safeParse(base);

    expect(result.data).toMatchObject({
      EMAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'localhost',
      SMTP_PORT: 1025,
    });
  });
});
