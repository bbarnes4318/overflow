// Exit value: what the agency would sell for at the end of Year 1, 2 and 3. Pure; the UI never does math.
import { runModel, type InputKey, type Inputs, type Outputs } from './model';

export interface Tier { floor: number; low: number; base: number; high: number; buyer: string }

// Size-based multiples of adjusted EBITDA. Below P&C platform multiples: FE/Medicare call-center revenue
// depends on continued lead spend and on CMS/carrier commission changes.
export const EARNINGS_TIERS: Tier[] = [
  { floor: -Infinity, low: 3, base: 4, high: 5, buyer: 'Owner-operator or small agency' },
  { floor: 1e6, low: 4, base: 5.5, high: 7, buyer: 'PE-backed aggregator' },
  { floor: 3e6, low: 5, base: 6.5, high: 8, buyer: 'PE-backed aggregator' },
  { floor: 1e7, low: 6, base: 8, high: 10, buyer: 'National platform' },
];

export type Range = { low: number; base: number; high: number };
export type Lens = 'earnings' | 'book';

export interface YearExit {
  y: number;
  mdFwd: number; // Medicare renewals the book pays in the next 12 months
  feFwd: number; // FE renewals in the next 12 months
  receivable: number; // FE months 10–12 money earned but not yet paid; the seller keeps it
  ttmNet: number;
  ttmRev: number;
  overhead: number;
  adjEbitda: number;
  tier: Tier;
  book: Range;
  earnings: Range;
  lens: Lens;
  price: Range;
  atClose: number;
  earnout: number;
  afterTax: number;
  partners: { share: number; atClose: number }[];
  cumProfit: number;
  walkAway: number; // total wealth if you exit here
  lockedIn: number; // next year's renewals already in force beyond what trailing earnings paid for
  nextTier: { tier: Tier; gap: number; valueAtFloor: number } | null;
  buyer: string;
}

const range = (v: number, [l, b, h]: number[]): Range => ({ low: v * l, base: v * b, high: v * h });

export function exitValue(i: Inputs, out: Outputs): YearExit[] {
  const mdKeep = 1 - i.mdLapse;
  const feKeep = 1 - i.feLapse;
  const splits = [i.split1, i.split2, i.split3, i.split4];
  let cumProfit = 0;
  return [1, 2, 3].map((y) => {
    const Y = out.years[y - 1];
    let mdFwd = 0;
    let feFwd = 0;
    for (let k = 1; k <= y; k++) {
      const s = out.years[k - 1];
      mdFwd += s.mdNew * i.mdRenewPct * mdKeep ** (y - k + 1);
      feFwd += (s.feAdv + s.feTail) * feKeep ** (y - k + 1) * i.feRenew;
    }
    const receivable = out.fe.slice(0, 12 * y).reduce((a, r) => a + r.tailEarned - r.tailCash, 0);
    const overhead = i.exitOverhead * Y.totalRev;
    const adjEbitda = Y.totalNet - overhead;
    // Everything under $1M, including zero and negative (and NaN), is priced on the first tier.
    const tier = [...EARNINGS_TIERS].reverse().find((t) => adjEbitda >= t.floor) ?? EARNINGS_TIERS[0];
    const book = range(mdFwd * i.exitMdBookMult + feFwd * i.exitFeBookMult, [0.75, 1, 1.25]);
    const earnings = range(Math.max(0, adjEbitda), [tier.low, tier.base, tier.high]);
    const lens: Lens = earnings.base > book.base ? 'earnings' : 'book';
    const price = lens === 'earnings' ? earnings : book;
    const atClose = price.base * i.exitClosePct;
    const afterTax = price.base * (1 - i.exitSaleTax);
    cumProfit += Y.totalNet;
    const next = EARNINGS_TIERS.find((t) => t.floor > adjEbitda);
    return {
      y, mdFwd, feFwd, receivable, ttmNet: Y.totalNet, ttmRev: Y.totalRev, overhead, adjEbitda, tier, book, earnings, lens, price,
      atClose,
      earnout: price.base - atClose,
      afterTax,
      partners: splits.map((s) => ({ share: afterTax * s, atClose: afterTax * s * i.exitClosePct })),
      cumProfit,
      walkAway: cumProfit + price.base + receivable,
      lockedIn: mdFwd + feFwd - (Y.mdResid + Y.feRenew),
      nextTier: next ? { tier: next, gap: next.floor - adjEbitda, valueAtFloor: next.floor * next.base } : null,
      buyer: lens === 'book' ? 'Book buyer: FMO or larger agency' : tier.buyer,
    };
  });
}

// What each operating improvement is worth in the Year-y sale price, biggest first.
export function levers(i: Inputs, y: 1 | 2 | 3): { label: string; delta: number }[] {
  const price = (x: Inputs) => exitValue(x, runModel(x))[y - 1].price.base;
  const now = price(i);
  const team = `mdAgentsY${y}` as InputKey;
  const moves: [string, InputKey, number][] = [
    ['Medicare lapse 5 pts lower', 'mdLapse', Math.max(0, i.mdLapse - 0.05)],
    ['FE lapse 5 pts lower', 'feLapse', Math.max(0, i.feLapse - 0.05)],
    ['FE placement 5 pts higher', 'fePlace', Math.min(1, i.fePlace + 0.05)],
    ['Medicare placement 5 pts higher', 'mdPlace', Math.min(1, i.mdPlace + 0.05)],
    ['FE applications $10 cheaper', 'feAppCost', Math.max(0, i.feAppCost - 10)],
    ['Medicare applications $10 cheaper', 'mdAppCost', Math.max(0, i.mdAppCost - 10)],
    ['Add 10 FE calls/day per quarter', 'feCallsQtrInc', i.feCallsQtrInc + 10],
    ['Overhead 2 pts leaner', 'exitOverhead', Math.max(0, i.exitOverhead - 0.02)],
    [`Year ${y} Medicare team +10 agents`, team, i[team] + 10],
  ];
  return moves.map(([label, k, v]) => ({ label, delta: price({ ...i, [k]: v }) - now })).sort((a, b) => b.delta - a.delta);
}
