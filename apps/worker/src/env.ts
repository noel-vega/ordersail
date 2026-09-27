import { parseEnv } from 'config';
import { envSchema } from './env.schema';

// Parsed once, on import. `main.ts` imports this module first so a bad env
// fails before Nest wires anything up. Schema mirrors the old `?? default`
// fallbacks 1:1 — no behaviour change for a valid env.
export const env = parseEnv('worker', envSchema);
