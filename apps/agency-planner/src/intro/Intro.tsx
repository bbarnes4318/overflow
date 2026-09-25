// Quick Start: a five-step overlay that fills in the planner. Rendered outside the scaled canvas at real pixel sizes.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { compact, int, money, num1, pct } from '../format';
import { Num } from '../ui';
import { ANSWERS_DEFAULT, summarize, type Answers, type Sells } from './answers';

const SIGNUP = 'https://agents.netenroll.com/login?mode=create';
const REVEAL = 6;
type Draft = Omit<Answers, 'sells'> & { sells: Sells | null };

const Check = () => (
  <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-brand" aria-hidden><circle cx="10" cy="10" r="10" fill="currentColor" /><path d="M6 10.5l2.5 2.5L14 7.5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

function Card({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      className={`flex h-14 w-full items-center justify-between rounded-xl bg-white px-4 text-left text-[16px] font-semibold text-ink transition-colors ${on ? 'ring-2 ring-brand' : 'ring-1 ring-line hover:bg-surface'}`}>
      {label}{on && <Check />}
    </button>
  );
}

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      className={`flex h-11 items-center gap-1.5 rounded-full bg-white px-4 text-[15px] font-medium text-ink transition-colors ${on ? 'ring-2 ring-brand' : 'ring-1 ring-line hover:bg-surface'}`}>
      {label}{on && <Check />}
    </button>
  );
}

function Stepper({ label, value, min, max, sliderMax, onChange }: {
  label: string; value: number; min: number; max: number; sliderMax: number; onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const set = (n: number) => onChange(Math.round(Math.min(max, Math.max(min, n))));
  const btn = 'grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white text-[22px] text-ink ring-1 ring-line hover:bg-surface disabled:opacity-40';
  const v = Math.min(sliderMax, Math.max(min, value));
  return (
    <div>
      <div className="flex items-center gap-3">
        <button className={btn} onClick={() => set(value - 1)} disabled={value <= min} aria-label={`${label}: one fewer`}>−</button>
        <input type="number" inputMode="numeric" aria-label={label} min={min} max={max} value={draft}
          onChange={(e) => { setDraft(e.target.value); const n = e.target.valueAsNumber; if (Number.isFinite(n) && n >= min && n <= max) set(n); }}
          onBlur={() => (draft !== '' && Number.isFinite(+draft) ? set(+draft) : setDraft(String(value)))}
          className="tnum h-14 w-full min-w-0 rounded-xl bg-white px-4 text-center font-display text-[32px] font-semibold text-ink ring-1 ring-line focus:ring-2 focus:ring-brand" style={{ outline: 'none' }} />
        <button className={btn} onClick={() => set(value + 1)} disabled={value >= max} aria-label={`${label}: one more`}>+</button>
      </div>
      <input type="range" aria-label={`${label} slider`} min={min} max={sliderMax} step={1} value={v} onChange={(e) => set(+e.target.value)}
        className="mt-4 h-6 w-full cursor-pointer"
        style={{ ['--accent' as string]: '#0c5c43', ['--fill' as string]: `${sliderMax > min ? ((v - min) / (sliderMax - min)) * 100 : 0}%` }} />
    </div>
  );
}

function Money({ label, value, max, onChange }: { label: string; value: number; max: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  return (
    <label className="mt-3 flex h-12 items-center gap-2 rounded-xl bg-white px-4 ring-1 ring-line focus-within:ring-2 focus-within:ring-brand">
      <span className="text-muted">$</span>
      <input type="number" inputMode="numeric" aria-label={label} min={0} max={max} value={draft} autoFocus
        onChange={(e) => { setDraft(e.target.value); const n = e.target.valueAsNumber; if (Number.isFinite(n) && n >= 0 && n <= max) onChange(n); }}
        className="tnum w-full min-w-0 bg-transparent text-[17px] font-semibold text-ink" style={{ outline: 'none' }} />
    </label>
  );
}

// Preset chips plus "Other", which reveals a $ field.
function Amounts({ label, value, presets, max, onChange }: { label: string; value: number; presets: number[]; max: number; onChange: (v: number) => void }) {
  const [other, setOther] = useState(!presets.includes(value));
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => <Chip key={p} label={money(p)} on={!other && value === p} onClick={() => { setOther(false); onChange(p); }} />)}
        <Chip label="Other" on={other} onClick={() => setOther(true)} />
      </div>
      {other && <Money label={label} value={value} max={max} onChange={onChange} />}
    </div>
  );
}

