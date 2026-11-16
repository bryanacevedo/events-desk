/* Exact tests, no dependency. The same table definition as Account Desk's stats.py (docs/CHOOSING.md section 8). */

const choose = (n: bigint, r: bigint): bigint => {
  if (r < 0n || r > n) return 0n;
  if (r > n - r) r = n - r;
  let out = 1n;
  for (let i = 1n; i <= r; i++) out = (out * (n - r + i)) / i;
  return out;
};

/** One-sided Fisher exact test: the chance of k or more of the m successes landing in a group of n_in, out of `total`, if the group made no difference
    (the hypergeometric upper tail). The 2x2 table is [[k, n_in - k], [m - k, total - n_in - m + k]]. Throws on an impossible table. */
export function fisherGreater(k: number, nIn: number, m: number, total: number): number {
  const ints = [k, nIn, m, total];
  if (!ints.every(Number.isInteger) || !(0 <= k && k <= m && m <= total && k <= nIn && nIn <= total) || total - nIn - m + k < 0) throw new Error("not a 2x2 table");
  const [K, N, M, T] = ints.map(BigInt);
  const top = M < N ? M : N;
  let hits = 0n;
  for (let x = K; x <= top; x++) hits += choose(M, x) * choose(T - M, N - x);
  const all = choose(T, N);
  // Both are exact integers; the quotient is taken once, scaled, so a tiny tail does not underflow.
  const scale = 10n ** 18n;
  return Number((hits * scale) / all) / 1e18;
}
