// Black–Scholes greeks for SPX 0DTE option pricing.
// Time T is in years; for intraday 0DTE we floor it so values stay finite as expiry approaches.

const SQRT2PI = Math.sqrt(2 * Math.PI);

function pdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function cdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function greeks({ S, K, T, sigma = 0.18, r = 0.045, type = 'call' }) {
  const Tsafe = Math.max(T, 1 / (365 * 24 * 60));
  const sqrtT = Math.sqrt(Tsafe);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * Tsafe) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const Nd1 = cdf(d1);
  const Nd2 = cdf(d2);
  const phi = pdf(d1);
  const discount = Math.exp(-r * Tsafe);
  let premium;
  let delta;
  let theta;
  if (type === 'call') {
    premium = S * Nd1 - K * discount * Nd2;
    delta = Nd1;
    theta = (-S * phi * sigma) / (2 * sqrtT) - r * K * discount * Nd2;
  } else {
    premium = K * discount * cdf(-d2) - S * cdf(-d1);
    delta = Nd1 - 1;
    theta = (-S * phi * sigma) / (2 * sqrtT) + r * K * discount * cdf(-d2);
  }
  const gamma = phi / (S * sigma * sqrtT);
  const vega = S * phi * sqrtT * 0.01; // per 1% vol
  return {
    premium: Math.max(premium, 0.01),
    delta,
    gamma,
    theta: theta / 365, // per day
    vega
  };
}

export function snapStrike(price, step = 5) {
  return Math.round(price / step) * step;
}

export function nearestOtmStrike(price, type, step = 5) {
  if (type === 'call') {
    return Math.ceil((price + 0.01) / step) * step;
  }
  return Math.floor((price - 0.01) / step) * step;
}