const Primary = ({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) => (
  <button onClick={onClick} disabled={disabled}
    className="inline-flex h-12 items-center justify-center rounded-xl bg-brand px-6 text-[16px] font-semibold text-white transition-colors hover:bg-[#094a36] disabled:opacity-40">
    {children}
  </button>
);
const TextBtn = ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
  <button onClick={onClick} className="inline-flex h-12 items-center text-[15px] font-medium text-sub hover:text-ink">{children}</button>
);

function sentence(a: Answers, s: ReturnType<typeof summarize>) {
  const { inputs } = s;
  if (a.sells === 'fe')
    return `That's ${num1(s.feAppsDay)} applications a day at ${money(inputs.feAppCost)} each, or ${money(s.feSpendDay)} a day. Calls are free, and your agents never pay for a lead.`;
  if (a.sells === 'md')
    return `That's ${num1(s.mdAppsDay)} applications a day in Medicare months at ${money(inputs.mdAppCost)} each, or ${money(s.mdSpendDay)} a day. Calls are free, and your agents never pay for a lead.`;
  return `That's ${num1(s.feAppsDay)} Final Expense applications a day (${money(s.feSpendDay)}), plus ${num1(s.mdAppsDay)} Medicare applications a day in Medicare months (${money(s.mdSpendDay)}). Calls are free, and your agents never pay for a lead.`;
}

