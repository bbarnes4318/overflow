// The guided planner: six questions, then the reveal, lead capture and a printable plan. A normal responsive
// document page, not Advanced's scaled 1440×840 canvas.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { compact, int, money, num1, pct } from '../format';
import { Num } from '../ui';
import { DEFAULT_NAMES, shareQuery } from '../state';
import { ANSWERS_DEFAULT, decode, encode, results, type Answers, type Results, type Sells } from './answers';

const GLS = 'netenroll-agency-planner-guided-v1';
const SIGNUP = 'https://agents.netenroll.com/login?mode=create';
const ADVANCED = '/agency-planner/advanced';
const LOA_NOTE = "Your agents write under your agency's contracts. Carriers pay commissions to your agency. Your agency pays your agents per placed policy and pays for the calls. Your agents pay nothing for leads.";
const FOOTNOTE = "Estimates from your answers and NetEnroll's standard assumptions. Not a guarantee of income or an offer to buy your agency.";
const CONSENT = "Yes, NetEnroll may call and text me at this number about my plan and NetEnroll's services, including with automated technology. Consent isn't required to get my plan. Msg & data rates may apply. Reply STOP to opt out.";
const REVEAL = 7;

type Saved = {
  answers: Answers;
  step: number; // 0 start, 1–6 questions, 7 reveal
  done: boolean;
  touched: { a1?: boolean; m0?: boolean };
  convPick?: string; // which Q4 card, since "About 10%" and "Not sure" share a value
  unlocked?: { name: string; agency: string }; // the plan PDF, unlocked for this browser by sending the form
};
const FRESH: Saved = { answers: ANSWERS_DEFAULT, step: 0, done: false, touched: {} };

function loadSaved(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(GLS) ?? 'null');
    if (s && typeof s === 'object') {
      const q = new URLSearchParams(encode({ ...ANSWERS_DEFAULT, ...s.answers, sells: s.answers?.sells ?? 'fe' }));
      const answers = { ...decode(q)!, sells: ['fe', 'md', 'both'].includes(s.answers?.sells) ? s.answers.sells : null };
      const done = s.done === true && answers.sells !== null;
      const step = done ? REVEAL : Math.min(6, Math.max(0, Math.round(Number(s.step)) || 0));
      const unlocked = s.unlocked && typeof s.unlocked.agency === 'string' ? { name: String(s.unlocked.name ?? ''), agency: s.unlocked.agency } : undefined;
      return { answers, step: answers.sells === null ? Math.min(step, 1) : step, done, touched: s.touched ?? {}, convPick: s.convPick, unlocked };
    }
  } catch { /* ignore corrupt storage */ }
  return FRESH;
}

const shareUrl = (a: Answers) => `https://netenroll.com/agency-planner/?${encode(a)}&v=result`;

// ---------- small pieces ----------
const Logo = () => (
  <a href="https://netenroll.com/" aria-label="NetEnroll home" className="shrink-0">
    <img src="/netenroll-logo.png" width={918} height={179} alt="NetEnroll" className="h-6 w-auto" />
  </a>
);

function TopBar() {
  return (
    <header className="border-b border-line bg-white">
      <div className="mx-auto flex h-16 max-w-[1100px] items-center gap-4 px-4">
        <Logo />
        <a href={ADVANCED} className="ml-auto flex h-12 items-center text-[14px] font-medium text-sub underline-offset-4 hover:text-ink hover:underline">Advanced planner</a>
        <a href={SIGNUP} className="hidden h-10 items-center rounded-md bg-brand px-4 text-[14px] font-semibold text-white hover:bg-[#094a36] min-[480px]:inline-flex">Open my producer account</a>
      </div>
    </header>
  );
}

function Choice({ label, sub, on, onClick }: { label: string; sub?: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      className={`flex min-h-14 w-full flex-col justify-center rounded-xl px-5 py-3 text-left ring-1 transition-colors ${on ? 'bg-brand/5 ring-2 ring-brand' : 'bg-white ring-line hover:bg-surface'}`}>
      <span className="text-[17px] font-semibold text-ink">{label}</span>
      {sub && <span className="text-[13px] text-muted">{sub}</span>}
    </button>
  );
}

