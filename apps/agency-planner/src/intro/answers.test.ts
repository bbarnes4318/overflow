import { describe, expect, it } from 'vitest';
import { buildInputs, summarize, type Answers } from './answers';

const near = (actual: number, expected: number, tol = 1) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
const each = (actual: number[], expected: number[]) => expected.forEach((v, j) => near(actual[j], v));
const exit = (s: ReturnType<typeof summarize>) => [s.exit.price.low, s.exit.price.base, s.exit.price.high];

const A: Answers = { sells: 'fe', a0: 10, a1: 20, m0: 0, conv: 0.10, pay: 120, goal: 25000, partners: 1 };
const B: Answers = { sells: 'both', a0: 20, a1: 40, m0: 10, conv: 0.10, pay: 120, goal: 25000, partners: 2 };
const C: Answers = { sells: 'md', a0: 10, a1: 15, m0: 0, conv: 0.06, pay: 160, goal: 10000, partners: 1 };

describe('A: Final Expense only', () => {
  const { inputs, feMix } = buildInputs(A);
  const s = summarize(A);
  it('inputs', () => {
    expect([inputs.feCallsStart, inputs.feCallsQtrInc]).toEqual([200, 50]);
    expect([inputs.mdAgentsY1, inputs.mdAgentsY2, inputs.mdAgentsY3]).toEqual([0, 0, 0]);
    expect(feMix).toBe(1);
  });
  it('summary', () => {
    each(s.out.years.map((y) => y.totalNet), [416732.74, 1561509.93, 2576232.58]);
    each(s.takeHome, [34727.73, 130125.83, 214686.05]);
    expect(s.clearsInYear).toBe(1);
    expect(s.agentsNeeded).toBe(4);
    near(s.feAppsDay, 7.43, 0.01);
    near(s.feSpendDay, 1478.58);
    expect(s.feasible).toBe(true);
    each(exit(s), [7190601.58, 9887077.17, 12583552.76]);
  });
});

describe('B: both, two partners', () => {
  const { inputs, feMix } = buildInputs(B);
  const s = summarize(B);
  it('inputs', () => {
    expect([inputs.feCallsStart, inputs.feCallsQtrInc]).toEqual([200, 50]);
    expect([inputs.mdAgentsY1, inputs.mdAgentsY2, inputs.mdAgentsY3]).toEqual([10, 20, 30]);
    expect(feMix).toBe(0.5);
    expect([inputs.split1, inputs.split2]).toEqual([0.5, 0.5]);
  });
  it('summary', () => {
    each(s.out.years.map((y) => y.totalNet), [881013.76, 3057564.10, 5558053.60]);
    each(s.takeHome, [36708.91, 127398.50, 231585.57]);
    expect(s.clearsInYear).toBe(1);
    expect([s.agentsNeeded, s.rc.fe.agents, s.rc.md.agents]).toEqual([11, 4, 7]);
    near(s.feAppsDay, 7.43, 0.01);
    near(s.mdAppsDay, 16.15, 0.01);
    near(s.feSpendDay + s.mdSpendDay, 4047.07);
    each(exit(s), [21511573.83, 27965045.98, 34418518.13]);
  });
});

describe('C: Medicare only', () => {
  const { inputs, feMix } = buildInputs(C);
  const s = summarize(C);
  it('inputs', () => {
    expect([inputs.feCallsStart, inputs.feCallsQtrInc]).toEqual([0, 0]);
    expect([inputs.mdAgentsY1, inputs.mdAgentsY2, inputs.mdAgentsY3]).toEqual([10, 15, 20]);
    expect(feMix).toBe(0);
  });
  it('summary', () => {
    each(s.out.years.map((y) => y.totalNet), [228504.61, 683252.19, 1240148.36]);
    each(s.takeHome, [19042.05, 56937.68, 103345.70]);
    expect(s.clearsInYear).toBe(1);
    expect(s.agentsNeeded).toBe(6);
    near(s.mdAppsDay, 7.88, 0.01);
    near(s.mdSpendDay, 1252.49);
    each(exit(s), [4148963.88, 5704825.34, 7260686.80]);
  });
});
