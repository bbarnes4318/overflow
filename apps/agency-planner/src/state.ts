// Advanced planner state: URL params → localStorage → defaults. Moved here unchanged from Advanced.tsx so the
// guided planner can build Advanced links with the same encoding.
import { DEFAULTS, MAX_PARTNERS, type InputKey, type Inputs } from './engine/model';
import { GOAL_DEFAULT, type GoalState } from './Goal';

export const ALL_KEYS = Object.keys(DEFAULTS) as InputKey[];
export const DEFAULT_NAMES = Array.from({ length: MAX_PARTNERS }, (_, i) => `Partner ${i + 1}`);


export const LS_KEY = 'netenroll-agency-planner-v1';
export type Page = 'Planner' | 'Income goal' | 'Exit value';
export const PAGE_PARAM: Partial<Record<Page, string>> = { 'Income goal': 'goal', 'Exit value': 'exit' };
export type State = { inputs: Inputs; names: string[]; goal: GoalState; page: Page };

// Goal fields arrive from URLs/storage as strings or junk; keep only sane values.
export function readGoal(src: Record<string, unknown> | undefined): GoalState {
  const g = { ...GOAL_DEFAULT };
  const n = (v: unknown) => (v == null || v === '' ? NaN : Number(v));
  const a = n(src?.amount), p = n(src?.partner), m = n(src?.feMix);
  if (a >= 0 && a <= 1e8) g.amount = a;
  if (Number.isInteger(p) && p >= 0 && p < MAX_PARTNERS) g.partner = p;
  if (m >= 0 && m <= 1) g.feMix = m;
  return g;
}

export function loadState(): State {
  const inputs = { ...DEFAULTS };
  const names = [...DEFAULT_NAMES];
  let goal = GOAL_DEFAULT;
  let page: Page = 'Planner';
  const q = new URLSearchParams(location.search);
  let src: Record<string, unknown> | null = null;
  if ([...q.keys()].length) {
    src = Object.fromEntries(q);
    DEFAULT_NAMES.forEach((_, i) => q.has(`n${i + 1}`) && (names[i] = q.get(`n${i + 1}`)!));
    goal = readGoal({ amount: q.get('goal'), partner: q.get('goalPartner'), feMix: q.get('goalMix') });
    page = (Object.keys(PAGE_PARAM) as Page[]).find((p) => PAGE_PARAM[p] === q.get('page')) ?? 'Planner';
  } else {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
      if (s) {
        src = s.inputs;
        if (Array.isArray(s.names)) s.names.slice(0, MAX_PARTNERS).forEach((n: unknown, i: number) => typeof n === 'string' && (names[i] = n));
        goal = readGoal(s.goal);
        if (s.page === 'Income goal' || s.page === 'Exit value') page = s.page;
      }
    } catch { /* ignore corrupt storage */ }
  }
  if (src) for (const k of ALL_KEYS) {
    const n = Number(src[k]);
    if (src[k] != null && Number.isFinite(n)) inputs[k] = n;
  }
  return { inputs, names, goal, page };
}

export function shareQuery({ inputs, names, goal, page }: State) {
  const q = new URLSearchParams();
  for (const k of ALL_KEYS) if (inputs[k] !== DEFAULTS[k]) q.set(k, String(inputs[k]));
  names.forEach((n, i) => n !== DEFAULT_NAMES[i] && q.set(`n${i + 1}`, n));
  if (goal.amount !== GOAL_DEFAULT.amount) q.set('goal', String(goal.amount));
  if (goal.partner !== GOAL_DEFAULT.partner) q.set('goalPartner', String(goal.partner));
  if (goal.feMix !== GOAL_DEFAULT.feMix) q.set('goalMix', String(goal.feMix));
  if (PAGE_PARAM[page]) q.set('page', PAGE_PARAM[page]!);
  return q.toString();
}
