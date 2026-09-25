// Pure model. Every formula here is transcribed from the spec; the UI never does math.

export const DEFAULTS = {
  // Final Expense
  feCallsStart: 100,
  feCallsQtrInc: 100,
  feConv: 0.1,
  fePlace: 0.8,
  fePayout: 120,
  feAppCost: 199, // per submitted application; calls are $0
  feLapse: 0.25,
  feCallsPerAgent: 20,
  feMonthlyPremium: 65,
  feCommRate: 1, // blended first-year rate; commission = premium × 12 × rate
  feAdvance: 0.75,
  feRenew: 0.05,
  // Medicare
  mdCallsPerAgent: 25,
  mdConv: 0.1,
  mdPlace: 0.8,
  mdComm: 694, // 2026 CMS national initial MA commission
  mdRenewPct: 0.5, // renewal as a share of initial (2026 national renewal $347)
  mdPayout: 120,
  mdAppCost: 159, // per submitted application; calls are $0
  mdLapse: 0.2,
  mdAgentsY1: 25,
  mdAgentsY2: 50,
  mdAgentsY3: 100,
  // Shared
  workDays: 20.86,
  retention: 0.02,
  holdback: 0,
  split1: 0.25,
  split2: 0.25,
  split3: 0.25,
  split4: 0.25,
  comparePerCall: 30, // display only: the per-call price in the "vs paying per call" card
  // Exit valuation
  exitMdBookMult: 2.0, // Medicare renewal book multiple (× next-12-month renewals)
  exitFeBookMult: 1.5, // FE renewal book multiple
  exitOverhead: 0.08, // overhead + management a buyer deducts that the plan does not carry (% of revenue)
  exitClosePct: 0.6, // share of price paid in cash at close; rest is earnout over 24 months tied to retention
  exitSaleTax: 0, // tax on sale proceeds; 0 = pre-tax
};

export type Inputs = typeof DEFAULTS;
export type InputKey = keyof Inputs;

// LOA model: carriers pay the FE first-year commission to the agency.
export const feCommOf = (i: Inputs) => i.feMonthlyPremium * 12 * i.feCommRate;

export interface FeMonth {
  month: number;
  callsPerDay: number;
  agents: number;
  totalCalls: number;
  appsPerDay: number;
  totalApps: number;
  placedPerDay: number;
  totalPlaced: number;
  advRevPerDay: number;
  advRev: number;
  agentPayout: number;
  callCost: number;
  lapseCost: number;
  totalCost: number;
  net: number;
  netPerPlaced: number;
  tailEarned: number;
  tailCash: number;
  cashIn: number; // advRev + tailCash received this month
  cashNet: number; // cashIn − totalCost
}

export interface MdMonth {
  agents: number;
  callsPerDay: number;
  totalCalls: number;
  appsPerDay: number;
  totalApps: number;
  placedPerDay: number;
  totalPlaced: number;
  revPerDay: number;
  rev: number;
  agentPayout: number;
  callCost: number;
  lapseCost: number;
  totalCost: number;
  net: number;
  netPerPlaced: number;
}

export interface YearSummary {
  feAdv: number;
  feTail: number;
  feRenew: number;
  feRev: number;
  feRetention: number;
  feCost: number;
  feNet: number;
  mdNew: number;
  mdResid: number;
  mdRev: number;
  mdRetention: number;
  mdNet: number;
  mdCosts: number; // everything between Medicare revenue and Medicare net (mdRev − mdNet)
  totalRev: number;
  totalCost: number; // totalRev − totalNet
  totalNet: number;
  margin: number;
  fePlaced: number;
}

// One business line's chain for a period: agents → calls → apps → placed → revenue → costs → net.
export interface Chain {
  agentsStart: number;
  agentsEnd: number;
  callsPerDayStart: number;
  callsPerDayEnd: number;
  calls: number;
  apps: number;
  placed: number;
  revenue: number;
  revParts: [string, number][];
  payouts: number;
  callCosts: number;
  chargebacks: number;
  retention: number;
  costs: number; // payouts + callCosts + chargebacks + retention
  net: number;
  margin: number;
}
export interface Period {
  fe: Chain;
  md: Chain;
}

