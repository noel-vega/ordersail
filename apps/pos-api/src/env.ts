import { parseEnv } from "config";
import { envSchema } from "./env.schema";

// Parsed once, on import. `main.ts` imports this module first so a bad env
// fails before Nest wires anything up.
export const env = parseEnv("pos-api", envSchema);
