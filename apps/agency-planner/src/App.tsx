import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULTS, feCommOf, MAX_PARTNERS, MD_MONTHS, partnerCountOf, runModel, SPLIT_KEYS, type Chain, type InputKey, type Inputs, type Outputs } from './engine/model';
import { CashFlowChart, MedicareChart, OverviewChart, TeamChart, C } from './Charts';
import { Card, useCountUp } from './ui';
import { Goal, GOAL_DEFAULT, type GoalState } from './Goal';
import { Exit } from './Exit';
import { exitValue, type YearExit } from './engine/valuation';
import { compact, count, FE_ROWS, fmt, int, MD_ROWS, money, num1, pct, SUMMARY_ROWS } from './format';

// ---------- controls ----------
type Unit = '$' | '%' | 'calls' | 'agents' | 'days' | 'x';
type Ctl = [InputKey, string, number, number, number, Unit]; // key, label, min, max, step (display units), unit

type Line = 'Final Expense' | 'Medicare' | 'Company';
type Group = [string, Ctl[], ((i: Inputs) => string)?]; // title, controls, optional live note under the group
const LINES: { name: Line; color: string; groups: Group[] }[] = [
  { name: 'Final Expense', color: C.fe, groups: [
    ['Lead volume', [
      ['feCallsStart', 'Calls per day (start)', 0, 2000, 10, 'calls'],
      ['feCallsQtrInc', 'Added each quarter', 0, 1000, 10, 'calls'],
      ['feCallsPerAgent', 'Calls per agent per day', 1, 100, 1, 'calls'],
      ['feAppCost', 'Cost per submitted application', 0, 600, 1, '$'],
    ]],
    ['Conversion', [
      ['feConv', 'Calls → applications', 0, 50, 0.5, '%'],
      ['fePlace', 'Applications placed', 0, 100, 1, '%'],
      ['feLapse', 'Lapse rate', 0, 80, 1, '%'],
    ]],
    ['Commission & payout', [
      ['feMonthlyPremium', 'Average monthly premium', 10, 300, 1, '$'],
      ['feCommRate', 'Commission rate (blended)', 30, 150, 1, '%'],
      ['feAdvance', 'Paid up front', 0, 100, 1, '%'],
      ['feRenew', 'Renewal rate', 0, 25, 0.5, '%'],
      ['fePayout', 'Agency pays agent per placed policy', 0, 500, 5, '$'],
    ], (i) => `Blended: level plans pay 120–130%, guaranteed issue 60–80%. First-year commission per policy: ${money(feCommOf(i))}.`],
  ] },
  { name: 'Medicare', color: C.md, groups: [
    ['Team & leads', [
      ['mdAgentsY1', 'Agents – Year 1', 0, 500, 1, 'agents'],
      ['mdAgentsY2', 'Agents – Year 2', 0, 500, 1, 'agents'],
      ['mdAgentsY3', 'Agents – Year 3', 0, 500, 1, 'agents'],
      ['mdCallsPerAgent', 'Calls per agent per day', 1, 100, 1, 'calls'],
      ['mdAppCost', 'Cost per submitted application', 0, 600, 1, '$'],
    ]],
    ['Conversion', [
      ['mdConv', 'Calls → applications', 0, 50, 0.5, '%'],
      ['mdPlace', 'Applications placed', 0, 100, 1, '%'],
      ['mdLapse', 'Lapse rate', 0, 80, 1, '%'],
    ]],
    ['Commission & payout', [
      ['mdComm', 'Commission / policy', 0, 1500, 10, '$'],
      ['mdRenewPct', 'Renewal (% of first-year)', 0, 100, 1, '%'],
      ['mdPayout', 'Agency pays agent per placed policy', 0, 500, 5, '$'],
    ]],
  ] },
  { name: 'Company', color: C.net, groups: [
    ['Company', [
      ['workDays', 'Working days per month', 15, 26, 0.01, 'days'],
      ['retention', 'Retention cost (% of revenue)', 0, 10, 0.1, '%'],
      ['holdback', 'Tax / reserve holdback', 0, 60, 1, '%'],
    ]],
    ['Exit valuation', [
      ['exitMdBookMult', 'Medicare book multiple', 0.5, 4, 0.1, 'x'],
      ['exitFeBookMult', 'FE book multiple', 0.5, 4, 0.1, 'x'],
      ['exitOverhead', 'Overhead buyers deduct', 0, 30, 0.5, '%'],
      ['exitClosePct', 'Cash at close', 0, 100, 5, '%'],
      ['exitSaleTax', 'Tax on sale', 0, 50, 1, '%'],
    ]],
    ['Compare', [
      ['comparePerCall', 'Pay-per-call price to compare', 0, 150, 1, '$'],
    ]],
  ] },
];
const ALL_KEYS = Object.keys(DEFAULTS) as InputKey[];
const DEFAULT_NAMES = Array.from({ length: MAX_PARTNERS }, (_, i) => `Partner ${i + 1}`);

