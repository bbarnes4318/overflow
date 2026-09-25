import { describe, expect, it } from 'vitest';
import { buildInputs, decode, encode, results, type Answers } from './answers';

const near = (actual: number, expected: number, tol = 1) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
const each = (actual: number[], expected: number[]) => expected.forEach((v, j) => near(actual[j], v));

const A: Answers = { sells: 'fe', a0: 10, a1: 20, m0: 0, conv: 0.10, pay: 120, goal: 25000, partners: 1 };
const B: Answers = { sells: 'both', a0: 20, a1: 40, m0: 10, conv: 0.10, pay: 120, goal: 25000, partners: 2 };
const C: Answers = { sells: 'md', a0: 10, a1: 15, m0: 0, conv: 0.06, pay: 160, goal: 10000, partners: 1 };
const exit3 = (r: ReturnType<typeof results>) => [r.exit.price.low, r.exit.price.base, r.exit.price.high];

describe('A: Final Expense only', () => {
  const { inputs, feMix } = buildInputs(A);
  const r = results(A);
  it('inputs', () => {
    expect([inputs.feCallsStart, inputs.feCallsQtrInc]).toEqual([200, 50]);
    expect([inputs.mdAgentsY1, inputs.mdAgentsY2, inputs.mdAgentsY3]).toEqual([0, 0, 0]);
    expect(feMix).toBe(1);
  });
  it('results', () => {
    each(r.out.years.map((y) => y.totalNet), [416732.74, 1561509.93, 2576232.58]);
    each(r.takeHome, [34727.73, 130125.83, 214686.05]);
    expect(r.clearsInYear).toBe(1);
    expect([r.agentsNeeded, r.rc.fe.agents, r.rc.md.agents]).toEqual([4, 4, 0]);
    near(r.feAppsDay, 7.43, 0.01);
    near(r.feSpendDay, 1478.58);
    expect(r.feasible).toBe(true);
    each(exit3(r), [7190601.58, 9887077.17, 12583552.76]);
  });
});

describe('B: both, two partners', () => {
  const { inputs, feMix } = buildInputs(B);
  const r = results(B);
  it('inputs', () => {
    expect([inputs.feCallsStart, inputs.feCallsQtrInc]).toEqual([200, 50]);
    expect([inputs.mdAgentsY1, inputs.mdAgentsY2, inputs.mdAgentsY3]).toEqual([10, 20, 30]);
    expect(feMix).toBe(0.5);
    expect([inputs.split1, inputs.split2]).toEqual([0.5, 0.5]);
  });
  it('results', () => {
    each(r.out.years.map((y) => y.totalNet), [881013.76, 3057564.10, 5558053.60]);
    each(r.takeHome, [36708.91, 127398.50, 231585.57]);
    expect(r.clearsInYear).toBe(1);
    expect([r.agentsNeeded, r.rc.fe.agents, r.rc.md.agents]).toEqual([11, 4, 7]);
    near(r.feAppsDay, 7.43, 0.01);
    near(r.mdAppsDay, 16.15, 0.01);
    near(r.feSpendDay + r.mdSpendDay, 4047.07);
    each(exit3(r), [21511573.83, 27965045.98, 34418518.13]);
  });
});

describe('C: Medicare only', () => {
  const { inputs, feMix } = buildInputs(C);
  const r = results(C);
  it('inputs', () => {
    expect([inputs.feCallsStart, inputs.feCallsQtrInc]).toEqual([0, 0]);
    expect([inputs.mdAgentsY1, inputs.mdAgentsY2, inputs.mdAgentsY3]).toEqual([10, 15, 20]);
    expect(feMix).toBe(0);
  });
  it('results', () => {
    each(r.out.years.map((y) => y.totalNet), [228504.61, 683252.19, 1240148.36]);
    each(r.takeHome, [19042.05, 56937.68, 103345.70]);
    expect(r.clearsInYear).toBe(1);
    expect([r.agentsNeeded, r.rc.md.agents]).toEqual([6, 6]);
    near(r.mdAppsDay, 7.88, 0.01);
    near(r.mdSpendDay, 1252.49);
    each(exit3(r), [4148963.88, 5704825.34, 7260686.80]);
  });
});

describe('encode / decode', () => {
  it('round-trips', () => {
    for (const a of [A, B, C]) expect(decode(new URLSearchParams(encode(a)))).toEqual(a);
  });
  it('clamps a1 up to a0 and m0 down to a0', () => {
    const d = decode(new URLSearchParams('s=both&a0=10&a1=3&m0=50&c=0.1&p=120&g=25000&n=1'))!;
    expect(d.a1).toBe(10);
    expect(d.m0).toBe(10);
  });
  it('rejects an unknown line', () => expect(decode(new URLSearchParams('s=xyz&a0=10'))).toBeNull());
});
