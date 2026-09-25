import { describe, expect, it } from 'vitest';
import { DEFAULTS, feCommOf, recipe, runModel, type Outputs } from './model';

const out = runModel(DEFAULTS);
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.01);
const check = (row: Record<string, number>, expected: Record<string, number>) =>
  Object.entries(expected).forEach(([k, v]) => {
    expect(row[k], k).toBeDefined();
    near(row[k], v);
  });
const rows = (src: unknown[], expected: Record<string, number[]>) => {
  for (const [k, vals] of Object.entries(expected))
    it(k, () => vals.forEach((v, y) => near((src[y] as Record<string, number>)[k], v)));
};

it('FE commission = monthly premium × 12 × blended rate', () => {
  near(feCommOf(DEFAULTS), 780);
  near(feCommOf({ ...DEFAULTS, feMonthlyPremium: 50, feCommRate: 1.2 }), 720);
});

describe('FE months', () => {
  const m = (n: number) => out.fe[n - 1] as unknown as Record<string, number>;
  const cols = ['totalCalls', 'totalApps', 'totalPlaced', 'advRev', 'agentPayout', 'callCost', 'lapseCost', 'totalCost', 'net', 'netPerPlaced', 'tailEarned'];
  const row = (vals: number[]) => Object.fromEntries(cols.map((k, j) => [k, vals[j]]));
  it('month 1', () =>
    check(m(1), { callsPerDay: 100, agents: 5, ...row([2086, 208.6, 166.88, 97624.8, 20025.6, 41511.4, 24406.2, 85943.2, 11681.6, 70, 24406.2]) }));
  it('month 4', () => check(m(4), row([4172, 417.2, 333.76, 195249.6, 40051.2, 83022.8, 48812.4, 171886.4, 23363.2, 70, 48812.4])));
  it('month 13', () => check(m(13), row([10430, 1043, 834.4, 488124, 100128, 207557, 122031, 429716, 58408, 70, 122031])));
  it('month 36', () =>
    check(m(36), { callsPerDay: 1200, agents: 60, ...row([25032, 2503.2, 2002.56, 1171497.6, 240307.2, 498136.8, 292874.4, 1031318.4, 140179.2, 70, 292874.4]) }));
  it('tail cash by month received', () => {
    for (let k = 1; k <= 9; k++) near(m(k).tailCash, 0);
    near(m(10).tailCash, 8135.4);
    near(m(11).tailCash, 16270.8);
    near(m(12).tailCash, 24406.2);
    near(m(13).tailCash, 32541.6);
    near(m(24).tailCash, 122031);
    near(m(36).tailCash, 219655.8);
  });
  it('cash and receivable', () => {
    near(m(36).cashIn, 1391153.4);
    near(m(36).cashNet, 359835);
    near(out.unit.receivableAfter36, 2635869.6);
    [5006.4, 13016.64, 21026.88].forEach((v, y) => near(out.unit.fePlacedPerYear[y], v));
  });
});

describe('Medicare per selling month', () => {
  rows(out.md, {
    callsPerDay: [625, 1250, 2500],
    totalApps: [1303.75, 2607.5, 5215],
    totalPlaced: [1043, 2086, 4172],
    rev: [723842, 1447684, 2895368],
    agentPayout: [125160, 250320, 500640],
    callCost: [207296.25, 414592.5, 829185],
    lapseCost: [144768.4, 289536.8, 579073.6],
    totalCost: [477224.65, 954449.3, 1908898.6],
    net: [246617.35, 493234.7, 986469.4],
    netPerPlaced: [236.45, 236.45, 236.45],
  });
});

describe('Summary', () => {
  rows(out.years, {
    feAdv: [2928744, 7614734.4, 12300724.8],
    feTail: [48812.4, 927435.6, 2098933.2],
    feRenew: [0, 111658.37, 404075.15],
    feRev: [2977556.4, 8653828.37, 14803733.15],
    feRetention: [59551.13, 173076.57, 296074.66],
    feCost: [2578296, 6703569.6, 10828843.2],
    feNet: [339709.27, 1777182.2, 3678815.29],
    mdNew: [3619210, 7238420, 14476840],
    mdResid: [0, 1447684, 4053515.2],
    mdRev: [3619210, 8686104, 18530355.2],
    mdRetention: [72384.2, 173722.08, 370607.1],
    mdNet: [1160702.55, 3740135.42, 8615255.1],
    totalRev: [6596766.4, 17339932.37, 33334088.35],
    totalNet: [1500411.82, 5517317.62, 12294070.38],
  });
});

