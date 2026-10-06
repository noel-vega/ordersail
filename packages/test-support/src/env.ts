// Snapshots the named environment variables and returns what puts them back,
// for a spec that sets them freely: `after(saveEnv([...]))`. A key that was
// unset is deleted again rather than left as the string "undefined". Imports
// nothing, so node:test specs outside Jest can load it (`test-support/env`).
export function saveEnv(keys: readonly string[]): () => void {
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