export function Intro({ onApply, onClose, initial }: { onApply: (a: Answers) => void; onClose: () => void; initial?: Answers }) {
  const [d, setD] = useState<Draft>(initial ?? { ...ANSWERS_DEFAULT, sells: null });
  const [touched, setTouched] = useState({ a1: !!initial, m0: !!initial });
  const [step, setStep] = useState(0);
  // "About 1" and "Not sure" share a value, so remember which card was tapped.
  const [convPick, setConvPick] = useState<string | null>(initial ? ({ 0.06: 'Fewer than 1', 0.13: 'More than 1' } as Record<number, string>)[initial.conv] ?? 'About 1' : null);
  const answers = d.sells ? (d as Answers) : null;
  const s = useMemo(() => (step === REVEAL && answers ? summarize(answers) : null), [step, answers]);

  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const setA0 = (a0: number) => setD((x) => ({
    ...x, a0,
    a1: touched.a1 ? Math.max(x.a1, a0) : a0 * 2,
    m0: touched.m0 ? Math.min(x.m0, a0) : Math.round(a0 / 2),
  }));
  const next = () => {
    if (step === 1 && !d.sells) return;
    if (step === 5) { onApply(d as Answers); setStep(REVEAL); return; }
    if (step >= 1 && step < 5) setStep(step + 1);
  };
  const pick = (p: Partial<Draft>) => { set(p); setTimeout(() => setStep((n) => n + 1), 250); };

  useEffect(() => {
    if (step < 1 || step > 5) return;
    const k = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'A') { e.preventDefault(); next(); }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });

  const h1 = 'font-display text-[28px] font-semibold leading-tight tracking-tight min-[480px]:text-[32px]';
  const q = 'text-[17px] font-semibold text-ink';

  const questions: Record<number, ReactNode> = {
    1: (
      <>
        <h1 className={h1}>What do you sell?</h1>
        <div className="mt-6 grid gap-3">
          {([['fe', 'Final Expense'], ['md', 'Medicare'], ['both', 'Both']] as [Sells, string][]).map(([v, l]) => (
            <Card key={v} label={l} on={d.sells === v} onClick={() => pick({ sells: v })} />
          ))}
        </div>
      </>
    ),
    2: (
      <>
        <h1 className={h1}>How many agents do you have today?</h1>
        <div className="mt-6"><Stepper label="Agents today" value={d.a0} min={1} max={1000} sliderMax={200} onChange={setA0} /></div>
        {d.sells === 'both' && (
          <div className="mt-8">
            <p className={q}>How many of them sell Medicare?</p>
            <div className="mt-3"><Stepper label="Agents who sell Medicare" value={d.m0} min={0} max={d.a0} sliderMax={d.a0}
              onChange={(m0) => { setTouched((t) => ({ ...t, m0: true })); set({ m0 }); }} /></div>
          </div>
        )}
      </>
    ),
    3: (
      <>
        <h1 className={h1}>How many agents do you want a year from now?</h1>
        <div className="mt-6"><Stepper label="Agents a year from now" value={d.a1} min={d.a0} max={Math.max(500, d.a0 * 5)} sliderMax={Math.max(500, d.a0 * 5)}
          onChange={(a1) => { setTouched((t) => ({ ...t, a1: true })); set({ a1 }); }} /></div>
      </>
    ),
    4: (
      <>
        <h1 className={h1}>Out of every 10 calls, how many turn into a submitted application?</h1>
        <div className="mt-6 grid gap-3">
          {([['Fewer than 1', 0.06], ['About 1', 0.10], ['More than 1', 0.13], ['Not sure', 0.10]] as [string, number][]).map(([l, v]) => (
            <Card key={l} label={l} on={convPick === l} onClick={() => { setConvPick(l); pick({ conv: v }); }} />
          ))}
        </div>
      </>
    ),
    5: (
      <>
        <h1 className={h1}>Last two:</h1>
        <div className="mt-6 space-y-7">
          <div>
            <p className={q}>What does your agency pay an agent for each placed policy?</p>
            <div className="mt-3"><Amounts label="Agent pay per placed policy" value={d.pay} presets={[80, 120, 160, 200]} max={1000} onChange={(pay) => set({ pay })} /></div>
          </div>
          <div>
            <p className={q}>How much do you want to take home each month?</p>
            <div className="mt-3"><Amounts label="Monthly take-home" value={d.goal} presets={[10000, 25000, 50000, 100000]} max={100000000} onChange={(goal) => set({ goal })} /></div>
          </div>
          <div>
            <p className={q}>Who owns the agency?</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {([[1, 'Just me'], [2, '2 partners'], [3, '3 partners'], [4, '4 partners']] as [number, string][]).map(([n, l]) => (
                <Chip key={n} label={l} on={d.partners === n} onClick={() => set({ partners: n })} />
              ))}
            </div>
          </div>
        </div>
      </>
    ),
  };

  let body: ReactNode;
  if (step === 0) {
    body = (
      <div className="pt-6 min-[480px]:pt-12">
        <h1 className="font-display text-[32px] font-semibold leading-[1.1] tracking-tight min-[480px]:text-[40px]">What will your agency pay you, and what is it worth?</h1>
        <p className="mt-4 text-[17px] leading-relaxed text-sub">Answer five quick questions. We'll fill in the planner with your numbers.</p>
        <p className="mt-3 text-[14px] text-muted">Built for LOA agencies: carriers pay your agency, and your agency pays your agents and the calls.</p>
        <div className="mt-8"><Primary onClick={() => setStep(1)}>Start</Primary></div>
      </div>
    );
  } else if (step <= 5) {
    body = (
      <div className="pt-4">
        <div className="text-[14px] text-muted">Step {step} of 5</div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface2" role="progressbar" aria-valuemin={1} aria-valuemax={5} aria-valuenow={step}>
          <div className="h-full rounded-full bg-brand transition-all duration-300" style={{ width: `${(step / 5) * 100}%` }} />
        </div>
        <div className="mt-8">{questions[step]}</div>
        <div className="mt-10 flex items-center justify-between">
          <TextBtn onClick={() => setStep(step - 1)}>Back</TextBtn>
          <Primary onClick={next} disabled={step === 1 && !d.sells}>{step === 5 ? 'Show my numbers' : 'Next'}</Primary>
        </div>
      </div>
    );
  } else if (s && answers) {
    const a = answers;
    const status = !s.feasible ? null
      : s.clearsInYear && a.a0 >= s.agentsNeeded ? `You already have ${int(a.a0)}.`
      : s.clearsInYear ? `Your plan gets there in Year ${s.clearsInYear}.`
      : "Your plan doesn't get there within 3 years.";
    const card = 'intro-rise flex flex-col rounded-xl bg-white p-5 ring-1 ring-line';
    const label = 'text-[12px] font-semibold uppercase tracking-[0.06em] text-muted';
    const big = 'mt-2 block font-display text-[36px] font-semibold leading-none tracking-tight';
    const sub = 'mt-2 text-[15px] text-ink';
    const sub2 = 'mt-1 text-[14px] text-muted';
    body = (
      <div className="pt-4">
        <h1 className={h1}>Here's your agency</h1>
        <div className="mt-6 grid gap-3 min-[900px]:grid-cols-3">
          <section className={card} style={{ animationDelay: '0ms' }}>
            <h2 className={label}>You take home</h2>
            <Num v={s.takeHome[1]} f={compact} className={`${big} ${s.takeHome[1] < 0 ? 'text-cost' : 'text-net'}`} />
            <p className={sub}>a month in Year 2{a.partners > 1 ? ` · your ${pct(1 / a.partners)} share` : ''}</p>
            <p className={sub2}>Year 1: {compact(s.takeHome[0])} · Year 3: {compact(s.takeHome[2])}</p>
          </section>
          <section className={card} style={{ animationDelay: '150ms' }}>
            <h2 className={label}>To take home {compact(a.goal)} a month</h2>
            {s.feasible ? (
              <>
                <Num v={s.agentsNeeded} f={(v) => `${int(v)} agents`} className={`${big} text-ink`} />
                <p className={sub}>{num1(s.feAppsDay + s.mdAppsDay)} applications a day</p>
                <p className={sub2}>{status}</p>
              </>
            ) : (
              <>
                <p className="mt-2 text-[16px] font-semibold text-cost">Each policy loses money at these numbers.</p>
                <div><TextBtn onClick={() => setStep(4)}><span className="text-brand">Change my answers</span></TextBtn></div>
              </>
            )}
          </section>
          <section className={card} style={{ animationDelay: '300ms' }}>
            <h2 className={label}>Your agency could sell for</h2>
            <Num v={s.exit.price.base} f={compact} className={`${big} text-brand`} />
            <p className={sub}>at the end of Year 3</p>
            <p className={sub2}>Range {compact(s.exit.price.low)} to {compact(s.exit.price.high)}</p>
          </section>
        </div>
        <p className="mt-6 text-[16px] leading-relaxed text-sub">{sentence(a, s)}</p>
        <div className="mt-6 flex flex-col gap-3 min-[480px]:flex-row min-[480px]:flex-wrap min-[480px]:items-center">
          <Primary onClick={onClose}>See my full plan</Primary>
          <a href={SIGNUP} className="inline-flex h-12 items-center justify-center rounded-xl bg-white px-6 text-[16px] font-semibold text-ink ring-1 ring-line hover:bg-surface">Open my producer account</a>
          <TextBtn onClick={() => setStep(1)}><span className="text-brand">Change my answers</span></TextBtn>
        </div>
        <p className="mt-8 text-[13px] text-muted">Estimates from your answers and NetEnroll's standard assumptions. Not a guarantee of income or an offer to buy your agency.</p>
      </div>
    );
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Quick start" className="fixed inset-0 z-[100] overflow-y-auto bg-[rgba(255,255,255,0.97)] text-ink">
      <div className={`mx-auto p-4 pb-12 min-[480px]:p-6 ${step === REVEAL ? 'max-w-[960px]' : 'max-w-[560px]'}`}>
        <div className="flex h-12 items-center justify-between">
          <img src="/netenroll-logo.png" width={918} height={179} alt="NetEnroll" className="h-5 w-auto" />
          <TextBtn onClick={onClose}>Skip to the full planner</TextBtn>
        </div>
        {body}
      </div>
    </div>
  );
}