describe('Partners', () => {
  it('25% each, 0% holdback', () => {
    for (const p of out.partners) {
      [375102.96, 1379329.4, 3073517.6].forEach((v, y) => near(p.yearly[y], v));
      near(p.total, 4827949.96);
    }
    near(out.splitTotal, 1);
  });
  it('splits 40/30/20/10', () =>
    near(runModel({ ...DEFAULTS, split1: 0.4, split2: 0.3, split3: 0.2, split4: 0.1 }).partners[0].yearly[0], 600164.73));
  it('holdback 30%', () =>
    runModel({ ...DEFAULTS, holdback: 0.3 }).partners.forEach((p) => near(p.yearly[0], 262572.07)));
  it('partner count sets how many partners share the profit', () => {
    const two = runModel({ ...DEFAULTS, partnerCount: 2, split1: 0.6, split2: 0.4 });
    expect(two.partners.length).toBe(2);
    near(two.splitTotal, 1);
    near(two.partners[0].yearly[0], out.years[0].totalNet * 0.6);
    const six = runModel({ ...DEFAULTS, partnerCount: 6, split1: 0.5, split2: 0.1, split3: 0.1, split4: 0.1, split5: 0.1, split6: 0.1 });
    expect(six.partners.length).toBe(6);
    near(six.partners[5].total, out.cumulative.totalNet * 0.1);
    // splits beyond the count are ignored; the count is clamped to 1..6
    expect(runModel({ ...DEFAULTS, partnerCount: 3 }).splitTotal).toBeCloseTo(0.75);
    expect(runModel({ ...DEFAULTS, partnerCount: 0 }).partners.length).toBe(1);
    expect(runModel({ ...DEFAULTS, partnerCount: 99 }).partners.length).toBe(6);
  });
});

describe('vs paying per call', () => {
  it('compare block', () => {
    const c = out.compare;
    [632058, 1643350.8, 2654643.6].forEach((v, y) => near(c.feSavedYear[y], v));
    [919143.75, 1838287.5, 3676575].forEach((v, y) => near(c.mdSavedYear[y], v));
    near(c.savedTotal, 11364058.65);
    near(c.fePerPolicyCall, 375);
    near(c.fePerPolicyApp, 248.75);
    near(c.mdPerPolicyCall, 375);
    near(c.mdPerPolicyApp, 198.75);
  });
  it('zero divisors give 0, not Infinity', () => {
    const c = runModel({ ...DEFAULTS, feConv: 0, mdPlace: 0 }).compare;
    expect(c.fePerPolicyCall).toBe(0);
    expect(c.mdPerPolicyApp).toBe(0);
  });
});

const allFinite = (o: Outputs) => {
  const walk = (v: unknown): void => {
    if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(o);
};

describe('Edge cases', () => {
  it('feConv = 0', () => {
    const o = runModel({ ...DEFAULTS, feConv: 0 });
    o.fe.forEach((r) => expect(r.netPerPlaced).toBe(0));
    allFinite(o);
  });
  it('Medicare agents = 0 for a year', () => {
    const o = runModel({ ...DEFAULTS, mdAgentsY2: 0 });
    Object.values(o.md[1]).forEach((v) => expect(v).toBe(0));
    near(o.years[1].mdNew, 0);
    allFinite(o);
  });
  it('mdLapse = 30% residual', () => near(runModel({ ...DEFAULTS, mdLapse: 0.3 }).years[1].mdResid, 1266723.5));
});

describe('Chains (agents → net) reconcile with the summary', () => {
  it('revenue − costs = net for every period and line; All = sum of years', () => {
    for (const p of out.periods) for (const c of [p.fe, p.md]) near(c.revenue - c.costs, c.net);
    out.years.forEach((y, i) => {
      near(out.periods[i].fe.net, y.feNet);
      near(out.periods[i].md.net, y.mdNet);
    });
    near(out.periods[3].fe.net + out.periods[3].md.net, out.cumulative.totalNet);
    near(out.periods[0].fe.placed, 5006.4);
    near(out.periods[0].md.placed, 5215);
  });
});

describe('recipe (reverse model)', () => {
  it('works back from $25K/mo to a partner at 25%, all Final Expense', () => {
    const r = recipe(DEFAULTS, 25000, 0.25, 1);
    near(r.companyNet, 100000);
    check(r.fe.perPolicy, { revenue: 731.25, payout: 120, calls: 248.75, chargeback: 146.25, retention: 14.625, net: 201.625 });
    near(r.fe.policiesMo, 100000 / 201.625);
    near(r.fe.callsDay, r.fe.policiesDay * 12.5);
    expect(r.fe.agents).toBe(Math.ceil(r.fe.callsDay / 20));
    expect(r.md.agents).toBe(0);
    expect(r.feasible).toBe(true);
    // the recipe's own numbers reconcile to the target
    near(r.fe.revenue - r.fe.payouts - r.fe.callCost - r.fe.chargebacks - r.fe.retention, 100000);
  });
  it('Medicare share is packed into 5 selling months', () => {
    const r = recipe(DEFAULTS, 25000, 0.25, 0.5);
    near(r.md.target, (50000 * 12) / 5);
    check(r.md.perPolicy, { revenue: 694, payout: 120, calls: 198.75, chargeback: 138.8, retention: 13.88, net: 222.57 });
  });
  it('flags money-losing assumptions as infeasible', () => {
    const at400 = recipe({ ...DEFAULTS, feAppCost: 400 }, 25000, 0.25, 1);
    expect(at400.feasible).toBe(false);
    near(at400.fe.perPolicy.net, -49.625);
    const at300 = recipe({ ...DEFAULTS, feAppCost: 300 }, 25000, 0.25, 1);
    expect(at300.feasible).toBe(true);
    near(at300.fe.perPolicy.net, 75.375);
    expect(recipe(DEFAULTS, 25000, 0, 1).feasible).toBe(false);
  });
  it('placement 0 is infeasible, not a crash', () =>
    expect(recipe({ ...DEFAULTS, fePlace: 0 }, 25000, 0.25, 1).feasible).toBe(false));
});
