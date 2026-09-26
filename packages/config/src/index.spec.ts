import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// parseEnv exits the process, so run it in a child and read what it wrote
describe('parseEnv', () => {
  const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url));

  function run(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const script = `
      import { parseEnv, z } from ${JSON.stringify(indexPath)};
      const env = parseEnv('test-service', z.object({ DATABASE_URL: z.url(), PORT: z.coerce.number() }));
      console.log(JSON.stringify({ parsed: env }));
    `;
    // a cwd with no .env, so dotenv doesn't mix in a developer's real values
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  }

  it('returns the parsed env when it is valid', async () => {
    const { code, stdout } = await run({ DATABASE_URL: 'postgres://localhost/db', PORT: '3000' });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout).parsed, { DATABASE_URL: 'postgres://localhost/db', PORT: 3000 });
  });

  it('an invalid env logs one fatal app.boot_failed JSON line naming the vars, never their values, and exits 1', async () => {
    const { code, stdout, stderr } = await run({ DATABASE_URL: 'not-a-url-s3cret', PORT: '3000' });
    assert.equal(code, 1);
    assert.equal(stderr, '');
    const lines = stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 60);
    assert.equal(lines[0].event, 'app.boot_failed');
    assert.equal(lines[0].service, 'test-service');
    assert.deepEqual(lines[0].issues.map((issue: { path: string }) => issue.path), ['DATABASE_URL']);
    assert.match(lines[0].err.message, /DATABASE_URL/);
    assert.doesNotMatch(stdout, /s3cret/);
  });
});
