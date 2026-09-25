// Guided planner: six answers → a full Inputs set → the numbers the reveal shows. Pure; no React.
import { DEFAULTS, recipe, runModel, SPLIT_KEYS, type Inputs } from '../engine/model';
import { exitValue } from '../engine/valuation';

export type Sells = 'fe' | 'md' | 'both';
export interface Answers { sells: Sells | null; a0: number; a1: number; m0: number; conv: number; pay: number; goal: number; partners: number }
export const ANSWERS_DEFAULT: Answers = { sells: null, a0: 10, a1: 20, m0: 5, conv: 0.10, pay: 120, goal: 25000, partners: 1 };

export function buildInputs(a: Answers): { inputs: Inputs; feMix: number } {
  const inputs = { ...DEFAULTS };
  const a0 = Math.max(1, a.a0);
  const g = Math.max(a0, a.a1) / a0;
  const m0 = Math.min(a0, Math.max(0, a.m0));
  const fe0 = a.sells === 'fe' ? a0 : a.sells === 'md' ? 0 : a0 - m0;
  const md0 = a.sells === 'md' ? a0 : a.sells === 'fe' ? 0 : m0;
  inputs.feCallsStart = fe0 * inputs.feCallsPerAgent;
  // Reaches a1's share of FE agents at month 13, then keeps growing at that pace.
  inputs.feCallsQtrInc = Math.max(0, ((fe0 * g - fe0) * inputs.feCallsPerAgent) / 4);
  inputs.mdAgentsY1 = md0;
  inputs.mdAgentsY2 = Math.round(md0 * g);
  inputs.mdAgentsY3 = Math.round(md0 * (2 * g - 1));
  inputs.feConv = inputs.mdConv = a.conv;
  inputs.fePayout = inputs.mdPayout = a.pay;
  inputs.partnerCount = a.partners;
  SPLIT_KEYS.forEach((k, j) => (inputs[k] = j < a.partners ? 1 / a.partners : 0));
  return { inputs, feMix: a.sells === 'fe' ? 1 : a.sells === 'md' ? 0 : fe0 / a0 };
}

export function results(a: Answers) {
  const { inputs, feMix } = buildInputs(a);
  const out = runModel(inputs);
  const ex = exitValue(inputs, out);
  const rc = recipe(inputs, a.goal, inputs.split1, feMix);
  const takeHome = [0, 1, 2].map((y) => (out.years[y].totalNet * inputs.split1 * (1 - inputs.holdback)) / 12);
  const hit = takeHome.findIndex((v) => v >= a.goal);
  const feAppsDay = rc.fe.appsDay;
  const mdAppsDay = rc.md.appsDay; // Medicare applies in its 5 selling months only
  return {
    inputs, feMix, out, ex, rc, takeHome,
    clearsInYear: hit < 0 ? null : hit + 1,
    agentsNeeded: rc.fe.agents + rc.md.agents,
    feAppsDay, mdAppsDay,
    feSpendDay: feAppsDay * inputs.feAppCost,
    mdSpendDay: mdAppsDay * inputs.mdAppCost,
    exit: ex[2],
    feasible: rc.feasible,
  };
}
export type Results = ReturnType<typeof results>;

export function encode(a: Answers): string {
  return new URLSearchParams({
    s: a.sells ?? '', a0: String(a.a0), a1: String(a.a1), m0: String(a.m0), c: String(a.conv), p: String(a.pay), g: String(a.goal), n: String(a.partners),
  }).toString();
}

export function decode(q: URLSearchParams): Answers | null {
  const s = q.get('s');
  if (s !== 'fe' && s !== 'md' && s !== 'both') return null;
  const num = (k: string, fallback: number) => {
    const v = q.get(k);
    const n = v == null || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const d = ANSWERS_DEFAULT;
  const a0 = Math.round(clamp(num('a0', d.a0), 1, 1000));
  const a1 = Math.round(clamp(num('a1', d.a1), a0, 2000));
  return {
    sells: s, a0, a1,
    m0: Math.round(clamp(num('m0', d.m0), 0, a0)),
    conv: clamp(num('c', d.conv), 0.01, 0.5),
    pay: clamp(num('p', d.pay), 0, 1000),
    goal: clamp(num('g', d.goal), 0, 100000000),
    partners: Math.round(clamp(num('n', d.partners), 1, 6)),
  };
}
