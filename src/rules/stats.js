'use strict';
// Measurement stats, ported from lost-lead-engine/index.html.

/* Abramowitz & Stegun 7.1.26; error under 1.5e-7 */
function erf(x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
const normCdf = z => 0.5 * (1 + erf(z / Math.SQRT2));

/** Two-proportion z test plus a 95% interval on the difference. a, b = {n, conv}. */
function compareArms(a, b) {
  const p1 = a.n ? a.conv / a.n : 0, p2 = b.n ? b.conv / b.n : 0;
  const pool = (a.n + b.n) ? (a.conv + b.conv) / (a.n + b.n) : 0;
  const se = Math.sqrt(pool * (1 - pool) * (1 / a.n + 1 / b.n));
  const z = se > 0 ? (p1 - p2) / se : 0;
  const seDiff = Math.sqrt(p1 * (1 - p1) / a.n + p2 * (1 - p2) / b.n);
  return { p1, p2, diff: p1 - p2, z, p: se > 0 ? 2 * (1 - normCdf(Math.abs(z))) : 1,
    lo: (p1 - p2) - 1.96 * seDiff, hi: (p1 - p2) + 1.96 * seDiff };
}
/** Smallest lift these group sizes could call at 95% confidence and 80% power (2.80 = 1.96 + 0.84). */
function minDetectable(n1, n2, base) {
  if (!n1 || !n2) return null;
  const p = Math.min(Math.max(base, 0.02), 0.98);
  return 2.80 * Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
}
/**
 * @param arm      Map mobile -> {day0: Date|null}
 * @param outcome  Map mobile -> first Date seen (or null if undated)
 */
function scoreArm(arm, outcome, windowDays) {
  let n = 0, conv = 0, undated = 0;
  arm.forEach((info, mob) => {
    n++;
    if (!outcome.has(mob)) return;
    const when = outcome.get(mob);
    if (when && info.day0) {
      const days = (when - info.day0) / 864e5;
      if (days < 0 || days > windowDays) return;
    } else undated++;
    conv++;
  });
  return { n, conv, undated, rate: n ? conv / n : 0 };
}

module.exports = { erf, normCdf, compareArms, minDetectable, scoreArm };
