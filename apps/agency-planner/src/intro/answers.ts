// Quick Start: five answers → a full Inputs set for the planner, plus the numbers the reveal shows. Pure; no React.
import { DEFAULTS, recipe, runModel, SPLIT_KEYS, type Inputs } from '../engine/model';
import { exitValue } from '../engine/valuation';

export type Sells = 'fe' | 'md' | 'both';
export interface Answers { sells: Sells; a0: number; a1: number; m0: number; conv: number; pay: number; goal: number; partners: number }
export const ANSWERS_DEFAULT: Omit<Answers, 'sells'> = { a0: 10, a1: 20, m0: 5, conv: 0.10, pay: 120, goal: 25000, partners: 1 };

export function buildInputs(a: Answers): { inputs: Inputs; feMix: number } {
  const inputs = { ...DEFAULTS };
  const g = a.a1 / a.a0;
  const fe0 = a.sells === 'fe' ? a.a0 : a.sells === 'md' ? 0 : a.a0 - a.m0;
  const md0 = a.sells === 'md' ? a.a0 : a.sells === 'fe' ? 0 : a.m0;
  inputs.feCallsStart = fe0 * DEFAULTS.feCallsPerAgent;
  inputs.feCallsQtrInc = Math.max(0, ((fe0 * g - fe0) * DEFAULTS.feCallsPerAgent) / 4);
  inputs.mdAgentsY1 = md0;
  inputs.mdAgentsY2 = Math.round(md0 * g);
  inputs.mdAgentsY3 = Math.round(md0 * (2 * g - 1));
  inputs.feConv = inputs.mdConv = a.conv;
  inputs.fePayout = inputs.mdPayout = a.pay;
  inputs.partnerCount = a.partners;
  SPLIT_KEYS.forEach((k, j) => (inputs[k] = j < a.partners ? 1 / a.partners : 0));
  return { inputs, feMix: a.sells === 'fe' ? 1 : a.sells === 'md' ? 0 : fe0 / a.a0 };
}

export function summarize(a: Answers) {
  const { inputs, feMix } = buildInputs(a);
  const out = runModel(inputs);
  const ex = exitValue(inputs, out);
  const rc = recipe(inputs, a.goal, inputs.split1, feMix);
  const takeHome = [0, 1, 2].map((y) => (out.years[y].totalNet * inputs.split1 * (1 - inputs.holdback)) / 12);
  const hit = takeHome.findIndex((v) => v >= a.goal);
  const feAppsDay = rc.fe.appsDay;
  const mdAppsDay = rc.md.appsDay;
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
export type Summary = ReturnType<typeof summarize>;
