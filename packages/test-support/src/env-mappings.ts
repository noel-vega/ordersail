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
 * If a `"…"` string literal opens at `i`, the index just past it; otherwise `i`.
 * Steps over escapes and `${…}` interpolations, which may nest their own quotes
 * (`"${module.secrets.app_secret_arns["demo-api"]}:KEY::"`). `$${` and `%%{`
 * are HCL's escapes for a literal `${` / `%{` (common in IAM policy strings),
 * not interpolations, so they open nothing.
 */
function skipString(hcl: string, i: number): number {
  if (hcl[i] !== '"') return i;
  for (let j = i + 1; j < hcl.length; j++) {
    if (hcl[j] === '\\') j++;
    else if (hcl[j] === '"') return j + 1;
    else if (hcl.startsWith('$${', j) || hcl.startsWith('%%{', j)) j += 2;
    else if (hcl.startsWith('${', j)) {
      const close = skipBlock(hcl, j + 2);
      if (close === -1) return hcl.length;
      j = close - 1;
    }
  }
  return hcl.length;
}

/**
 * From just inside an opening brace, the index just past its matching close,
 * or -1 if it never closes. Braces in strings don't count.
 */
function skipBlock(hcl: string, i: number): number {
  let depth = 1;
  while (i < hcl.length) {
    const next = skipString(hcl, i);
    if (next > i) {
      i = next;
      continue;
    }
    if (hcl[i] === '{') depth++;
    else if (hcl[i] === '}' && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}

/**
 * `hcl` with its `#`, `//` and `/* … *\/` comments removed, string literals
 * intact. A commented-out mapping must read as unmapped, and a stray brace in
 * a comment must not move a block's end.
 */
function stripComments(hcl: string): string {
  let out = '';
  let i = 0;
  while (i < hcl.length) {
    const next = skipString(hcl, i);
    if (next > i) {
      out += hcl.slice(i, next);
      i = next;
    } else if (hcl[i] === '#' || hcl.startsWith('//', i)) {
      const eol = hcl.indexOf('\n', i);
      i = eol === -1 ? hcl.length : eol;
    } else if (hcl.startsWith('/*', i)) {
      const close = hcl.indexOf('*/', i + 2);
      i = close === -1 ? hcl.length : close + 2;
      out += ' ';
    } else {
      out += hcl[i++];
    }
  }
  return out;
}

/**
 * Env var names mapped in a `module "<moduleName>" { … }` block — every
 * `{ name = "X", value = … }` (environment) and `{ name = "X", valueFrom = … }`
 * (secrets) entry. Matching the `, value` / `, valueFrom` tail keeps the
 * module's own `name = "merchant-api"` attribute out. Comments are stripped
 * first, so a commented-out entry reads as unmapped.
 */
export function taskDefEnvNames(hcl: string, moduleName: string): Set<string> {
  const code = stripComments(hcl);
  const header = `module "${moduleName}" {`;
  const start = code.indexOf(header);
  if (start === -1) throw new Error(`no ${header} block`);

  const end = skipBlock(code, start + header.length);
  const block = end === -1 ? code.slice(start) : code.slice(start, end);

  // The brace walk doesn't model everything HCL can hold (heredocs, say). If
  // it overshoots, the block swallows the next top-level block, and a key
  // mapped only *there* would count as mapped here — a silent pass. terraform
  // fmt keeps top-level blocks at column 0 and everything inside indented, so
  // a column-0 block header inside the slice means the walk went wrong: fail
  // loudly instead.
  const overran = /\n(?:module|resource|data|locals|variable|output|provider|terraform)\b/.exec(block);
  if (end === -1 || overran) {
    throw new Error(`could not find where ${header} ends — the brace walk ${overran ? `ran into "${overran[0].trim()}"` : 'hit end of file'}; see taskDefEnvNames`);
  }

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
export function envMappingProblems(
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
  return envMappingProblems(opts.schemaKeys, mapped, opts.allow);
}
