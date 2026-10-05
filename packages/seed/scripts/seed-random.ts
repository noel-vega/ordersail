// A tiny deterministic PRNG for the seed's generated data (customers, order
// history). Same seed → same sequence, so every `npm run reset` produces the
// same demo store. No faker: the seed's word lists are small and hard-coded.

export const SEED = 20261004;

export interface Rng {
  /** float in [0, 1) */
  next(): number;
  /** integer in [min, max], inclusive */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** picks items[i] with probability weights[i] / sum(weights) */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** true with probability p */
  chance(p: number): boolean;
}

// mulberry32 — a 32-bit generator; plenty for demo data, not for anything
// security-relevant. `salt` gives each consumer its own stream, so adding a
// draw in one module doesn't reshuffle another's output.
export function createRng(salt = 0): Rng {
  let state = (SEED + salt) >>> 0;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    pick: (items) => items[int(0, items.length - 1)],
    weighted: (items, weights) => {
      const total = weights.reduce((sum, w) => sum + w, 0);
      let roll = next() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i];
        if (roll < 0) return items[i];
      }
      return items[items.length - 1];
    },
    chance: (p) => next() < p,
  };
}
