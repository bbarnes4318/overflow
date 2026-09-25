// The front door: one question on a dark hero, live numbers as the visitor answers, then the full planner.
// Rendered outside the scaled canvas at real pixel sizes, from 360px wide up.
import { useMemo, useState } from 'react';
import { compact, int } from '../format';
import { Num } from '../ui';
import { summarize, type Answers } from './answers';

const SIGNUP = 'https://agents.netenroll.com/login?mode=create';

// One question. The rest follows the planner's standard LOA assumptions, stated under the slider.
const fromAgents = (a0: number): Answers => ({ sells: 'both', a0, a1: a0 * 2, m0: Math.round(a0 / 2), conv: 0.10, pay: 120, goal: 25000, partners: 1 });

export function Intro({ onApply, onClose, initial }: { onApply: (a: Answers) => void; onClose: () => void; initial?: Answers }) {
  const [a0, setA0] = useState(initial?.a0 ?? 10);
  const [draft, setDraft] = useState(String(initial?.a0 ?? 10));
  const answers = useMemo(() => fromAgents(a0), [a0]);
  const s = useMemo(() => summarize(answers), [answers]);
  const set = (n: number) => { const v = Math.round(Math.min(1000, Math.max(1, n))); setA0(v); setDraft(String(v)); };
  const years = s.takeHome;
  const peak = Math.max(...years, 1);
  const fill = `${((Math.min(200, a0) - 1) / 199) * 100}%`;
  const step = 'grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-white/10 text-[26px] text-white ring-1 ring-white/15 transition-colors hover:bg-white/20 disabled:opacity-30';

  return (
    <div role="dialog" aria-modal="true" aria-label="Agency Planner" className="fixed inset-0 z-[100] overflow-y-auto bg-[#04130e] text-white">
      {/* backdrop: two soft emerald glows and a faint grid */}
      <div aria-hidden className="pointer-events-none fixed inset-0">
        <div className="absolute -left-40 -top-40 h-[620px] w-[620px] rounded-full bg-[radial-gradient(closest-side,rgba(16,185,129,0.28),transparent)]" />
        <div className="absolute -bottom-60 right-[-120px] h-[700px] w-[700px] rounded-full bg-[radial-gradient(closest-side,rgba(12,92,67,0.55),transparent)]" />
        <div className="absolute inset-0 opacity-[0.07] [background-image:linear-gradient(rgba(255,255,255,.6)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.6)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_75%)]" />
      </div>

      <div className="relative mx-auto max-w-[1180px] px-4 pb-14 min-[480px]:px-8">
        <div className="flex h-16 items-center justify-between">
          <img src="/netenroll-logo-dark.png" width={918} height={179} alt="NetEnroll" className="h-6 w-auto" />
          <button onClick={onClose} className="h-12 text-[15px] font-medium text-white/70 transition-colors hover:text-white">Skip to the full planner →</button>
        </div>

        <div className="grid items-center gap-10 pt-6 lg:grid-cols-[1.05fr_1fr] lg:gap-14 lg:pt-16">
          {/* left: the pitch and the one question */}
          <div className="intro-rise">
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-400/10 px-3.5 py-1.5 text-[13px] font-semibold text-emerald-300 ring-1 ring-emerald-400/30">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />For Final Expense and Medicare agency owners
            </span>
            <h1 className="mt-6 font-display text-[42px] font-semibold leading-[1.02] tracking-[-0.03em] min-[480px]:text-[56px] lg:text-[68px]">
              See what your agency could <span className="bg-gradient-to-r from-emerald-300 to-emerald-500 bg-clip-text text-transparent">pay you.</span>
            </h1>
            <p className="mt-5 max-w-[520px] text-[18px] leading-relaxed text-white/75">
              Answer one question. Watch your take-home, three-year profit and sale value build in real time.
            </p>

            <div className="mt-8 rounded-3xl bg-white/[0.06] p-6 ring-1 ring-white/10 backdrop-blur min-[480px]:p-7">
              <label htmlFor="intro-agents" className="text-[17px] font-semibold">How many agents do you have today?</label>
              <div className="mt-4 flex items-center gap-3">
                <button className={step} onClick={() => set(a0 - 1)} disabled={a0 <= 1} aria-label="One fewer agent">−</button>
                <input id="intro-agents" type="number" inputMode="numeric" min={1} max={1000} value={draft}
                  onChange={(e) => { setDraft(e.target.value); const n = e.target.valueAsNumber; if (Number.isFinite(n) && n >= 1 && n <= 1000) setA0(Math.round(n)); }}
                  onBlur={() => set(Number(draft) || a0)}
                  className="tnum h-14 w-full min-w-0 rounded-2xl bg-white/5 text-center font-display text-[36px] font-semibold text-white ring-1 ring-white/15 focus:ring-2 focus:ring-emerald-400"
                  style={{ outline: 'none' }} />
                <button className={step} onClick={() => set(a0 + 1)} disabled={a0 >= 1000} aria-label="One more agent">+</button>
              </div>
              <input type="range" aria-label="Agents today" min={1} max={200} step={1} value={Math.min(200, a0)} onChange={(e) => set(+e.target.value)}
                className="intro-range mt-5 h-6 w-full cursor-pointer" style={{ ['--fill' as string]: fill }} />
              <p className="mt-4 text-[13px] leading-relaxed text-white/55">
                Assumes Final Expense and Medicare, half your agents on each, and a team twice this size a year from now. You can change every number in the full plan.
              </p>
            </div>
          </div>

          {/* right: the live result */}
          <div className="intro-rise rounded-[28px] bg-white p-6 text-ink shadow-[0_40px_120px_-30px_rgba(16,185,129,0.45)] min-[480px]:p-8" style={{ animationDelay: '120ms' }}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[14px] font-semibold text-sub">Your agency with {int(a0)} agents</p>
              <p className="text-[13px] text-muted">{int(answers.a1)} a year from now</p>
            </div>

            <p className="mt-6 text-[13px] font-semibold uppercase tracking-[0.08em] text-muted">Your take-home</p>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <Num v={years[1]} f={compact} className="font-display text-[56px] font-semibold leading-none tracking-[-0.03em] text-emerald-600 min-[480px]:text-[68px]" />
              <span className="text-[16px] text-sub">a month in Year 2</span>
            </div>

            {/* take-home by year */}
            <div className="mt-6 grid grid-cols-3 items-end gap-3">
              {years.map((v, j) => (
                <div key={j}>
                  <div className="flex h-24 items-end rounded-xl bg-slate-100">
                    <div className={`w-full rounded-xl transition-[height] duration-500 ${j === 1 ? 'bg-emerald-500' : 'bg-emerald-200'}`} style={{ height: `${Math.max(6, (Math.max(0, v) / peak) * 100)}%` }} />
                  </div>
                  <p className="mt-2 text-[12px] text-muted">Year {j + 1}</p>
                  <Num v={v} f={compact} className="text-[15px] font-semibold text-ink" />
                </div>
              ))}
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
                <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Profit over 3 years</p>
                <Num v={s.out.cumulative.totalNet} f={compact} className="mt-1 block font-display text-[26px] font-semibold tracking-tight" />
              </div>
              <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200/70">
                <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Could sell for</p>
                <Num v={s.exit.price.base} f={compact} className="mt-1 block font-display text-[26px] font-semibold tracking-tight" />
              </div>
            </div>

            <button onClick={() => onApply(answers)}
              className="mt-7 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-[#0c5c43] text-[17px] font-semibold text-white shadow-[0_12px_30px_-10px_rgba(12,92,67,0.8)] transition-colors hover:bg-[#094a36]">
              Build my full plan <span aria-hidden>→</span>
            </button>
            <a href={SIGNUP} className="mt-3 flex h-12 items-center justify-center text-[15px] font-semibold text-[#0c5c43] hover:underline">Open my producer account</a>
          </div>
        </div>

        <p className="mt-12 text-center text-[12px] text-white/45">
          Estimates from NetEnroll's standard assumptions. Not a guarantee of income or an offer to buy your agency.
        </p>
      </div>
    </div>
  );
}