const toDisplay = (unit: Unit, v: number) => (unit === '%' ? +(v * 100).toFixed(4) : v);
const fromDisplay = (unit: Unit, v: number) => (unit === '%' ? v / 100 : v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------- persistence: URL params → localStorage → defaults ----------
const LS_KEY = 'netenroll-agency-planner-v1';
type Page = 'Planner' | 'Income goal' | 'Exit value';
const PAGE_PARAM: Partial<Record<Page, string>> = { 'Income goal': 'goal', 'Exit value': 'exit' };
type State = { inputs: Inputs; names: string[]; goal: GoalState; page: Page };

// Goal fields arrive from URLs/storage as strings or junk; keep only sane values.
function readGoal(src: Record<string, unknown> | undefined): GoalState {
  const g = { ...GOAL_DEFAULT };
  const n = (v: unknown) => (v == null || v === '' ? NaN : Number(v));
  const a = n(src?.amount), p = n(src?.partner), m = n(src?.feMix);
  if (a >= 0 && a <= 1e8) g.amount = a;
  if (Number.isInteger(p) && p >= 0 && p < MAX_PARTNERS) g.partner = p;
  if (m >= 0 && m <= 1) g.feMix = m;
  return g;
}

function loadState(): State {
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

function shareQuery({ inputs, names, goal, page }: State) {
  const q = new URLSearchParams();
  for (const k of ALL_KEYS) if (inputs[k] !== DEFAULTS[k]) q.set(k, String(inputs[k]));
  names.forEach((n, i) => n !== DEFAULT_NAMES[i] && q.set(`n${i + 1}`, n));
  if (goal.amount !== GOAL_DEFAULT.amount) q.set('goal', String(goal.amount));
  if (goal.partner !== GOAL_DEFAULT.partner) q.set('goalPartner', String(goal.partner));
  if (goal.feMix !== GOAL_DEFAULT.feMix) q.set('goalMix', String(goal.feMix));
  if (PAGE_PARAM[page]) q.set('page', PAGE_PARAM[page]!);
  return q.toString();
}

// ---------- CSV ----------
function exportCsv(out: Outputs, ex: YearExit[]) {
  const esc = (s: string | number) => (typeof s === 'number' ? String(Math.round(s * 100) / 100) : `"${s.replace(/"/g, '""')}"`);
  const lines: (string | number)[][] = [];
  lines.push(['Final Expense monthly'], ['Row', ...out.fe.map((r) => `Month ${r.month}`)]);
  FE_ROWS.forEach(([k, l]) => lines.push([l, ...out.fe.map((r) => r[k])]));
  lines.push([], ['Medicare per selling month'], ['Row', ...out.md.flatMap((_, y) => MD_MONTHS.map((m) => `Y${y + 1} ${m}`))]);
  MD_ROWS.forEach(([k, l]) => lines.push([l, ...out.md.flatMap((r) => MD_MONTHS.map(() => r[k]))]));
  lines.push([], ['3-Year Summary'], ['Row', 'Year 1', 'Year 2', 'Year 3']);
  SUMMARY_ROWS.forEach(([k, l]) => lines.push([l, ...out.years.map((y) => y[k])]));
  lines.push([], ['Exit value'], ['Row', 'Year 1', 'Year 2', 'Year 3']);
  ([
    ['Medicare renewals next 12 mo', (e) => e.mdFwd], ['FE renewals next 12 mo', (e) => e.feFwd], ['FE owed to seller', (e) => e.receivable],
    ['Adjusted EBITDA', (e) => e.adjEbitda], ['Earnings multiple', (e) => e.tier.base], ['Book value', (e) => e.book.base],
    ['Earnings value', (e) => e.earnings.base], ['Priced on', (e) => (e.lens === 'earnings' ? 'Earnings' : 'Book')],
    ['Low', (e) => e.price.low], ['Base', (e) => e.price.base], ['High', (e) => e.price.high], ['Cash at close', (e) => e.atClose],
    ['Earnout', (e) => e.earnout], ['Profit taken to date', (e) => e.cumProfit], ['Total if sold here', (e) => e.walkAway],
  ] as [string, (e: YearExit) => string | number][]).forEach(([l, f]) => lines.push([l, ...ex.map(f)]));
  const blob = new Blob([lines.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'agency-planner.csv' });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- small components ----------
function Control({ ctl, value, onChange, accent }: { ctl: Ctl; value: number; onChange: (v: number) => void; accent: string }) {
  const [key, label, min, max, step, unit] = ctl;
  const shown = toDisplay(unit, value);
  const [draft, setDraft] = useState(String(shown));
  useEffect(() => setDraft(String(shown)), [shown]);
  const changed = Math.abs(value - DEFAULTS[key]) > 1e-9;
  const set = (d: number) => onChange(fromDisplay(unit, clamp(d, min, max)));
  const fill = `${((clamp(shown, min, max) - min) / (max - min)) * 100}%`;
  return (
    <div className="flex h-[62px] flex-col justify-center gap-2 px-3.5">
      <div className="flex items-center gap-2">
        <span className="line-clamp-2 text-[13px] leading-[15px] text-sub">{label}</span>
        {changed && (
          <button title="Changed — click to reset" onClick={() => onChange(DEFAULTS[key])}
            className="h-1.5 w-1.5 shrink-0 rounded-full hover:scale-150" style={{ background: accent }} />
        )}
        <div className="ml-auto flex h-7 w-[96px] shrink-0 items-center rounded-md bg-white px-2 text-[13px] ring-1 ring-line focus-within:ring-2 focus-within:ring-brand">
          {unit === '$' && <span className="text-muted">$</span>}
          <input type="number" aria-label={`${label} value`} min={min} max={max} step={step} value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              const n = e.target.valueAsNumber;
              if (Number.isFinite(n) && n >= min && n <= max) set(n);
            }}
            onBlur={() => (Number.isFinite(+draft) && draft !== '' ? set(+draft) : setDraft(String(shown)))}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="w-full min-w-0 bg-transparent text-right font-medium text-ink outline-none" />
          {unit !== '$' && <span className="ml-1 text-[12px] text-muted">{unit === '%' ? '%' : unit}</span>}
        </div>
      </div>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={shown} onChange={(e) => set(+e.target.value)}
        className="w-full cursor-pointer" style={{ ['--accent' as string]: accent, ['--fill' as string]: fill }} />
    </div>
  );
}

function Tabs<T extends string>({ value, options, onChange }: { value: T; options: T[]; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${o === value ? 'bg-surface2 text-ink ring-1 ring-line' : 'text-muted hover:text-ink'}`}>
          {o}
        </button>
      ))}
    </div>
  );
}

const Btn = ({ onClick, children, outline }: { onClick: () => void; children: ReactNode; outline?: boolean }) => (
  <button onClick={onClick}
    className={`h-8 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors ${outline ? 'bg-white text-ink ring-1 ring-line hover:bg-surface2' : 'text-sub hover:bg-surface2 hover:text-ink'}`}>
    {children}
  </button>
);

const SIGNUP = 'https://agents.netenroll.com/login?mode=create';
const SignupBtn = ({ className = '' }: { className?: string }) => (
  <a href={SIGNUP} className={`inline-flex items-center justify-center rounded-md bg-brand px-3.5 font-semibold text-white transition-colors hover:bg-[#094a36] ${className}`}>
    Open my producer account
  </a>
);
const Logo = ({ className = '' }: { className?: string }) => (
  <a href="https://netenroll.com/" aria-label="NetEnroll home" className="shrink-0">
    <img src="/netenroll-logo.png" width={918} height={179} alt="NetEnroll" className={`w-auto ${className}`} />
  </a>
);

function PeriodCard({ label, net, rev, active, onClick, pill, onPill }: {
  label: string; net: number; rev: number; active: boolean; onClick: () => void; pill: string; onPill: () => void;
}) {
  const n = useCountUp(net);
  return (
    <button onClick={onClick} aria-pressed={active}
      className={`flex min-w-0 flex-1 flex-col justify-center rounded-xl px-5 text-left ring-1 transition-colors ${active ? 'bg-white ring-2 ring-brand' : 'bg-surface ring-line/70 hover:bg-surface2/60'}`}>
      <div className="flex items-center justify-between text-[13px]">
        <span className={`truncate ${active ? 'font-semibold text-ink' : 'text-muted'}`}>{label}</span>
        {/* a span, not a button: buttons can't nest */}
        <span role="button" tabIndex={0} title="Open Exit value"
          onClick={(e) => { e.stopPropagation(); onPill(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onPill(); } }}
          className="ml-2 shrink-0 rounded-full bg-net/10 px-2 text-[11px] font-semibold leading-[18px] text-netink ring-1 ring-net/30 hover:bg-net/20">{pill}</span>
      </div>
      <div title={money(net)} className={`tnum text-[26px] font-semibold leading-9 ${n < 0 ? 'text-cost' : 'text-ink'}`}>{compact(n)}</div>
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>net profit on <span className="text-sub" title={money(rev)}>{compact(rev)}</span></span>
        {active && <span className="rounded bg-ink px-1.5 text-[10px] font-semibold uppercase leading-4 text-canvas">Showing</span>}
      </div>
    </button>
  );
}

type StepProps = { label: string; value: string; exact?: string; sub: ReactNode; breakdown?: [string, number][]; tone?: string; bar?: number; grow?: number };

function Step({ label, value, exact, sub, breakdown, tone = 'text-ink', bar, grow = 1 }: StepProps) {
  return (
    <div className={`group relative flex min-w-0 flex-col rounded-lg bg-surface2/70 px-3 py-2.5`} style={{ flex: `${grow} 1 0%` }}>
      <div className="truncate text-[11px] font-medium uppercase leading-4 tracking-wide text-muted">{label}</div>
      <div title={exact} className={`tnum mt-1 truncate text-[20px] font-semibold leading-6 ${tone}`}>{value}</div>
      <div className="mt-1 text-[11px] leading-[14px] text-muted">{sub}</div>
      {bar !== undefined && (
        <div className="mt-auto h-1 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-net" style={{ width: `${Math.max(0, Math.min(1, bar)) * 100}%` }} />
        </div>
      )}
      {breakdown && (
        <div className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 hidden w-[290px] -translate-x-1/2 rounded-lg bg-white px-3 py-2.5 text-[12px] leading-[18px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.18)] ring-1 ring-line group-hover:block">
          {breakdown.map(([l, v]) => (
            <div key={l} className="flex justify-between gap-4">
              <span className="text-muted">{l}</span><span className="tnum text-ink">{money(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const Arrow = () => (
  <svg viewBox="0 0 12 24" className="h-6 w-3 shrink-0 self-center text-muted" aria-hidden><path d="M2 4l7 8-7 8" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
);

function ChainRow({ name, color, c, agentsSub, revSub, rates, netPerPolicy }: {
  name: string; color: string; c: Chain; agentsSub: string; revSub: string; rates: { conv: number; place: number }; netPerPolicy: number;
}) {
  const range = (a: number, b: number, f: (v: number) => string) => (Math.abs(a - b) < 1e-9 ? f(b) : `${f(a)} → ${f(b)}`);
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-ink">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />{name}
      </div>
      <div className="flex h-[92px] items-stretch gap-1">
        <Step label="Agents" value={range(c.agentsStart, c.agentsEnd, int)} sub={agentsSub} />
        <Arrow />
        <Step label="Calls" value={count(c.calls)} exact={int(c.calls)} sub={`${range(c.callsPerDayStart, c.callsPerDayEnd, int)} a day`} />
        <Arrow />
        <Step label="Applications" value={count(c.apps)} exact={int(c.apps)} sub={`${pct(rates.conv)} of calls`} />
        <Arrow />
        <Step label="Policies" value={count(c.placed)} exact={int(c.placed)} sub={`${pct(rates.place)} of apps placed`} />
        <Arrow />
        <Step label="Revenue" value={compact(c.revenue)} exact={money(c.revenue)} sub={revSub} grow={1.35} breakdown={[...c.revParts, ['Total revenue', c.revenue]]} />
        <Arrow />
        <Step label="Costs" value={compact(c.costs)} exact={money(c.costs)} sub="Hover for breakdown" tone="text-sub"
          breakdown={[['Agent pay (your agency pays)', c.payouts], ['Application costs (your agency pays)', c.callCosts], ['Chargebacks (lapses)', c.chargebacks], ['Retention cost', c.retention], ['Total costs', c.costs]]} />
        <Arrow />
        <Step label="Net profit" value={compact(c.net)} exact={money(c.net)} sub={`${pct(c.margin)} margin · ${money(netPerPolicy)}/policy`} tone={c.net < 0 ? 'text-cost' : 'text-net'} bar={c.margin} grow={1.25} />
      </div>
    </div>
  );
}

function Modal({ title, onClose, children, width }: { title: string; onClose: () => void; children: ReactNode; width: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink/40" onMouseDown={onClose}>
      <div className="rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-line" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">{title}</h2>
          <button onClick={onClose} className="h-8 w-8 rounded-md text-muted hover:bg-surface2 hover:text-ink">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
const LOA_NOTE = "Your agents write under your agency's contracts. Carriers pay commissions to your agency. Your agency pays your agents per placed policy and pays for the calls. Your agents pay nothing for leads.";

function LoaPill() {
  return (
    <span tabIndex={0} aria-describedby="loa-note"
      className="group relative shrink-0 cursor-help rounded-full px-2 text-[11px] font-semibold leading-[18px] text-brand ring-1 ring-brand">
      LOA model
      <span id="loa-note" role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-40 mt-2 hidden w-[340px] rounded-lg bg-white px-3 py-2.5 text-[12px] font-normal leading-[18px] text-sub shadow-[0_8px_24px_-6px_rgba(15,23,42,0.18)] ring-1 ring-line group-hover:block group-focus:block">
        {LOA_NOTE}
      </span>
    </span>
  );
}

// Display only: what the same volume would cost at a per-call price. Feeds no other number.
function Compare({ c, perCall }: { c: Outputs['compare']; perCall: number }) {
  return (
    <Card className="shrink-0 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="shrink-0 text-[14px] font-semibold">vs paying per call</h2>
        {c.savedTotal >= 0 && (
          <span className="flex items-baseline gap-1.5">
            <span title={money(c.savedTotal)} className="tnum text-[22px] font-semibold leading-7 text-net">{compact(c.savedTotal)}</span>
            <span className="text-[12px] text-sub">kept over 3 years</span>
          </span>
        )}
      </div>
      <p className="mt-1 text-[12px] leading-[16px] text-sub">
        At {money(perCall)} a call, a Final Expense policy costs {money(c.fePerPolicyCall)} in calls. Per submitted application it's {money(c.fePerPolicyApp)}.
      </p>
      <p className="mt-1 text-[12px] leading-[16px] text-sub">
        At {money(perCall)} a call, a Medicare policy costs {money(c.mdPerPolicyCall)} in calls. Per submitted application it's {money(c.mdPerPolicyApp)}.
      </p>
      {c.savedTotal < 0 && (
        <div className="mt-1.5 text-[13px] text-sub">Paying per call would cost {compact(-c.savedTotal)} less at these numbers</div>
      )}
    </Card>
  );
}

// ---------- app ----------
type View = 'Cash flow' | 'Team' | 'Profit by year' | 'Medicare' | 'Table';
const PERIODS = ['Year 1', 'Year 2', 'Year 3', 'All 3 years'];

export default function App() {
  const [state, setState] = useState<State>(loadState);
  const { inputs, names, goal, page } = state;
  const out = useMemo(() => runModel(inputs), [inputs]);
  const ex = useMemo(() => exitValue(inputs, out), [inputs, out]);
  const [exitYear, setExitYear] = useState<1 | 2 | 3>(3);
  const [tab, setTab] = useState<Line>('Final Expense');
  const [period, setPeriod] = useState(3);
  const [view, setView] = useState<View>('Cash flow');
  const [modal, setModal] = useState<null | 'notes' | 'month'>(null);
  const [detailYear, setDetailYear] = useState<'Year 1' | 'Year 2' | 'Year 3'>('Year 1');
  const [copied, setCopied] = useState(false);
  const [box, setBox] = useState({ s: 1, w: 1440, h: 840 });
  const [narrow, setNarrow] = useState(() => innerWidth < 1024);
  const [openAnyway, setOpenAnyway] = useState(false);

  useEffect(() => {
    // Design is at least 1440×840; scale to fit, then let the canvas fill the window exactly (no letterboxing).
    const f = () => {
      const s = Math.min(innerWidth / 1440, innerHeight / 840);
      // Under 1024px ("Open anyway") keep the design's own 1440×840 so a portrait phone doesn't stretch it tall.
      setBox(innerWidth < 1024 ? { s, w: 1440, h: 840 } : { s, w: innerWidth / s, h: innerHeight / s });
      setNarrow(innerWidth < 1024);
    };
    f();
    addEventListener('resize', f);
    return () => removeEventListener('resize', f);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
    const q = shareQuery(state);
    history.replaceState(null, '', q ? `?${q}` : location.pathname);
  }, [state]);

  const setInput = (k: InputKey, v: number) => setState((s) => ({ ...s, inputs: { ...s.inputs, [k]: v } }));
  const setGoal = (goal: GoalState) => setState((s) => ({ ...s, goal }));
  const setPage = (page: Page) => setState((s) => ({ ...s, page }));
  const openExit = (y: 1 | 2 | 3) => { setExitYear(y); setPage('Exit value'); };
  const bestExit = ex.reduce((a, b) => (b.walkAway > a.walkAway ? b : a)).y as 1 | 2 | 3;
  // Changing the number of partners splits the company evenly among them; edit the splits after.
  const setPartners = (n: number) => setState((s) => {
    const count = Math.min(MAX_PARTNERS, Math.max(1, n));
    const inputs = { ...s.inputs, partnerCount: count };
    SPLIT_KEYS.forEach((k, j) => (inputs[k] = j < count ? 1 / count : 0));
    return { ...s, inputs, goal: { ...s.goal, partner: Math.min(s.goal.partner, count - 1) } };
  });
  const setName = (i: number, n: string) => setState((s) => ({ ...s, names: s.names.map((x, j) => (j === i ? n : x)) }));
  const splitsOk = Math.abs(out.splitTotal - 1) < 1e-6;
  const line = LINES.find((l) => l.name === tab)!;
  const detailMonths = out.fe.slice((+detailYear.slice(-1) - 1) * 12, +detailYear.slice(-1) * 12);
  const p = out.periods[period];
  const partnerCol = (i: number) => (period < 3 ? out.partners[i].yearly[period] : out.partners[i].total);

  if (narrow && !openAnyway) return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-surface p-4">
      <div className="w-full max-w-[420px] rounded-2xl bg-white p-6 ring-1 ring-line">
        <Logo className="h-7" />
        <h1 className="mt-5 font-display text-[26px] font-semibold tracking-tight">Agency Planner</h1>
        <p className="mt-1.5 text-[15px] leading-[22px] text-sub">Plan agents, applications, profit and what your agency would sell for.</p>
        <p className="mt-3 text-[13px] text-muted">Built for a laptop or desktop screen.</p>
        <div className="mt-5 flex flex-col gap-2.5">
          <button onClick={() => setOpenAnyway(true)} className="h-11 rounded-md bg-brand text-[15px] font-semibold text-white hover:bg-[#094a36]">Open anyway</button>
          <a href={SIGNUP} className="flex h-11 items-center justify-center rounded-md bg-white text-[15px] font-semibold text-ink ring-1 ring-line hover:bg-surface2">Open my producer account</a>
        </div>
      </div>
    </div>
  );

  return (
    <div className="h-full w-full bg-canvas">
      <div className="relative flex flex-col overflow-hidden bg-canvas text-ink" style={{ width: box.w, height: box.h, transform: `scale(${box.s})`, transformOrigin: 'top left' }}>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-6">
          <Logo className="h-6" />
          <span className="h-7 w-px bg-line" aria-hidden />
          <div className="leading-tight">
            <h1 className="font-display text-[16px] font-semibold tracking-tight">Agency Planner</h1>
            <div className="text-[12px] text-muted">Final Expense + Medicare · LOA agency · 3-year plan</div>
          </div>
          <div className="ml-6 flex rounded-lg bg-surface p-0.5 ring-1 ring-line">
            {(['Planner', 'Income goal', 'Exit value'] as const).map((v) => (
              <button key={v} onClick={() => setPage(v)}
                className={`rounded-md px-3 py-1 text-[13px] font-medium transition-colors ${page === v ? (v === 'Income goal' ? 'goal-tab text-white' : v === 'Exit value' ? 'exit-tab text-white' : 'bg-white text-ink ring-1 ring-line') : 'text-muted hover:text-ink'}`}>
                {v === 'Income goal' ? '✦ Income goal' : v === 'Exit value' ? '◆ Exit value' : v}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Btn onClick={() => setModal('notes')}>Model notes</Btn>
            <Btn onClick={() => setState((s) => ({ ...s, inputs: { ...DEFAULTS }, names: [...DEFAULT_NAMES], goal: GOAL_DEFAULT }))}>Reset</Btn>
            <Btn onClick={() => navigator.clipboard.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
              {copied ? 'Link copied ✓' : 'Copy share link'}
            </Btn>
            <Btn outline onClick={() => exportCsv(out, ex)}>Export CSV</Btn>
            <SignupBtn className="ml-1.5 h-8 text-[13px]" />
          </div>
        </header>

        {page === 'Income goal' ? <Goal inputs={inputs} names={names} goal={goal} setGoal={setGoal} />
        : page === 'Exit value' ? <Exit inputs={inputs} out={out} ex={ex} names={names} year={exitYear} setYear={setExitYear} /> : (
        <div className="flex min-h-0 flex-1 gap-4 p-4">
          {/* assumptions */}
          <Card className="flex w-[320px] shrink-0 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-line/70 px-3 pb-3 pt-3.5">
              <h2 className="mb-2.5 px-1 text-[14px] font-semibold">Assumptions</h2>
              <div role="tablist" className="grid grid-cols-3 gap-1 rounded-lg bg-surface2 p-1 ring-1 ring-line/70">
                {LINES.map((l) => (
                  <button key={l.name} role="tab" aria-selected={tab === l.name} onClick={() => setTab(l.name)}
                    className={`flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md py-1.5 text-[12.5px] font-medium transition-colors ${tab === l.name ? 'bg-white text-ink ring-1 ring-line' : 'text-muted hover:text-ink'}`}>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: l.color }} />{l.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="scroll-y min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3.5">
              {line.groups.map(([title, ctls, note]) => (
                <section key={title}>
                  <h3 className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{title}</h3>
                  <div className="divide-y divide-line rounded-lg bg-white ring-1 ring-line">
                    {ctls.map((c) => <Control key={c[0]} ctl={c} value={inputs[c[0]]} onChange={(v) => setInput(c[0], v)} accent={C.brand} />)}
                    {note && <p className="px-3.5 py-2.5 text-[12px] leading-[16px] text-muted">{note(inputs)}</p>}
                  </div>
                </section>
              ))}
            </div>
          </Card>

          {/* main */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <div className="flex h-[92px] shrink-0 gap-3">
              {PERIODS.map((label, i) => (
                <PeriodCard key={label} label={label} active={period === i} onClick={() => setPeriod(i)}
                  pill={i < 3 ? `Exit ${compact(ex[i].price.base)}` : `Best exit: Year ${bestExit}`} onPill={() => openExit(i < 3 ? (i + 1) as 1 | 2 | 3 : bestExit)}
                  net={i < 3 ? out.years[i].totalNet : out.cumulative.totalNet} rev={i < 3 ? out.years[i].totalRev : out.cumulative.totalRev} />
              ))}
            </div>

            <Card className="shrink-0 px-4 pb-3 pt-3">
              <div className="mb-2 flex items-baseline gap-3">
                <h2 className="text-[14px] font-semibold">What it takes · {PERIODS[period]}</h2>
                <LoaPill />
                <span className="text-[12px] text-muted">Each step feeds the next — change an assumption and watch it flow through. Hover revenue or costs for the breakdown.</span>
              </div>
              <div className="flex flex-col gap-2.5">
                <ChainRow name="Final Expense" color={C.fe} c={p.fe} rates={{ conv: inputs.feConv, place: inputs.fePlace }} netPerPolicy={out.unit.feNetPerPlaced}
                  agentsSub={`${int(inputs.feCallsPerAgent)} calls/day each`}
                  revSub={`${money(feCommOf(inputs))}/policy to your agency · ${pct(inputs.feAdvance)} up front`} />
                <ChainRow name="Medicare" color={C.md} c={p.md} rates={{ conv: inputs.mdConv, place: inputs.mdPlace }} netPerPolicy={out.unit.mdNetPerPlaced}
                  agentsSub={`${int(inputs.mdCallsPerAgent)} calls/day · 5 mo/yr`}
                  revSub={`${money(inputs.mdComm)}/policy to your agency + renewals`} />
              </div>
            </Card>

            <div className="flex min-h-0 flex-1 gap-4">
            <Card className="flex min-w-0 flex-1 flex-col p-4">
              <div className="mb-2 flex items-center gap-3">
                <Tabs value={view} options={['Cash flow', 'Team', 'Profit by year', 'Medicare', 'Table']} onChange={setView} />
                <span className="ml-auto" />
                {view === 'Cash flow' && (
                  <span className="whitespace-nowrap text-[12px] text-muted" title={`${money(out.unit.receivableAfter36)} of months 10–12 payments not yet received after month 36`}>
                    FE still owed: <span className="font-semibold text-ink">{compact(out.unit.receivableAfter36)}</span>
                  </span>
                )}
                {view === 'Cash flow' && <Btn onClick={() => setModal('month')}>Month detail</Btn>}
              </div>
              <div className="min-h-0 flex-1">
                {view === 'Cash flow' && <CashFlowChart out={out} />}
                {view === 'Team' && <TeamChart out={out} />}
                {view === 'Profit by year' && <OverviewChart out={out} />}
                {view === 'Medicare' && <MedicareChart out={out} />}
                {view === 'Table' && (
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="h-7 border-b border-line text-muted">
                        <th className="text-left font-medium" />
                        {[1, 2, 3].map((y) => <th key={y} className="w-[22%] text-right font-medium">Year {y}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {SUMMARY_ROWS.map(([k, label, style]) => (
                        <tr key={k} className={`h-[21px] ${style === 'n' ? 'border-b border-line font-semibold' : ''}`}>
                          <td className={style === 'n' ? 'text-ink' : style === 't' ? 'text-sub' : 'pl-4 text-muted'}>{label}</td>
                          {out.years.map((y, i) => (
                            <td key={i} className={`text-right ${y[k] < 0 ? 'text-cost' : style ? 'text-ink' : 'text-sub'}`}>{money(y[k])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>

            {/* right: partners + vs paying per call */}
            <div className="flex w-[360px] shrink-0 flex-col gap-3">
            <Card className="flex min-h-0 flex-col px-4 py-3">
              <div className="mb-1 flex items-center gap-2">
                <h2 className="text-[14px] font-semibold">Partner payouts</h2>
                <span className="text-[12px] text-muted">{inputs.holdback === 0 ? 'pre-tax' : `after ${pct(inputs.holdback)} holdback`}</span>
                <div className="ml-auto flex items-center gap-1 text-[12px] text-muted" role="group" aria-label="Number of partners">
                  <span className="mr-1">Partners</span>
                  <button onClick={() => setPartners(partnerCountOf(inputs) - 1)} disabled={partnerCountOf(inputs) <= 1} aria-label="Remove a partner"
                    className="grid h-6 w-6 place-items-center rounded-md bg-white text-[14px] leading-none text-ink ring-1 ring-line hover:bg-surface2 disabled:opacity-40">−</button>
                  <span className="tnum w-4 text-center text-[13px] font-semibold text-ink" aria-live="polite">{partnerCountOf(inputs)}</span>
                  <button onClick={() => setPartners(partnerCountOf(inputs) + 1)} disabled={partnerCountOf(inputs) >= MAX_PARTNERS} aria-label="Add a partner"
                    className="grid h-6 w-6 place-items-center rounded-md bg-white text-[14px] leading-none text-ink ring-1 ring-line hover:bg-surface2 disabled:opacity-40">+</button>
                </div>
              </div>
              <div className="scroll-y min-h-0 overflow-y-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="h-6 text-[12px] text-muted">
                    <th className="text-left font-medium">Partner</th>
                    <th className="w-[64px] text-right font-medium">Split</th>
                    <th className="w-[84px] text-right font-medium">{PERIODS[period]}</th>
                    {period < 3 && <th className="w-[76px] text-right font-medium">3 years</th>}
                  </tr>
                </thead>
                <tbody>
                  {out.partners.map((pt, i) => (
                    <tr key={i} className="h-[31px] border-t border-line/70">
                      <td>
                        <input aria-label={`Partner ${i + 1} name`} value={names[i]} onChange={(e) => setName(i, e.target.value)} maxLength={24}
                          className="w-full min-w-0 rounded bg-transparent py-1 font-medium text-ink outline-none hover:bg-surface2 focus:bg-surface2" />
                      </td>
                      <td className="text-right">
                        <span className={`inline-flex h-6 w-[58px] items-center rounded-md bg-surface2 px-1.5 ring-1 ${splitsOk ? 'ring-line' : 'ring-cost'}`}>
                          <input type="number" aria-label={`${names[i]} split`} min={0} max={100} step={0.5} value={+(inputs[SPLIT_KEYS[i]] * 100).toFixed(4)}
                            onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setInput(SPLIT_KEYS[i], clamp(e.target.valueAsNumber, 0, 100) / 100)}
                            className="w-full min-w-0 bg-transparent text-right outline-none" />
                          <span className="text-muted">%</span>
                        </span>
                      </td>
                      {splitsOk ? (
                        <>
                          <td title={money(partnerCol(i))} className={`text-right font-semibold ${partnerCol(i) < 0 ? 'text-cost' : 'text-ink'}`}>{compact(partnerCol(i))}</td>
                          {period < 3 && <td title={money(pt.total)} className="text-right text-sub">{compact(pt.total)}</td>}
                        </>
                      ) : <td colSpan={period < 3 ? 2 : 1} className="text-right text-muted">—</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              {!splitsOk && (
                <div className="mt-2 shrink-0 rounded-md bg-cost/10 px-3 py-2 text-[12px] text-cost">
                  Splits add up to {num1(out.splitTotal * 100)}%. Make them total 100% to see payouts.
                </div>
              )}
            </Card>

            <Compare c={out.compare} perCall={inputs.comparePerCall} />
            </div>
            </div>
          </div>
        </div>
        )}

        {modal === 'notes' && (
          <Modal title="Model notes" onClose={() => setModal(null)} width={1280}>
            <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-8 text-[13px] leading-relaxed">
              <div>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">How this plan works</h3>
                <ul className="list-disc space-y-2 pl-4 text-sub">
                  <li><b className="text-ink">LOA model.</b> Your agents write under your agency's carrier contracts. Carriers pay commissions to your agency. Your agency pays each agent a set amount per placed policy and pays for the calls, $0 per call and a flat rate per submitted application. Your agents never pay for leads.</li>
                  <li>Calls are $0. You pay only when an application is submitted: $199 Final Expense and $159 Medicare by default. Change either in assumptions.</li>
                  <li>Final Expense pays a first-year commission, part advanced up front and the rest in policy months 10–12 on policies still in force. Lapses are charged back against the advance.</li>
                  <li>Medicare defaults to the 2026 CMS national figures: $694 initial, renewals at 50% ($347) each year a member stays. Medicare sells 5 months a year ({MD_MONTHS.join(', ')}).</li>
                  <li>Retention cost is a percentage of revenue. Partner figures are pre-tax unless a holdback is set.</li>
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Assumptions</h3>
                <ul className="list-disc space-y-2 pl-4 text-sub">
                  <li>FE first-year commission = average monthly premium × 12 × blended commission rate: {money(inputs.feMonthlyPremium)} × 12 × {pct(inputs.feCommRate)} = {money(feCommOf(inputs))}.</li>
                  <li>{pct(inputs.feAdvance)} of it is advanced; the remaining {pct(1 - inputs.feAdvance)} is paid as earned in policy months 10–12 on policies still in force.</li>
                  <li>FE renewals ({pct(inputs.feRenew)}) and Medicare renewals ({pct(inputs.mdRenewPct)} of the first-year commission) are paid as earned.</li>
                  <li>Any retention factor is (1 − that line's lapse rate).</li>
                  <li>The pay-per-call comparison uses {money(inputs.comparePerCall)} a call and feeds no other number.</li>
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Exit valuation</h3>
                <ul className="list-disc space-y-2 pl-4 text-sub">
                  <li><b className="text-ink">Book lens:</b> next-12-month Medicare renewals × Medicare book multiple (default 2.0x, range 1.5–2.5x) plus next-12-month FE renewals × FE book multiple (default 1.5x). Small insurance agencies trade around 1.8–2.3x revenue.</li>
                  <li><b className="text-ink">Earnings lens:</b> trailing-year net profit minus overhead buyers deduct, times a size-based multiple: under $1M 3–5x, $1–3M 4–7x, $3–10M 5–8x, $10M+ 6–10x. Priced below P&amp;C platforms (about 11.8x at $1M+ EBITDA) because FE/Medicare revenue depends on continued call volume and commission rules.</li>
                  <li>The price is the higher of the two lenses at base. They are never added together.</li>
                  <li>FE months 10–12 money already earned stays with the seller and is shown separately.</li>
                  <li>Cash at close vs earnout is set in assumptions; default 60/40 over 24 months.</li>
                </ul>
              </div>
            </div>
          </Modal>
        )}

        {modal === 'month' && (
          <Modal title="Final Expense month detail" onClose={() => setModal(null)} width={1400}>
            <div className="mb-3"><Tabs value={detailYear} options={['Year 1', 'Year 2', 'Year 3']} onChange={setDetailYear} /></div>
            <table className="w-full text-[12px]">
              <thead>
                <tr className="h-8 text-muted">
                  <th className="text-left font-medium" />
                  {detailMonths.map((r) => <th key={r.month} className="text-right font-medium">Mo {r.month}</th>)}
                </tr>
              </thead>
              <tbody>
                {FE_ROWS.map(([k, label, kind]) => (
                  <tr key={k} className={`h-[26px] border-t border-line/60 ${k === 'net' || k === 'totalCost' || k === 'cashNet' ? 'font-semibold text-ink' : 'text-sub'}`}>
                    <td className="whitespace-nowrap pr-3 text-muted">{label}</td>
                    {detailMonths.map((r) => <td key={r.month} className={`text-right ${r[k] < 0 ? 'text-cost' : ''}`}>{fmt(kind, r[k])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </Modal>
        )}
      </div>
    </div>
  );
}
