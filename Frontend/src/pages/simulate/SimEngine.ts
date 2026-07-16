// Discrete Event Simulation Engine

// A single generic distribution type is shared by both the arrival process
// and the service process — either one can independently be Exponential,
// Poisson, Uniform, Normal, or Gamma.
export type Distribution = 'exponential' | 'poisson' | 'uniform' | 'normal' | 'gamma';

// Kept as named aliases (rather than a single shared type) so existing
// imports of `ServiceDist` elsewhere in the app keep working unchanged.
export type ServiceDist = Distribution;
export type ArrivalDist = Distribution;

export interface DistParams {
  uniformMin?: number;
  uniformMax?: number;
  normalMean?: number;
  normalStd?: number;
  gammaShape?: number;
  gammaScale?: number;
}

// Aliases for backward compatibility with existing imports.
export type ServiceDistParams = DistParams;
export type ArrivalDistParams = DistParams;

export interface SimParams {
  servers: number;
  arrivalRate: number;   // lambda
  serviceRate: number;   // mu
  // Arrival distribution defaults to 'exponential' (i.e. a classic Poisson
  // arrival *process*, since exponential inter-arrival times <=> a Poisson
  // count process). M/M and M/G models expose Exponential + Poisson as
  // arrival choices; G/G models expose all five distributions.
  arrivalDist?: ArrivalDist;
  arrivalParams?: ArrivalDistParams;
  serviceDist: ServiceDist;
  serviceParams?: ServiceDistParams;
}

export interface SimResult {
  avgWaitTime: number;
  avgSystemTime: number;
  avgResponseTime: number;
  avgQueueLength: number;
  avgSystemLength: number;
  serverUtilization: number;
  throughput: number;
  totalServed: number;
  table: TableRow[];
}

export interface TableRow {
  customer: number;
  server: number;
  arrivalTime: number;
  serviceStartTime: number;
  serviceTime: number;
  departureTime: number;
  waitTime: number;
  systemTime: number;
  responseTime: number;
}

function expRandom(rate: number): number {
  return -Math.log(1 - Math.random()) / rate;
}

