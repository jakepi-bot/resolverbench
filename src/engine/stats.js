'use strict';
/**
 * Latency statistics.
 *
 * GRC's DNS Benchmark reports an average per nameserver and states that its
 * conclusions are drawn at a 95% confidence threshold. Doing that properly
 * needs more than a mean: with DNS timings the distribution is right-skewed
 * (an occasional 300 ms retransmit sits next to 12 ms hits), so a mean alone
 * makes two resolvers look different when the samples overlap.
 *
 * We therefore report median/stdev/p95 alongside the mean, and pair every
 * "X is faster than Y" claim with Welch's t-test on the same samples.
 */

/** Sample standard deviation (n-1). Zero for n < 2. */
function stdev(values) {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  const ss = values.reduce((acc, v) => acc + (v - m) ** 2, 0);
  return Math.sqrt(ss / (n - 1));
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Linear-interpolated percentile, p in [0,1]. */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Summarise one metric (a list of successful sample latencies in ms).
 * `lost` counts samples that never produced a usable reply.
 */
function summarize(samples, lost = 0) {
  const clean = samples.filter((v) => Number.isFinite(v));
  const out = {
    samples: clean.length,
    lost,
    sent: clean.length + lost,
    mean: null,
    median: null,
    min: null,
    max: null,
    stdev: null,
    p95: null,
  };
  if (clean.length === 0) return out;
  out.mean = round(mean(clean));
  out.median = round(median(clean));
  out.min = round(Math.min(...clean), 1);
  out.max = round(Math.max(...clean), 1);
  out.stdev = round(stdev(clean));
  out.p95 = round(percentile(clean, 0.95), 1);
  return out;
}

// --- t distribution -------------------------------------------------------
// Welch's t-test needs a p-value, which needs the regularised incomplete beta
// function. Implemented from the standard continued-fraction expansion so the
// app has no runtime dependencies.

function logGamma(x) {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) {
    y += 1;
    ser += cof[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta function I_x(a,b). */
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-tailed p-value for Student's t with `df` degrees of freedom. */
function tTail(t, df) {
  if (!Number.isFinite(t) || df <= 0) return 1;
  const x = df / (df + t * t);
  return incompleteBeta(df / 2, 0.5, x);
}

/** Critical t value for a two-tailed 95% interval (enough for df 1..2000). */
function tCritical95(df) {
  if (!Number.isFinite(df) || df <= 0) return Number.POSITIVE_INFINITY;
  const table = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  ];
  // Welch's df is fractional; the table is indexed by whole degrees of
  // freedom, so it must be rounded (a fractional index yields undefined, which
  // would quietly turn every confidence interval into null).
  if (df <= 20) {
    const index = Math.min(table.length - 1, Math.max(0, Math.round(df) - 1));
    return table[index];
  }
  if (df <= 30) return 2.042;
  if (df <= 40) return 2.021;
  if (df <= 60) return 2.0;
  if (df <= 120) return 1.98;
  return 1.96;
}

/**
 * Welch's unequal-variance t-test, plus the 95% confidence interval on the
 * difference of means. `a` and `b` are arrays of ms samples.
 */
function welch(a, b) {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) {
    return { applicable: false, reason: 'need at least 2 samples per resolver', na, nb };
  }
  const ma = mean(a);
  const mb = mean(b);
  const va = stdev(a) ** 2;
  const vb = stdev(b) ** 2;
  const seA = va / na;
  const seB = vb / nb;
  const se = Math.sqrt(seA + seB);
  const diff = ma - mb;
  if (se === 0) {
    return {
      applicable: true,
      diff: round(diff),
      se: 0,
      t: diff === 0 ? 0 : Number.POSITIVE_INFINITY,
      df: na + nb - 2,
      p: diff === 0 ? 1 : 0,
      significant: diff !== 0,
      ci: diff === 0 ? [0, 0] : [round(diff), round(diff)],
      na,
      nb,
    };
  }
  const t = diff / se;
  const df =
    (seA + seB) ** 2 /
    (seA ** 2 / (na - 1) + seB ** 2 / (nb - 1));
  const p = tTail(Math.abs(t), df);
  const crit = tCritical95(df);
  return {
    applicable: true,
    diff: round(diff),
    meanA: round(ma),
    meanB: round(mb),
    se: round(se, 3),
    t: round(t, 3),
    df: round(df, 1),
    p: round(p, 4),
    significant: p < 0.05,
    ci: [round(diff - crit * se), round(diff + crit * se)],
    na,
    nb,
  };
}

/**
 * Percent of samples in `a` that would be lost if `a` had `b`'s mean, i.e. how
 * much of a's latency distribution sits above b's central tendency. Used for
 * the plain-English "the difference matters because N% of your lookups are
 * worse than the other resolver's average" line.
 */
function overlapPercent(a, b) {
  if (a.length === 0 || b.length === 0) return null;
  const mb = median(b);
  const above = a.filter((v) => v > mb).length;
  return round((100 * above) / a.length, 1);
}

module.exports = {
  mean,
  median,
  stdev,
  percentile,
  summarize,
  welch,
  tTail,
  tCritical95,
  overlapPercent,
  round,
};
