import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// A PR-time check that every key in an app's zod env schema has a mapping in
// that app's production task definition (OS-655). The deploy-time guard
// (scripts/verify-taskdef-contracts.mjs, OS-653) only sees what is already in
// the contract — it cannot notice a var that was never mapped at all, which
// ships green and exits at boot in production.
//
// Every key must be mapped, not just the required ones: a `.default()` key is
// exactly the "dev default reaching production" case (REDIS_HOST defaulting to
// 'localhost'). Keys that are genuinely fine unset in production go on the
// app's explicit allowlist, each with a reason.

const TASKDEF_FILE = 'infra/terraform/envs/production/main.tf';

/**
 * Env var names mapped in a `module "<moduleName>" { … }` block — every
 * `{ name = "X", value = … }` (environment) and `{ name = "X", valueFrom = … }`
 * (secrets) entry. Matching the `, value` / `, valueFrom` tail keeps the
 * module's own `name = "merchant-api"` attribute out.
 */
export function taskDefEnvNames(hcl: string, moduleName: string): Set<string> {
  const header = `module "${moduleName}" {`;
  const start = hcl.indexOf(header);
  if (start === -1) throw new Error(`no ${header} block`);

  // walk to the block's matching close brace
  let depth = 0;
  let end = start + header.length - 1;
  for (; end < hcl.length; end++) {
    if (hcl[end] === '{') depth++;
    else if (hcl[end] === '}' && --depth === 0) break;
  }
  const block = hcl.slice(start, end);

  const names = new Set<string>();
  for (const m of block.matchAll(/\{\s*name\s*=\s*"([A-Za-z0-9_]+)"\s*,\s*value(?:From)?\s*=/g)) {
    names.add(m[1]);
  }
  return names;
}

export interface EnvMappingProblem {
  variable: string;
  problem: string;
}

/**
 * Compare schema keys against the task def's mapped names. Also reports stale
 * allowlist entries (a key since mapped, or no longer in the schema), so the
 * allowlist can't quietly outlive its reasons.
 */
export function unmappedEnvKeys(
  schemaKeys: Iterable<string>,
  mapped: Set<string>,
  allow: Record<string, string>,
): EnvMappingProblem[] {
  const keys = new Set(schemaKeys);
  const problems: EnvMappingProblem[] = [];

  for (const key of keys) {
    if (!mapped.has(key) && !(key in allow)) {
      problems.push({ variable: key, problem: `not mapped in the production task def — add it to environment/secrets in ${TASKDEF_FILE}, or allowlist it with a reason` });
    }
  }
  for (const key of Object.keys(allow)) {
    if (mapped.has(key)) problems.push({ variable: key, problem: 'allowlisted but mapped — drop it from the allowlist' });
    else if (!keys.has(key)) problems.push({ variable: key, problem: 'allowlisted but not in the env schema — drop it from the allowlist' });
  }
  return problems;
}

/** Read the production task defs from the workspace root (found via nx.json). */
export function readTaskDefHcl(from = process.cwd()): string {
  let dir = from;
  while (!existsSync(join(dir, 'nx.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no nx.json above ${from}`);
    dir = parent;
  }
  return readFileSync(join(dir, TASKDEF_FILE), 'utf8');
}

/**
 * Everything an app's env-mapping spec needs: the problems for `schemaKeys`
 * against `module "<moduleName>"` in the real production main.tf. Empty = OK.
 */
export function checkEnvMappings(opts: {
  moduleName: string;
  schemaKeys: Iterable<string>;
  allow: Record<string, string>;
}): EnvMappingProblem[] {
  const mapped = taskDefEnvNames(readTaskDefHcl(), opts.moduleName);
  return unmappedEnvKeys(opts.schemaKeys, mapped, opts.allow);
}