function poissonRandom(lambda: number): number {
  // Generate Poisson deviate using Knuth algorithm
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function standardNormal(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function normalRandom(mean: number, std: number): number {
  return Math.max(0.0001, mean + std * standardNormal());
}

function uniformRandom(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Marsaglia & Tsang method
function gammaRandom(shape: number, scale: number): number {
  if (shape <= 0) return 0.0001;
  if (shape < 1) {
    const u = Math.random();
    return gammaRandom(1 + shape, scale) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = standardNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return Math.max(0.0001, d * v * scale);
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return Math.max(0.0001, d * v * scale);
  }
}

// Generic random-variate generator: given a rate (mu for service, lambda for
// arrivals) it returns a random time interval (service time, or
// inter-arrival time) drawn from the chosen distribution. `mean` = 1/rate is
// used as the natural center for the distribution in each case.
export function generateVariate(dist: Distribution, rate: number, params?: DistParams): number {
  const mean = 1 / rate;
  switch (dist) {
    case 'exponential':
      return expRandom(rate);
    case 'poisson': {
      const val = poissonRandom(mean);
      return val <= 0 ? mean : val; // fallback to mean if 0
    }
    case 'uniform': {
      const min = params?.uniformMin ?? mean * 0.5;
      const max = params?.uniformMax ?? mean * 1.5;
      return uniformRandom(Math.min(min, max), Math.max(min, max));
    }
    case 'normal': {
      const nMean = params?.normalMean ?? mean;
      const nStd = params?.normalStd ?? mean * 0.3;
      return normalRandom(nMean, nStd);
    }
    case 'gamma': {
      const shape = params?.gammaShape ?? 2;
      const scale = params?.gammaScale ?? mean / shape;
      return gammaRandom(shape, scale);
    }
  }
}

// Kept for backward compatibility with existing call sites (service time
// generation specifically).
export function generateServiceTime(dist: ServiceDist, mu: number, params?: ServiceDistParams): number {
  return generateVariate(dist, mu, params);
}

// Inter-arrival time generation — mirrors generateServiceTime but reads
// naturally at call sites that generate arrivals rather than service times.
export function generateInterArrivalTime(dist: ArrivalDist, lambda: number, params?: ArrivalDistParams): number {
  return generateVariate(dist, lambda, params);
}

// ===== Cumulative-probability (CP) lookup stopping criterion =====
// No manual "number of customers" input: the run length is determined
// automatically. After each customer n is generated, we look up the
// cumulative probability (CDF, or cumulative PMF sum for the discrete
// Poisson case) of the *arrival* distribution evaluated at n, and stop once
// that cumulative probability rounds to 1.000 (>= CUM_PROB_STOP_THRESHOLD).
// Each of the 5 distributions has its own CP formula below, so this now
// works correctly no matter which Arrival Distribution is selected — not
// just Poisson as in the earlier version of this file.
const CUM_PROB_STOP_THRESHOLD = 0.9995;
// Guards against distributions/parameters where the CP threshold would
// otherwise be reached only after an impractically large number of
// customers (e.g. a Uniform/Normal/Gamma arrival distribution with a large
// mean relative to 1).
const SAFETY_CAP = 5000;

function lnGamma(x: number): number {
  // Lanczos approximation, used for exact factorials in the Poisson PMF
  // and for the regularized incomplete gamma function (Gamma CDF) below.
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function poissonPMF(k: number, lambda: number): number {
  return Math.exp(-lambda + k * Math.log(lambda) - lnGamma(k + 1));
}

// Abramowitz & Stegun 7.1.26 approximation of the error function, used by
// the Normal CDF (max absolute error ~1.5e-7).
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normalCDF(x: number, mean: number, std: number): number {
  if (std <= 0) return x >= mean ? 1 : 0;
  return 0.5 * (1 + erf((x - mean) / (std * Math.sqrt(2))));
}

function uniformCDF(x: number, min: number, max: number): number {
  if (x <= min) return 0;
  if (x >= max) return 1;
  return (x - min) / (max - min);
}

// Regularized lower incomplete gamma function P(s, x) — series expansion
// for x < s + 1, continued fraction otherwise (standard Numerical Recipes
// approach). Used to compute the Gamma distribution's CDF.
function regularizedLowerGamma(s: number, x: number): number {
  if (x <= 0) return 0;
  if (x < s + 1) {
    let term = 1 / s;
    let sum = term;
    let a = s;
    for (let i = 0; i < 300; i++) {
      a += 1;
      term *= x / a;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return Math.min(sum * Math.exp(-x + s * Math.log(x) - lnGamma(s)), 1);
  }
  // Continued fraction for Q(s,x) = 1 - P(s,x)
  let b = x + 1 - s, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 300; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  const Q = Math.exp(-x + s * Math.log(x) - lnGamma(s)) * h;
  return Math.max(1 - Q, 0);
}

function gammaCDF(x: number, shape: number, scale: number): number {
  if (x <= 0) return 0;
  return regularizedLowerGamma(shape, x / scale);
}

// The CP-lookup formula for each distribution, evaluated at the running
// customer count n. `rate` is the arrival rate (lambda); `mean` = 1/rate is
// used the same way it is for generating the arrival variates themselves.
function arrivalCumulativeProbabilityAtN(dist: ArrivalDist, n: number, rate: number, params?: ArrivalDistParams): number {
  const mean = 1 / rate;
  switch (dist) {
    case 'exponential':
      return 1 - Math.exp(-rate * n);
    case 'poisson': {
      let sum = 0;
      for (let k = 0; k <= n; k++) sum += poissonPMF(k, rate);
      return Math.min(sum, 1);
    }
    case 'uniform': {
      const min = params?.uniformMin ?? mean * 0.5;
      const max = params?.uniformMax ?? mean * 1.5;
      return uniformCDF(n, min, max);
    }
    case 'normal': {
      const nMean = params?.normalMean ?? mean;
      const nStd = params?.normalStd ?? mean * 0.3;
      return normalCDF(n, nMean, nStd);
    }
    case 'gamma': {
      const shape = params?.gammaShape ?? 2;
      const scale = params?.gammaScale ?? mean / shape;
      return gammaCDF(n, shape, scale);
    }
  }
}
// ===== End CP-lookup stopping criterion =====

export function runSimulation(params: SimParams): SimResult {
  const {
    servers, arrivalRate, serviceRate,
    serviceDist, serviceParams,
    arrivalDist = 'exponential', arrivalParams,
  } = params;
  const table: TableRow[] = [];

  // Server free-at times
  const serverFreeAt = new Array(servers).fill(0);
  let time = 0;

  let n = 0;
  let cumProb = 0;

  while (cumProb < CUM_PROB_STOP_THRESHOLD && n < SAFETY_CAP) {
    n++;

    // Arrival: inter-arrival time drawn from the chosen arrival distribution
    // (Exponential = classic Poisson arrival process; Poisson, Uniform,
    // Normal, or Gamma are also selectable depending on the model page).
    time += generateInterArrivalTime(arrivalDist, arrivalRate, arrivalParams);
    const arrivalTime = time;

    // Find earliest free server
    const minFree = Math.min(...serverFreeAt);
    const serverIdx = serverFreeAt.indexOf(minFree);
    const serviceStart = Math.max(arrivalTime, minFree);
    const serviceTime = generateServiceTime(serviceDist, serviceRate, serviceParams);
    const departure = serviceStart + serviceTime;
    serverFreeAt[serverIdx] = departure;

    // ===== Fixed: negative wait-time floating-point bug =====
    // The old formula (`systemTime - serviceTime`) subtracted two
    // independently rounded floating-point numbers, which occasionally
    // produced tiny negative artifacts like -0.0000 instead of exactly 0
    // when a customer had no wait. Computing waitTime directly from
    // serviceStart - arrivalTime is mathematically guaranteed to be >= 0
    // (a customer's service can never start before they arrive), so the
    // Math.max(0, ...) clamp below is just a final safety net against any
    // remaining sub-epsilon rounding noise.
    const waitTime = Math.max(0, serviceStart - arrivalTime);
    const systemTime = departure - arrivalTime;
    const responseTime = waitTime; // time from arrival to departure (sojourn time)
    // ===== End Fixed: negative wait-time floating-point bug =====

    table.push({ customer: n, server: serverIdx + 1, arrivalTime, serviceStartTime: serviceStart, serviceTime, departureTime: departure, waitTime, systemTime, responseTime });

    // Look up this arrival distribution's own cumulative probability at the
    // running customer count n. Loop stops once this rounds to 1.000.
    cumProb = arrivalCumulativeProbabilityAtN(arrivalDist, n, arrivalRate, arrivalParams);
  }

  const totalServed = table.length;

  const totalWait = table.reduce((s, r) => s + r.waitTime, 0);
  const totalSystem = table.reduce((s, r) => s + r.systemTime, 0);
  const totalResponse = table.reduce((s, r) => s + r.responseTime, 0);
  const totalService = table.reduce((s, r) => s + r.serviceTime, 0);
  const simDuration = table[table.length - 1].departureTime;

  const avgWaitTime = totalWait / totalServed;       // ===== Modified: was `numCustomers` =====
  const avgSystemTime = totalSystem / totalServed;   // ===== Modified: was `numCustomers` =====
  const avgResponseTime = totalResponse / totalServed; // ===== Modified: was `numCustomers` =====
  const throughput = totalServed / simDuration;      // ===== Modified: was `numCustomers` =====
  const serverUtilization = totalService / (simDuration * servers);
  const avgSystemLength = throughput * avgSystemTime;
  const avgQueueLength = throughput * avgWaitTime;

  return { avgWaitTime, avgSystemTime, avgResponseTime, avgQueueLength, avgSystemLength, serverUtilization, throughput, totalServed, table };
}