function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const v = Math.min(max, Math.max(min, value));
  return (
    <input type="range" aria-label={label} min={min} max={max} step={1} value={v} onChange={(e) => onChange(+e.target.value)}
      className="h-12 w-full cursor-pointer"
      style={{ ['--accent' as string]: '#0c5c43', ['--fill' as string]: `${max > min ? ((v - min) / (max - min)) * 100 : 0}%` }} />
  );
}

// A big editable count with a slider under it. The typed box accepts more than the slider shows.
function Count({ label, value, min, max, sliderMax, onChange, unit }: {
  label: string; value: number; min: number; max: number; sliderMax: number; onChange: (v: number) => void; unit: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = (n: number) => onChange(Math.round(Math.min(max, Math.max(min, n))));
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <input type="number" inputMode="numeric" aria-label={label} min={min} max={max} value={draft}
          onChange={(e) => { setDraft(e.target.value); const n = e.target.valueAsNumber; if (Number.isFinite(n) && n >= min && n <= max) commit(n); }}
          onBlur={() => (Number.isFinite(+draft) && draft !== '' ? commit(+draft) : setDraft(String(value)))}
          className="tnum h-16 w-[160px] rounded-xl bg-white px-4 font-display text-[40px] font-semibold text-ink ring-1 ring-line outline-none focus:ring-2 focus:ring-brand" />
        <span className="text-[17px] text-sub">{unit}</span>
      </div>
      <Slider label={label} value={value} min={min} max={sliderMax} onChange={commit} />
    </div>
  );
}

