/** Mulberry32 seeded PRNG for deterministic synthetic benchmarks. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a random element; throws on an empty list (no silent undefined). */
export function pick<T>(r: () => number, xs: readonly T[]): T {
  const v = xs[Math.floor(r() * xs.length)];
  if (v === undefined) throw new Error('pick: empty list');
  return v;
}