export interface Outputs {
  fe: FeMonth[]; // 36 months
  md: MdMonth[]; // 3 years, per selling month
  years: YearSummary[]; // 3
  periods: Period[]; // Year 1, Year 2, Year 3, All 3 years
  cumulative: { totalRev: number; totalNet: number; margin: number };
  partners: { yearly: number[]; total: number }[]; // 4
  splitTotal: number;
  compare: {
    feSavedYear: number[];
    mdSavedYear: number[];
    savedTotal: number;
    fePerPolicyCall: number;
    fePerPolicyApp: number;
    mdPerPolicyCall: number;
    mdPerPolicyApp: number;
  };
  unit: {
    feNetPerPlaced: number;
    mdNetPerPlaced: number;
    feAgentsAt: number[]; // months 12, 24, 36
    mdAgents: number[];
    fePlacedPerYear: number[];
    receivableAfter36: number;
  };
}

export const MD_MONTHS = ['Oct', 'Nov', 'Jan', 'Feb', 'Mar'];
const MD_SELLING_MONTHS = MD_MONTHS.length;

const div = (a: number, b: number) => (b === 0 ? 0 : a / b);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function runModel(i: Inputs): Outputs {
  const D = i.workDays;
  const feComm = feCommOf(i);

  const fe: FeMonth[] = [];
  for (let m = 1; m <= 36; m++) {
    const q = Math.floor((m - 1) / 3);
    const callsPerDay = i.feCallsStart + i.feCallsQtrInc * q;
    const appsPerDay = callsPerDay * i.feConv;
    const placedPerDay = appsPerDay * i.fePlace;
    const advRevPerDay = feComm * i.feAdvance * placedPerDay;
    const totalCalls = callsPerDay * D;
    const totalApps = appsPerDay * D;
    const totalPlaced = placedPerDay * D;
    const advRev = advRevPerDay * D;
    const agentPayout = totalPlaced * i.fePayout;
    const callCost = totalApps * i.feAppCost;
    const lapseCost = advRev * i.feLapse;
    const totalCost = agentPayout + callCost + lapseCost;
    const net = advRev - totalCost;
    fe.push({
      month: m,
      callsPerDay,
      agents: div(callsPerDay, i.feCallsPerAgent),
      totalCalls,
      appsPerDay,
      totalApps,
      placedPerDay,
      totalPlaced,
      advRevPerDay,
      advRev,
      agentPayout,
      callCost,
      lapseCost,
      totalCost,
      net,
      netPerPlaced: div(net, totalPlaced),
      tailEarned: feComm * (1 - i.feAdvance) * placedPerDay * (1 - i.feLapse) * D,
      tailCash: 0,
      cashIn: 0,
      cashNet: 0,
    });
  }
  // Tail paid one third in each of months m+9, m+10, m+11.
  for (const r of fe)
    for (const k of [r.month + 9, r.month + 10, r.month + 11])
      if (k <= 36) fe[k - 1].tailCash += r.tailEarned / 3;
  for (const r of fe) {
    r.cashIn = r.advRev + r.tailCash;
    r.cashNet = r.cashIn - r.totalCost;
  }
  const receivableAfter36 = sum(fe.map((r) => r.tailEarned)) - sum(fe.map((r) => r.tailCash));

  const mdAgents = [i.mdAgentsY1, i.mdAgentsY2, i.mdAgentsY3];
  const md: MdMonth[] = mdAgents.map((agents) => {
    const callsPerDay = i.mdCallsPerAgent * agents;
    const appsPerDay = callsPerDay * i.mdConv;
    const placedPerDay = appsPerDay * i.mdPlace;
    const revPerDay = i.mdComm * placedPerDay;
    const totalCalls = callsPerDay * D;
    const totalApps = appsPerDay * D;
    const totalPlaced = placedPerDay * D;
    const rev = revPerDay * D;
    const agentPayout = totalPlaced * i.mdPayout;
    const callCost = totalApps * i.mdAppCost;
    const lapseCost = rev * i.mdLapse;
    const totalCost = agentPayout + callCost + lapseCost;
    const net = rev - totalCost;
    return {
      agents,
      callsPerDay,
      totalCalls,
      appsPerDay,
      totalApps,
      placedPerDay,
      totalPlaced,
      revPerDay,
      rev,
      agentPayout,
      callCost,
      lapseCost,
      totalCost,
      net,
      netPerPlaced: div(net, totalPlaced),
    };
  });

  const feKeep = 1 - i.feLapse;
  const mdKeep = 1 - i.mdLapse;
  const yr = (y: number) => fe.slice(12 * y, 12 * y + 12);
  const feAdv = [0, 1, 2].map((y) => sum(yr(y).map((r) => r.advRev)));
  const feTail = [0, 1, 2].map((y) => sum(yr(y).map((r) => r.tailCash)));
  const feRenew = [
    0,
    (feAdv[0] + feTail[0]) * feKeep * i.feRenew,
    (feAdv[1] + feTail[1]) * feKeep * i.feRenew + (feAdv[0] + feTail[0]) * feKeep ** 2 * i.feRenew,
  ];
  const mdNew = md.map((r) => MD_SELLING_MONTHS * r.rev);
  const mdResid = [0, mdNew[0] * i.mdRenewPct * mdKeep, (mdNew[0] * mdKeep ** 2 + mdNew[1] * mdKeep) * i.mdRenewPct];

  const years: YearSummary[] = [0, 1, 2].map((y) => {
    const feRev = feAdv[y] + feTail[y] + feRenew[y];
    const feRetention = feRev * i.retention;
    const feCost = sum(yr(y).map((r) => r.totalCost));
    const feNet = feRev - feCost - feRetention;
    const mdRev = mdNew[y] + mdResid[y];
    const mdRetention = mdRev * i.retention;
    const mdNet = MD_SELLING_MONTHS * md[y].net + mdResid[y] - mdRetention;
    const totalRev = feRev + mdRev;
    const totalNet = feNet + mdNet;
    return {
      feAdv: feAdv[y],
      feTail: feTail[y],
      feRenew: feRenew[y],
      feRev,
      feRetention,
      feCost,
      feNet,
      mdNew: mdNew[y],
      mdResid: mdResid[y],
      mdRev,
      mdRetention,
      mdNet,
      mdCosts: mdRev - mdNet,
      totalRev,
      totalNet,
      totalCost: totalRev - totalNet,
      margin: div(totalNet, totalRev),
      fePlaced: sum(yr(y).map((r) => r.totalPlaced)),
    };
  });

  const feChain = (y: number): Chain => {
    const ms = yr(y);
    const s = years[y];
    const payouts = sum(ms.map((r) => r.agentPayout));
    const callCosts = sum(ms.map((r) => r.callCost));
    const chargebacks = sum(ms.map((r) => r.lapseCost));
    return {
      agentsStart: ms[0].agents,
      agentsEnd: ms[11].agents,
      callsPerDayStart: ms[0].callsPerDay,
      callsPerDayEnd: ms[11].callsPerDay,
      calls: sum(ms.map((r) => r.totalCalls)),
      apps: sum(ms.map((r) => r.totalApps)),
      placed: s.fePlaced,
      revenue: s.feRev,
      revParts: [['Advanced commissions', s.feAdv], ['Months 10–12 payments', s.feTail], ['Renewals', s.feRenew]],
      payouts,
      callCosts,
      chargebacks,
      retention: s.feRetention,
      costs: payouts + callCosts + chargebacks + s.feRetention,
      net: s.feNet,
      margin: div(s.feNet, s.feRev),
    };
  };
  const mdChain = (y: number): Chain => {
    const r = md[y];
    const s = years[y];
    const payouts = MD_SELLING_MONTHS * r.agentPayout;
    const callCosts = MD_SELLING_MONTHS * r.callCost;
    const chargebacks = MD_SELLING_MONTHS * r.lapseCost;
    return {
      agentsStart: r.agents,
      agentsEnd: r.agents,
      callsPerDayStart: r.callsPerDay,
      callsPerDayEnd: r.callsPerDay,
      calls: MD_SELLING_MONTHS * r.totalCalls,
      apps: MD_SELLING_MONTHS * r.totalApps,
      placed: MD_SELLING_MONTHS * r.totalPlaced,
      revenue: s.mdRev,
      revParts: [['New policies', s.mdNew], ['Renewals', s.mdResid]],
      payouts,
      callCosts,
      chargebacks,
      retention: s.mdRetention,
      costs: payouts + callCosts + chargebacks + s.mdRetention,
      net: s.mdNet,
      margin: div(s.mdNet, s.mdRev),
    };
  };
  // "All 3 years": flows add up; agents and calls/day run from the first year's start to the last year's end.
  const combine = (cs: Chain[]): Chain => {
    const add = (k: keyof Chain) => sum(cs.map((c) => c[k] as number));
    const revenue = add('revenue');
    const net = add('net');
    return {
      agentsStart: cs[0].agentsStart,
      agentsEnd: cs[2].agentsEnd,
      callsPerDayStart: cs[0].callsPerDayStart,
      callsPerDayEnd: cs[2].callsPerDayEnd,
      calls: add('calls'),
      apps: add('apps'),
      placed: add('placed'),
      revenue,
      revParts: cs[0].revParts.map(([l], j) => [l, sum(cs.map((c) => c.revParts[j][1]))]),
      payouts: add('payouts'),
      callCosts: add('callCosts'),
      chargebacks: add('chargebacks'),
      retention: add('retention'),
      costs: add('costs'),
      net,
      margin: div(net, revenue),
    };
  };
  const perYear = [0, 1, 2].map((y) => ({ fe: feChain(y), md: mdChain(y) }));
  const periods: Period[] = [...perYear, { fe: combine(perYear.map((p) => p.fe)), md: combine(perYear.map((p) => p.md)) }];

  const cumRev = sum(years.map((y) => y.totalRev));
  const cumNet = sum(years.map((y) => y.totalNet));
  const splits = [i.split1, i.split2, i.split3, i.split4];
  const partners = splits.map((s) => {
    const yearly = years.map((y) => y.totalNet * s * (1 - i.holdback));
    return { yearly, total: sum(yearly) };
  });

  const feSavedYear = [0, 1, 2].map((y) => sum(yr(y).map((r) => r.totalCalls * i.comparePerCall - r.callCost)));
  const mdSavedYear = md.map((r) => MD_SELLING_MONTHS * (r.totalCalls * i.comparePerCall - r.callCost));

  return {
    fe,
    md,
    years,
    periods,
    cumulative: { totalRev: cumRev, totalNet: cumNet, margin: div(cumNet, cumRev) },
    partners,
    splitTotal: sum(splits),
    compare: {
      feSavedYear,
      mdSavedYear,
      savedTotal: sum(feSavedYear) + sum(mdSavedYear),
      fePerPolicyCall: div(i.comparePerCall, i.feConv * i.fePlace),
      fePerPolicyApp: div(i.feAppCost, i.fePlace),
      mdPerPolicyCall: div(i.comparePerCall, i.mdConv * i.mdPlace),
      mdPerPolicyApp: div(i.mdAppCost, i.mdPlace),
    },
    unit: {
      // Per-policy net is identical across months/years; take the last period with volume.
      feNetPerPlaced: [...fe].reverse().find((r) => r.totalPlaced > 0)?.netPerPlaced ?? 0,
      mdNetPerPlaced: [...md].reverse().find((r) => r.totalPlaced > 0)?.netPerPlaced ?? 0,
      feAgentsAt: [12, 24, 36].map((m) => fe[m - 1].agents),
      mdAgents,
      fePlacedPerYear: years.map((y) => y.fePlaced),
      receivableAfter36,
    },
  };
}

