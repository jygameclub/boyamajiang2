function seedToUint32(seed) {
  const text = String(seed ?? "0");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createSeededRng(seed) {
  let state = seedToUint32(seed);
  return {
    nextUint32() {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return (value ^ (value >>> 14)) >>> 0;
    },
    next() {
      return this.nextUint32() / 0x100000000;
    },
    int(maxExclusive) {
      const max = Math.trunc(Number(maxExclusive));
      if (max <= 0) throw new RangeError("maxExclusive must be positive");
      return Math.floor(this.next() * max);
    }
  };
}

export function weightedChoice(rng, entries) {
  const normalized = entries
    .map(([value, weight]) => [value, Math.max(0, Number(weight) || 0)])
    .filter(([, weight]) => weight > 0);
  const total = normalized.reduce((sum, [, weight]) => sum + weight, 0);
  if (!normalized.length || total <= 0) {
    throw new Error("At least one positive weight is required");
  }
  let cursor = rng.next() * total;
  for (const [value, weight] of normalized) {
    cursor -= weight;
    if (cursor < 0) return value;
  }
  return normalized.at(-1)[0];
}

