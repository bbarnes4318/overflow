import { describe, expect, it } from 'vitest';
import { DEFAULTS, runModel } from './model';
import { exitValue, levers } from './valuation';

const out = runModel(DEFAULTS);
const ex = exitValue(DEFAULTS, out);
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
const each = (f: (e: (typeof ex)[number]) => number, vals: number[]) => vals.forEach((v, y) => near(f(ex[y]), v));

describe('exit value at defaults', () => {
  it('next-12-month renewals', () => {
    each((e) => e.mdFwd, [1447684, 4053515.2, 9033548.16]);
    each((e) => e.feFwd, [111658.37, 404075.15, 843043.54]);
  });
  it('FE owed to seller', () => {
    each((e) => e.receivable, [683373.6, 1659621.6, 2635869.6]);
    near(ex[2].receivable, out.unit.receivableAfter36);
  });
  it('adjusted EBITDA, both lenses, winner', () => {
    each((e) => e.adjEbitda, [972670.51, 4130123.03, 9627343.31]);
    each((e) => e.book.base, [3062855.55, 8713143.12, 19331661.62]);
    expect(ex.map((e) => e.lens)).toEqual(['earnings', 'earnings', 'earnings']);
  });
  it('price range', () => {
    each((e) => e.price.low, [2918011.53, 20650615.14, 48136716.57]);
    each((e) => e.price.base, [3890682.04, 26845799.69, 62577731.54]);
    each((e) => e.price.high, [4863352.55, 33040984.23, 77018746.51]);
  });
  it('deal and walk-away', () => {
    each((e) => e.atClose, [2334409.22, 16107479.81, 37546638.92]);
    each((e) => e.cumProfit, [1500411.82, 7017729.44, 19311799.82]);
    each((e) => e.walkAway, [6074467.46, 35523150.72, 84525400.96]);
    ex.forEach((e) => near(e.atClose + e.earnout, e.price.base));
  });
  it('next tier', () => {
    near(ex[0].nextTier!.gap, 27329.49);
    near(ex[0].nextTier!.tier.floor, 1e6);
    near(ex[2].nextTier!.gap, 372656.69);
    near(ex[2].nextTier!.valueAtFloor, 80000000);
  });
  it('forward renewals match what the next year actually pays', () => {
    near(ex[0].mdFwd, out.years[1].mdResid);
    near(ex[1].mdFwd, out.years[2].mdResid);
    near(ex[0].feFwd, out.years[1].feRenew);
    near(ex[1].feFwd, out.years[2].feRenew);
  });
});

describe('levers at Year 3', () => {
  const l = Object.fromEntries(levers(DEFAULTS, 3).map((x) => [x.label, x.delta]));
  it('price deltas', () => {
    near(l['Medicare lapse 5 pts lower'], 22609572);
    near(l['FE lapse 5 pts lower'], 20624182);
    near(l['Medicare placement 5 pts higher'], 20080391);
    near(l['Overhead 2 pts leaner'], 19774469);
    near(l['FE placement 5 pts higher'], 18303491);
    near(l['Year 3 Medicare team +10 agents'], 2265031);
    near(l['FE applications $10 cheaper'], 1708434);
    near(l['Medicare applications $10 cheaper'], 1694875);
    near(l['Add 10 FE calls/day per quarter'], 1382933);
  });
  it('sorted biggest first', () => {
    const d = levers(DEFAULTS, 3).map((x) => x.delta);
    expect(d).toEqual([...d].sort((a, b) => b - a));
  });
});

describe('exit edge cases', () => {
  it('adjusted EBITDA <= 0 prices as a book', () => {
    const i = { ...DEFAULTS, exitOverhead: 1 };
    const e = exitValue(i, runModel(i));
    e.forEach((y) => {
      expect(y.adjEbitda).toBeLessThanOrEqual(0);
      expect(y.tier.low).toBe(3);
      expect(y.earnings.base).toBe(0);
      expect(y.lens).toBe('book');
    });
  });
  it('applications at $600 each: finite, earnings 0, book lens', () => {
    const i = { ...DEFAULTS, feAppCost: 600, mdAppCost: 600 };
    exitValue(i, runModel(i)).forEach((y) => {
      [y.price.low, y.price.base, y.price.high, y.adjEbitda, y.walkAway, y.book.base].forEach((v) => expect(Number.isFinite(v)).toBe(true));
      expect(y.tier).toBeDefined();
      expect(y.earnings.base).toBe(0);
      expect(y.lens).toBe('book');
    });
  });
  it('all splits 0 gives partners 0, no NaN', () => {
    const i = { ...DEFAULTS, split1: 0, split2: 0, split3: 0, split4: 0 };
    exitValue(i, runModel(i)).forEach((y) =>
      y.partners.forEach((p) => {
        expect(p.share).toBe(0);
        expect(p.atClose).toBe(0);
      }));
  });
});