// ---------- reverse model: "I want $X a month — what does it take?" ----------
// Steady-state, first-year economics per placed policy. Renewals and Medicare residuals are left out
// of the recipe (conservative) and reported separately as upside.
export interface LineRecipe {
  perPolicy: { revenue: number; payout: number; calls: number; chargeback: number; retention: number; net: number };
  target: number; // company net this line must produce per selling month
  policiesMo: number;
  policiesDay: number;
  appsDay: number;
  callsDay: number;
  agents: number; // whole people
  revenue: number; // per selling month
  payouts: number;
  callCost: number;
  chargebacks: number;
  retention: number;
}
export interface Recipe {
  feasible: boolean;
  companyNet: number; // monthly, averaged over the year
  fe: LineRecipe;
  md: LineRecipe; // per selling month (5 a year)
  youEarly: number; // your monthly take in months 1–9, before FE months 10–12 payments arrive
  upside: number; // extra to you per month from year 2: FE renewals + Medicare residuals
  feMonthReached: number | null; // first plan month whose FE calls/day covers the recipe
}

export function recipe(i: Inputs, goal: number, share: number, feMix: number): Recipe {
  const D = i.workDays;
  const keepShare = share * (1 - i.holdback);
  const companyNet = keepShare > 0 ? goal / keepShare : Infinity;
  const feComm = feCommOf(i);
  const feRev = feComm * i.feAdvance + feComm * (1 - i.feAdvance) * (1 - i.feLapse);
  const mdRev = i.mdComm;

  const line = (
    target: number, rev: number, chargeback: number, payout: number, appCostPerPolicy: number,
    conv: number, place: number, callsPerAgent: number,
  ): LineRecipe => {
    const hit = conv * place;
    const callsPer = hit > 0 ? 1 / hit : Infinity;
    const retention = rev * i.retention;
    // `calls` keeps its name for the UI; it is the application cost behind one placed policy.
    const per = { revenue: rev, payout, calls: appCostPerPolicy, chargeback, retention, net: rev - payout - appCostPerPolicy - chargeback - retention };
    // A money-losing policy can't be scaled to a profit: no volume.
    const n = target > 0 && per.net > 0 && Number.isFinite(target) ? target / per.net : 0;
    const policiesDay = n / D;
    const callsDay = n > 0 ? policiesDay * callsPer : 0;
    return {
      perPolicy: per, target, policiesMo: n, policiesDay,
      appsDay: n > 0 ? policiesDay / place : 0,
      callsDay,
      agents: callsDay > 0 ? Math.ceil(callsDay / callsPerAgent - 1e-9) : 0,
      revenue: n * rev, payouts: n * payout, callCost: n * per.calls, chargebacks: n * chargeback, retention: n * retention,
    };
  };

  const perPolicy = (cost: number, place: number) => (place > 0 ? cost / place : Infinity);
  const fe = line(companyNet * feMix, feRev, feComm * i.feAdvance * i.feLapse, i.fePayout, perPolicy(i.feAppCost, i.fePlace), i.feConv, i.fePlace, i.feCallsPerAgent);
  // Medicare only sells 5 months a year, so each selling month carries 12/5 of its monthly share.
  const md = line((companyNet * (1 - feMix) * 12) / MD_SELLING_MONTHS, mdRev, i.mdComm * i.mdLapse, i.mdPayout, perPolicy(i.mdAppCost, i.mdPlace), i.mdConv, i.mdPlace, i.mdCallsPerAgent);
  const feasible = Number.isFinite(companyNet) && [fe, md].every((l) => l.target === 0 || (l.perPolicy.net > 0 && Number.isFinite(l.perPolicy.net)));

  const tail = feComm * (1 - i.feAdvance) * (1 - i.feLapse);
  const feRenewPerPolicyYr = feRev * (1 - i.feLapse) * i.feRenew;
  const mdResidPerPolicyYr = mdRev * i.mdRenewPct * (1 - i.mdLapse);
  const upsideCompany = (fe.policiesMo * 12 * feRenewPerPolicyYr + md.policiesMo * MD_SELLING_MONTHS * mdResidPerPolicyYr) * (1 - i.retention) / 12;

  let feMonthReached: number | null = null;
  for (let m = 1; m <= 36 && feMonthReached === null; m++)
    if (i.feCallsStart + i.feCallsQtrInc * Math.floor((m - 1) / 3) >= fe.callsDay - 1e-9) feMonthReached = m;

  return {
    feasible,
    companyNet,
    fe,
    md,
    youEarly: goal - fe.policiesMo * tail * (1 - i.retention) * keepShare,
    upside: upsideCompany * keepShare,
    feMonthReached,
  };
}
