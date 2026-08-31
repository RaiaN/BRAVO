export const feasibleKs = (N, { kMin = 2, kMax = 4, dMin = 5, dMax }) => {
  const out = [];
  if (!Number.isInteger(N)) return out;
  for (let k = kMin; k <= kMax; k += 1) {
    if (N >= k * dMin && N <= k * dMax) out.push(k);
  }
  return out;
};

export const feasibility = (N, { kMin = 2, kMax = 4, dMin = 5, dMax }, preferredK = null) => {
  if (!Number.isInteger(N) || N <= 0) return { ok: false, reason: `target seconds must be a positive integer, got ${JSON.stringify(N)}` };
  if (!Number.isInteger(dMax) || dMax < dMin) return { ok: false, reason: `slot window [${dMin}, ${dMax}] is empty` };
  const lo = kMin * dMin;
  const hi = kMax * dMax;
  if (N < lo || N > hi) {
    return { ok: false, reason: `N=${N} is outside [${lo}, ${hi}]: ${kMin}..${kMax} shots of ${dMin}..${dMax}s can only cover that range` };
  }
  const ks = feasibleKs(N, { kMin, kMax, dMin, dMax });
  const order = preferredK && ks.includes(preferredK) ? [preferredK, ...ks.filter((k) => k !== preferredK)] : ks;
  for (const k of order) {
    const base = Math.floor(N / k);
    const extra = N - base * k;
    const partition = Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
    if (partition.every((d) => d >= dMin && d <= dMax)) return { ok: true, k, partition };
  }
  return { ok: false, reason: `no k in ${kMin}..${kMax} admits a partition of ${N} within [${dMin}, ${dMax}]` };
};

export const validatePartition = (N, durations, { kMin = 2, kMax = 4, dMin = 5, dMax }) => {
  if (!Array.isArray(durations) || !durations.length) return { ok: false, reason: 'no durations' };
  if (durations.length < kMin || durations.length > kMax) return { ok: false, reason: `${durations.length} shots, allowed ${kMin}..${kMax}` };
  const bad = durations.filter((d) => !Number.isInteger(d) || d < dMin || d > dMax);
  if (bad.length) return { ok: false, reason: `durations out of [${dMin}, ${dMax}]: ${bad.join(', ')}` };
  const sum = durations.reduce((a, b) => a + b, 0);
  if (sum !== N) return { ok: false, reason: `durations sum to ${sum}, target is ${N}` };
  return { ok: true };
};