function OtherAmount({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  return (
    <label className="mt-3 flex h-14 items-center gap-2 rounded-xl bg-white px-4 ring-1 ring-line focus-within:ring-2 focus-within:ring-brand">
      <span className="text-[17px] text-muted">$</span>
      <input type="number" inputMode="numeric" aria-label={label} min={min} max={max} value={draft} autoFocus
        onChange={(e) => { setDraft(e.target.value); const n = e.target.valueAsNumber; if (Number.isFinite(n) && n >= min && n <= max) onChange(n); }}
        className="tnum w-full min-w-0 bg-transparent text-[20px] font-semibold text-ink outline-none" />
    </label>
  );
}

const Primary = ({ children, onClick, disabled, className = '' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) => (
  <button onClick={onClick} disabled={disabled}
    className={`inline-flex min-h-12 items-center justify-center rounded-lg bg-brand px-6 text-[16px] font-semibold text-white transition-colors hover:bg-[#094a36] disabled:opacity-40 ${className}`}>
    {children}
  </button>
);
const Secondary = ({ children, onClick, href }: { children: ReactNode; onClick?: () => void; href?: string }) => {
  const cls = 'inline-flex min-h-12 items-center justify-center rounded-lg bg-white px-5 text-[15px] font-semibold text-ink ring-1 ring-line transition-colors hover:bg-surface';
  return href ? <a href={href} className={cls}>{children}</a> : <button onClick={onClick} className={cls}>{children}</button>;
};

function Ticker({ r, className }: { r: Results; className: string }) {
  return (
    <div className={`z-20 border-line bg-white/95 backdrop-blur ${className}`}>
      <div className="mx-auto flex h-14 max-w-[560px] items-center justify-between px-4">
        <span className="text-[13px] text-muted">Your agency, Year 2 net profit</span>
        <Num v={r.out.years[1].totalNet} f={compact} className={`font-display text-[22px] font-semibold ${r.out.years[1].totalNet < 0 ? 'text-cost' : 'text-net'}`} />
      </div>
    </div>
  );
}

// ---------- the applications sentence (reveal and plan report) ----------
function appsSentence(a: Answers, r: Results) {
  const { inputs } = r;
  if (a.sells === 'fe')
    return `Hitting your goal takes ${num1(r.feAppsDay)} submitted applications a day. At ${money(inputs.feAppCost)} each with $0 calls, that's ${money(r.feSpendDay)} a day, and your agents never pay for a lead.`;
  if (a.sells === 'md')
    return `Hitting your goal takes ${num1(r.mdAppsDay)} submitted applications a day in Medicare months. At ${money(inputs.mdAppCost)} each with $0 calls, that's ${money(r.mdSpendDay)} a day in Medicare months, and your agents never pay for a lead.`;
  return `Hitting your goal takes ${num1(r.feAppsDay)} Final Expense applications a day, plus ${num1(r.mdAppsDay)} Medicare applications a day in Medicare months. At $0 per call, that's ${money(r.feSpendDay)} a day, ${money(r.feSpendDay + r.mdSpendDay)} in Medicare months, and your agents never pay for a lead.`;
}

const SELLS_LABEL: Record<Sells, string> = { fe: 'Final Expense', md: 'Medicare', both: 'Final Expense and Medicare' };

// ---------- capture ----------
type Form = { contact_name: string; agency_name: string; email: string; phone: string; states: string; sms_consent: boolean };
const FIELDS: [keyof Form, string, string, string][] = [
  ['contact_name', 'Your name', 'text', 'name'],
  ['agency_name', 'Agency name', 'text', 'organization'],
  ['email', 'Email', 'email', 'email'],
  ['phone', 'Mobile', 'tel', 'tel'],
  ['states', 'States you write in', 'text', 'off'],
];

function Capture({ a, r, onSent }: { a: Answers; r: Results; onSent: (f: Form) => void }) {
  const [f, setF] = useState<Form>({ contact_name: '', agency_name: '', email: '', phone: '', states: '', sms_consent: false });
  const [errs, setErrs] = useState<Partial<Record<keyof Form, string>>>({});
  const [serverErr, setServerErr] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');

  const check = () => {
    const e: Partial<Record<keyof Form, string>> = {};
    for (const [k, label] of FIELDS) if (!String(f[k]).trim()) e[k] = `${label} is required.`;
    if (!e.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'Enter a valid email address.';
    if (!e.phone && f.phone.replace(/\D/g, '').length < 10) e.phone = 'Enter a 10-digit mobile number.';
    setErrs(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    setServerErr('');
    if (!check()) return;
    setSending(true);
    try {
      const res = await fetch('/api/planner-lead', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'agency-planner',
          contact_name: f.contact_name.trim(), agency_name: f.agency_name.trim(), email: f.email.trim(), phone: f.phone.trim(), states: f.states.trim(),
          sells: a.sells, agents_today: a.a0, agents_next_year: a.a1,
          medicare_agents: a.sells === 'both' ? a.m0 : a.sells === 'md' ? a.a0 : 0,
          close_rate: a.conv, agent_pay: a.pay, goal: a.goal, partners: a.partners,
          sms_consent: f.sms_consent, plan_url: shareUrl(a),
          results: {
            take_home_y1: r.takeHome[0], take_home_y2: r.takeHome[1], take_home_y3: r.takeHome[2], agents_needed: r.agentsNeeded,
            fe_apps_day: r.feAppsDay, md_apps_day: r.mdAppsDay, fe_spend_day: r.feSpendDay, md_spend_day: r.mdSpendDay,
            exit_y3_low: r.exit.price.low, exit_y3_base: r.exit.price.base, exit_y3_high: r.exit.price.high,
          },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setServerErr(body.error || 'Something went wrong. Please call 904-512-8487.'); return; }
      setSent(f.email.trim());
      onSent(f);
    } catch {
      setServerErr('Could not reach NetEnroll. Check your connection and try again, or call 904-512-8487.');
    } finally {
      setSending(false);
    }
  };

  if (sent) return (
    <div className="rounded-2xl bg-net/10 p-5 ring-1 ring-net/30">
      <p className="text-[16px] font-semibold text-netink">Sent. Check {sent} for your plan.</p>
      <Primary className="mt-4" onClick={() => window.print()}>Download my plan (PDF)</Primary>
    </div>
  );

  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-line sm:p-6">
      <h2 className="font-display text-[22px] font-semibold tracking-tight">Get your plan and exit report</h2>
      {serverErr && <p role="alert" className="mt-3 rounded-lg bg-cost/10 px-4 py-3 text-[14px] text-cost">{serverErr}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {FIELDS.map(([k, label, type, auto]) => (
          <label key={k} className={k === 'states' ? 'sm:col-span-2' : ''}>
            <span className="text-[14px] font-medium text-sub">{label}</span>
            <input type={type} autoComplete={auto} value={String(f[k])} placeholder={k === 'states' ? 'FL, GA, TX' : undefined}
              aria-invalid={!!errs[k]} aria-describedby={errs[k] ? `err-${k}` : undefined}
              onChange={(e) => setF({ ...f, [k]: e.target.value })}
              className={`mt-1 h-12 w-full rounded-lg bg-white px-3 text-[16px] text-ink outline-none ring-1 focus:ring-2 focus:ring-brand ${errs[k] ? 'ring-cost' : 'ring-line'}`} />
            {errs[k] && <span id={`err-${k}`} className="mt-1 block text-[13px] text-cost">{errs[k]}</span>}
          </label>
        ))}
      </div>
      <label className="mt-4 flex gap-3 text-[13px] leading-[19px] text-sub">
        <input type="checkbox" checked={f.sms_consent} onChange={(e) => setF({ ...f, sms_consent: e.target.checked })}
          className="mt-0.5 h-5 w-5 shrink-0 accent-[#0c5c43]" />
        <span>{CONSENT} <a href="/tcpa-compliance" className="font-medium text-brand underline">TCPA</a> · <a href="/privacy" className="font-medium text-brand underline">Privacy</a></span>
      </label>
      <Primary className="mt-5 w-full sm:w-auto" onClick={submit} disabled={sending}>{sending ? 'Sending…' : 'Send my plan'}</Primary>
    </div>
  );
}

// ---------- the printable plan ----------
function PlanReport({ a, r, agency }: { a: Answers; r: Results; agency: string }) {
  const answers: [string, string][] = [
    ['What you sell', SELLS_LABEL[a.sells!]],
    ['Agents today', int(a.a0)],
    ...(a.sells === 'both' ? [['Of them, selling Medicare', int(a.m0)] as [string, string]] : []),
    ['Agents a year from now', int(a.a1)],
    ['Close rate (calls to applications)', pct(a.conv)],
    ['Agency pays an agent per placed policy', money(a.pay)],
    ['Monthly take-home goal', money(a.goal)],
    ['Owners', a.partners === 1 ? 'Just me' : `${a.partners} partners`],
  ];
  return (
    <div id="plan-report" className="hidden bg-white text-[11pt] leading-snug text-ink print:block">
      <img src="/netenroll-logo.png" width={918} height={179} alt="NetEnroll" className="h-7 w-auto" />
      <h1 className="mt-4 font-display text-[20pt] font-semibold">Agency plan for {agency}</h1>
      <p className="text-muted">Prepared {new Date().toLocaleDateString('en-US', { dateStyle: 'long' })}</p>

      <h2 className="mt-5 text-[12pt] font-semibold">Your answers</h2>
      <dl className="mt-1 grid grid-cols-2 gap-x-8 gap-y-1">
        {answers.map(([k, v]) => <div key={k} className="flex justify-between gap-4 border-b border-line py-1"><dt className="text-sub">{k}</dt><dd className="font-semibold">{v}</dd></div>)}
      </dl>

      <h2 className="mt-5 text-[12pt] font-semibold">Your numbers</h2>
      <ul className="mt-1 list-disc pl-5">
        <li>You'd take home {compact(r.takeHome[1])} a month in Year 2{a.partners > 1 ? `, your ${pct(1 / a.partners)} share` : ''}.</li>
        <li>{r.feasible ? `To hit ${compact(a.goal)} a month: ${r.agentsNeeded} agents and ${num1(r.feAppsDay + r.mdAppsDay)} submitted applications a day.` : 'At these numbers each policy loses money.'}</li>
        <li>Your agency would sell for {compact(r.exit.price.base)} at the end of Year 3 (range {compact(r.exit.price.low)}–{compact(r.exit.price.high)}).</li>
      </ul>

      <table className="mt-4 w-full border-collapse text-left">
        <thead><tr className="border-b border-ink"><th className="py-1 font-semibold" />{[1, 2, 3].map((y) => <th key={y} className="py-1 text-right font-semibold">Year {y}</th>)}</tr></thead>
        <tbody>
          <tr className="border-b border-line"><td className="py-1">Revenue</td>{r.out.years.map((y, j) => <td key={j} className="py-1 text-right">{money(y.totalRev)}</td>)}</tr>
          <tr className="border-b border-line"><td className="py-1">Net profit</td>{r.out.years.map((y, j) => <td key={j} className="py-1 text-right">{money(y.totalNet)}</td>)}</tr>
          <tr className="border-b border-line"><td className="py-1">Your take-home per month</td>{r.takeHome.map((v, j) => <td key={j} className="py-1 text-right">{money(v)}</td>)}</tr>
        </tbody>
      </table>

      <table className="mt-4 w-full border-collapse text-left">
        <thead><tr className="border-b border-ink"><th className="py-1 font-semibold">Sale value at year-end</th><th className="py-1 text-right font-semibold">Low</th><th className="py-1 text-right font-semibold">Base</th><th className="py-1 text-right font-semibold">High</th></tr></thead>
        <tbody>{r.ex.map((e) => (
          <tr key={e.y} className="border-b border-line"><td className="py-1">End of Year {e.y}</td><td className="py-1 text-right">{money(e.price.low)}</td><td className="py-1 text-right">{money(e.price.base)}</td><td className="py-1 text-right">{money(e.price.high)}</td></tr>
        ))}</tbody>
      </table>

      <p className="mt-4">{appsSentence(a, r)}</p>
      <p className="mt-2">{LOA_NOTE}</p>
      <p className="mt-4 text-[9pt] text-muted">{FOOTNOTE}</p>
      <p className="mt-2 font-semibold">netenroll.com · 904-512-8487</p>
    </div>
  );
}

// ---------- the page ----------
export function Guided() {
  const [saved, setSaved] = useState<Saved>(loadSaved);
  const [shared, setShared] = useState<Answers | null>(() => {
    const q = new URLSearchParams(location.search);
    return q.get('v') === 'result' ? decode(q) : null;
  });
  const [capture, setCapture] = useState(false);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  // A shared view never writes the visitor's own saved answers.
  useEffect(() => { try { localStorage.setItem(GLS, JSON.stringify(saved)); } catch { /* storage unavailable */ } }, [saved]);

  const a = shared ?? saved.answers;
  const step = shared ? REVEAL : saved.step;
  const r = useMemo(() => (a.sells ? results(a) : null), [a]);
  useEffect(() => { scroller.current?.scrollTo(0, 0); }, [step]);

  const setA = (p: Partial<Answers>, touched?: Saved['touched']) =>
    setSaved((s) => ({ ...s, answers: { ...s.answers, ...p }, touched: { ...s.touched, ...touched } }));
  const go = (n: number) => setSaved((s) => {
    const x = s.answers;
    // Q3 opens on double today's team unless the visitor already chose a number.
    if (n === 3 && !s.touched.a1) return { ...s, step: n, answers: { ...x, a1: Math.min(2000, Math.max(x.a1, x.a0 * 2)) } };
    return { ...s, step: n, done: n === REVEAL ? true : s.done };
  });
  const startOver = () => { setShared(null); setCapture(false); setSaved((s) => ({ ...FRESH, unlocked: s.unlocked })); history.replaceState(null, '', '/agency-planner/'); };
  const later = (fn: () => void) => setTimeout(fn, 250);

  const setA0 = (a0: number) => setSaved((s) => {
    const x = s.answers;
    return { ...s, answers: { ...x, a0, a1: Math.max(x.a1, a0), m0: s.touched.m0 ? Math.min(x.m0, a0) : Math.round(a0 / 2) } };
  });

  const canContinue = step === 1 ? a.sells !== null : step >= 2 && step <= 6;
  const next = () => canContinue && go(step === 6 ? REVEAL : step + 1);
  useEffect(() => {
    if (step < 1 || step > 6) return;
    const k = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A') { e.preventDefault(); next(); }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });

  const share = async () => {
    const url = shareUrl(a);
    try {
      if (navigator.share) { await navigator.share({ title: 'My agency plan', text: `My agency is worth ${compact(r!.exit.price.base)}`, url }); return; }
    } catch { /* cancelled; fall back to copying */ }
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* no clipboard */ }
  };

  const openCapture = () => { setCapture(true); setTimeout(() => captureRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); };

  // ---------- screens ----------
  const question = (n: number, title: string, body: ReactNode, cta = 'Continue') => (
    <div className="mx-auto max-w-[560px] px-4 pb-10 pt-6">
      <div className="flex items-center justify-between text-[14px]">
        <button onClick={() => go(n - 1)} className="flex h-12 items-center font-medium text-sub hover:text-ink">← Back</button>
        <span className="text-muted">Question {n} of 6</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface2" role="progressbar" aria-valuemin={1} aria-valuemax={6} aria-valuenow={n}>
        <div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${(n / 6) * 100}%` }} />
      </div>
      <h1 className="mt-8 font-display text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">{title}</h1>
      <div className="mt-6">{body}</div>
      <Primary className="mt-8 w-full" onClick={next} disabled={!canContinue}>{cta}</Primary>
    </div>
  );

  let screen: ReactNode;
  if (step === 0) {
    screen = (
      <div className="mx-auto max-w-[560px] px-4 pb-16 pt-12 sm:pt-20">
        <h1 className="font-display text-[34px] font-semibold leading-[1.1] tracking-tight sm:text-[44px]">How much can your agency make you?</h1>
        <p className="mt-4 text-[18px] leading-relaxed text-sub">Answer six questions about your agents and your income goal. You'll see what you'd take home each month, how many agents it takes to get there, and what your agency could sell for.</p>
        <p className="mt-3 text-[14px] text-muted">For LOA agencies, where your agents write under your contracts and commissions come to you.</p>
        <Primary className="mt-8 w-full sm:w-auto" onClick={() => go(1)}>Get my numbers</Primary>
        <a href={ADVANCED} className="mt-4 flex min-h-12 items-center text-[15px] font-medium text-brand underline underline-offset-4">Already know your numbers? Use the advanced planner</a>
      </div>
    );
  } else if (step === 1) {
    screen = question(1, 'What do you sell?', (
      <div className="grid gap-3">
        {([['fe', 'Final Expense'], ['md', 'Medicare'], ['both', 'Both']] as [Sells, string][]).map(([v, l]) => (
          <Choice key={v} label={l} on={a.sells === v} onClick={() => { setA({ sells: v }); later(() => go(2)); }} />
        ))}
      </div>
    ));
  } else if (step === 2) {
    screen = question(2, 'How many agents do you have today?', (
      <div className="space-y-8">
        <Count label="Agents today" value={a.a0} min={1} max={1000} sliderMax={200} unit="agents" onChange={setA0} />
        {a.sells === 'both' && (
          <div>
            <p className="mb-3 text-[17px] font-semibold text-ink">How many of them sell Medicare?</p>
            <Count label="Agents selling Medicare" value={a.m0} min={0} max={a.a0} sliderMax={a.a0} unit={`of ${int(a.a0)}`} onChange={(m0) => setA({ m0 }, { m0: true })} />
          </div>
        )}
      </div>
    ));
  } else if (step === 3) {
    const hi = Math.min(2000, Math.max(500, a.a0 * 5));
    screen = question(3, 'How many agents do you want a year from now?', (
      <Count label="Agents a year from now" value={a.a1} min={a.a0} max={2000} sliderMax={hi} unit="agents" onChange={(a1) => setA({ a1 }, { a1: true })} />
    ));
  } else if (step === 4) {
    const opts: [string, number][] = [['Under 8%', 0.06], ['About 10%', 0.10], ['12% or better', 0.13], ['Not sure', 0.10]];
    const picked = saved.convPick ?? opts.find(([, v]) => v === a.conv)?.[0];
    screen = question(4, 'How often do your agents close a call into a submitted application?', (
      <div className="grid gap-3 sm:grid-cols-2">
        {opts.map(([l, v]) => (
          <Choice key={l} label={l} on={picked === l} onClick={() => { setSaved((s) => ({ ...s, convPick: l, answers: { ...s.answers, conv: v } })); later(() => go(5)); }} />
        ))}
      </div>
    ));
  } else if (step === 5) {
    screen = question(5, 'What does your agency pay an agent per placed policy?', (
      <PayPicker value={a.pay} presets={[80, 120, 160, 200]} onPick={(pay, advance) => { setA({ pay }); if (advance) later(() => go(6)); }} />
    ));
  } else if (step === 6) {
    screen = question(6, 'What do you want to take home each month?', (
      <div>
        <AmountPicker value={a.goal} presets={[10000, 25000, 50000, 100000]} label="Monthly take-home goal" max={100000000}
          format={(v) => compact(v).replace('.0K', 'K')} onPick={(goal) => setA({ goal })} />
        <p className="mb-3 mt-8 text-[17px] font-semibold text-ink">Who owns the agency?</p>
        <div className="flex flex-wrap gap-2">
          {([[1, 'Just me'], [2, '2 partners'], [3, '3 partners'], [4, '4 partners']] as [number, string][]).map(([n, l]) => (
            <button key={n} onClick={() => setA({ partners: n })} aria-pressed={a.partners === n}
              className={`min-h-12 rounded-full px-5 text-[15px] font-medium ring-1 transition-colors ${a.partners === n ? 'bg-brand text-white ring-brand' : 'bg-white text-ink ring-line hover:bg-surface'}`}>{l}</button>
          ))}
        </div>
      </div>
    ), 'See my numbers');
  } else {
    screen = r && <Reveal a={a} r={r} shared={!!shared} onOwn={startOver} onStartOver={startOver} onChange={() => go(4)}
      unlocked={saved.unlocked} capture={capture} openCapture={openCapture} captureRef={captureRef} share={share} copied={copied}
      onSent={(f) => setSaved((s) => ({ ...s, unlocked: { name: f.contact_name.trim(), agency: f.agency_name.trim() } }))} />;
  }

  const showTicker = r && step >= 2 && step <= 6;
  return (
    <>
      <div ref={scroller} className="h-full overflow-y-auto bg-surface print:hidden">
        <TopBar />
        {showTicker && <Ticker r={r} className="sticky top-0 hidden border-b md:block" />}
        <main className="min-h-[calc(100%-4rem)]">{screen}</main>
        {showTicker && <Ticker r={r} className="sticky bottom-0 border-t md:hidden" />}
      </div>
      {r && step === REVEAL && <PlanReport a={a} r={r} agency={saved.unlocked?.agency || 'your agency'} />}
    </>
  );
}

// Q5: preset cards advance on tap; "Other" opens a number box and waits for Continue.
function PayPicker({ value, presets, onPick }: { value: number; presets: number[]; onPick: (v: number, advance: boolean) => void }) {
  const [other, setOther] = useState(!presets.includes(value));
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {presets.map((v) => <Choice key={v} label={money(v)} on={!other && value === v} onClick={() => { setOther(false); onPick(v, true); }} />)}
        <Choice label="Other" on={other} onClick={() => setOther(true)} />
      </div>
      {other && <OtherAmount label="Agent pay per placed policy" value={value} min={0} max={1000} onChange={(v) => onPick(v, false)} />}
      <p className="mt-4 text-[14px] text-muted">Your agency pays your agents. Carriers pay your agency.</p>
    </div>
  );
}

function AmountPicker({ value, presets, label, max, format, onPick }: {
  value: number; presets: number[]; label: string; max: number; format: (v: number) => string; onPick: (v: number) => void;
}) {
  const [other, setOther] = useState(!presets.includes(value));
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {presets.map((v) => <Choice key={v} label={format(v)} on={!other && value === v} onClick={() => { setOther(false); onPick(v); }} />)}
        <Choice label="Other" on={other} onClick={() => setOther(true)} />
      </div>
      {other && <OtherAmount label={label} value={value} min={0} max={max} onChange={onPick} />}
    </div>
  );
}

function Reveal({ a, r, shared, onOwn, onStartOver, onChange, unlocked, capture, openCapture, captureRef, share, copied, onSent }: {
  a: Answers; r: Results; shared: boolean; onOwn: () => void; onStartOver: () => void; onChange: () => void;
  unlocked?: Saved['unlocked']; capture: boolean; openCapture: () => void; captureRef: React.RefObject<HTMLDivElement>;
  share: () => void; copied: boolean; onSent: (f: Form) => void;
}) {
  const adjust = '/agency-planner/advanced?' + shareQuery({ inputs: r.inputs, names: DEFAULT_NAMES, goal: { amount: a.goal, partner: 0, feMix: r.feMix }, page: 'Planner' });
  const status = r.clearsInYear == null ? "Your plan doesn't get there in 3 years at these numbers."
    : a.a0 >= r.agentsNeeded ? `You have ${int(a.a0)}. You're past it in Year ${r.clearsInYear}.`
    : `Your plan gets there in Year ${r.clearsInYear}.`;
  const card = 'rise rounded-2xl bg-white p-6 ring-1 ring-line';
  const big = 'mt-2 block font-display text-[44px] font-semibold leading-none tracking-tight';
  return (
    <div className="mx-auto max-w-[1100px] px-4 pb-16 pt-8">
      {shared && (
        <div className="mb-6 flex flex-col gap-3 rounded-2xl bg-brand/5 p-5 ring-1 ring-brand/30 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[16px] font-semibold text-ink">Someone shared their plan with you.</p>
          <Primary onClick={onOwn}>Plan your own agency</Primary>
        </div>
      )}
      <div className="grid gap-4 min-[900px]:grid-cols-3">
        <section className={card} style={{ animationDelay: '0ms' }}>
          <h2 className="text-[15px] font-medium text-sub">You'd take home</h2>
          <Num v={r.takeHome[1]} f={compact} className={`${big} ${r.takeHome[1] < 0 ? 'text-cost' : 'text-net'}`} />
          <p className="mt-2 text-[15px] text-ink">a month in Year 2</p>
          <p className="mt-3 text-[14px] text-muted">Year 1: {compact(r.takeHome[0])}/mo · Year 3: {compact(r.takeHome[2])}/mo{a.partners > 1 ? ` · your ${pct(1 / a.partners)} share` : ''}</p>
        </section>
        <section className={card} style={{ animationDelay: '150ms' }}>
          <h2 className="text-[15px] font-medium text-sub">To hit {compact(a.goal)} a month</h2>
          {r.feasible ? (
            <>
              <Num v={r.agentsNeeded} f={(v) => `${int(v)} agents`} className={`${big} text-ink`} />
              <p className="mt-2 text-[15px] text-ink">{num1(r.feAppsDay + r.mdAppsDay)} submitted applications a day</p>
              <p className="mt-3 text-[14px] text-muted">{status}</p>
            </>
          ) : (
            <>
              <p className="mt-3 text-[16px] leading-relaxed text-cost">At these numbers each policy loses money. Lower agent pay or raise the close rate.</p>
              {!shared && <div className="mt-4"><Secondary onClick={onChange}>Change my answers</Secondary></div>}
            </>
          )}
        </section>
        <section className={card} style={{ animationDelay: '300ms' }}>
          <h2 className="text-[15px] font-medium text-sub">Your agency would sell for</h2>
          <Num v={r.exit.price.base} f={compact} className={`${big} text-brand`} />
          <p className="mt-2 text-[15px] text-ink">at the end of Year 3</p>
          <p className="mt-3 text-[14px] text-muted">Range {compact(r.exit.price.low)}–{compact(r.exit.price.high)} · {r.exit.buyer}</p>
        </section>
      </div>

      <p className="mx-auto mt-8 max-w-[760px] text-center text-[16px] leading-relaxed text-sub">{appsSentence(a, r)}</p>

      <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
        <Primary onClick={openCapture}>Email me my plan</Primary>
        {unlocked && <Secondary onClick={() => window.print()}>Download my plan (PDF)</Secondary>}
        <Secondary href={adjust}>Adjust my numbers</Secondary>
        <Secondary onClick={share}>{copied ? 'Link copied' : `Share: my agency is worth ${compact(r.exit.price.base)}`}</Secondary>
        <Secondary href={SIGNUP}>Open my producer account</Secondary>
      </div>
      <div className="mt-4 text-center">
        <button onClick={onStartOver} className="min-h-12 text-[15px] font-medium text-brand underline underline-offset-4">Start over</button>
      </div>

      {capture && <div ref={captureRef} className="mx-auto mt-8 max-w-[760px] scroll-mt-4"><Capture a={a} r={r} onSent={onSent} /></div>}

      <p className="mx-auto mt-10 max-w-[760px] text-center text-[13px] text-muted">{FOOTNOTE}</p>
    </div>
  );
}
