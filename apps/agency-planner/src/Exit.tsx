import { useMemo, type ReactNode } from 'react';
import { SPLIT_KEYS, type Inputs, type Outputs } from './engine/model';
import { levers, type YearExit } from './engine/valuation';
import { C, GOLD, SellOrHoldChart } from './Charts';
import { compact, money, num1, pct } from './format';
import { Card, Num } from './ui';

const mult = (v: number) => `${+v.toFixed(2)}x`;
const B = ({ children }: { children: ReactNode }) => <b className="font-semibold text-ink">{children}</b>;
const Badge = ({ lens }: { lens: YearExit['lens'] }) => (
  <span className="rounded px-1.5 text-[10.5px] font-medium leading-[18px] text-sub ring-1 ring-line">{lens === 'earnings' ? 'Priced on earnings' : 'Priced as a book'}</span>
);

// One waterfall-ish row: label, a bar spanning [from, to] on a shared scale, value.
function Row({ label, value, from = 0, to, scale, color, strong }: {
  label: string; value: string; from?: number; to?: number; scale: number; color?: string; strong?: boolean;
}) {
  const l = Math.max(0, Math.min(from, to ?? 0)) / scale;
  const r = Math.max(0, Math.max(from, to ?? 0)) / scale;
  return (
    <div className="grid h-[22px] grid-cols-[150px_1fr_72px] items-center gap-2 text-[12px]">
      <span className={`truncate ${strong ? 'font-semibold text-ink' : 'text-muted'}`}>{label}</span>
      <div className="relative h-2">
        {to !== undefined && <div className="absolute h-full rounded-sm transition-all duration-500" style={{ left: `${l * 100}%`, width: `${(r - l) * 100}%`, background: color }} />}
      </div>
      <span className={`tnum text-right ${strong ? 'font-semibold text-ink' : 'text-sub'}`}>{value}</span>
    </div>
  );
}

function LensTile({ title, sub, win, lose, children }: { title: string; sub: string; win: boolean; lose: string; children: ReactNode }) {
  return (
    <div className={`flex flex-col rounded-xl px-4 py-3 ring-1 transition-opacity ${win ? 'bg-white ring-brand/40' : 'bg-surface2/40 ring-line/70'}`}>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <span className="text-[12px] text-muted">{sub}</span>
        {win && <span className="exit-tab ml-auto rounded px-1.5 text-[10.5px] font-semibold uppercase leading-[18px] text-canvas">This is your number</span>}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
      {!win && <div className="mt-auto pt-1.5 text-[12px] text-sub">{lose}</div>}
    </div>
  );
}

export function Exit({ inputs, out, ex, names, year, setYear }: {
  inputs: Inputs; out: Outputs; ex: YearExit[]; names: string[]; year: 1 | 2 | 3; setYear: (y: 1 | 2 | 3) => void;
}) {
  const e = ex[year - 1];
  const top = useMemo(() => levers(inputs, year).slice(0, 3), [inputs, year]);
  const splitsOk = Math.abs(out.splitTotal - 1) < 1e-6;
  const other = e.lens === 'earnings' ? e.book.base : e.earnings.base;
  const lose = `${e.lens === 'earnings' ? 'A book' : 'An earnings'} offer would be ${compact(other)} — ${compact(e.price.base - other)} less.`;
  const eScale = Math.max(e.ttmNet, e.earnings.base, 1);
  const spread = e.price.high - e.price.low;
  const at = spread > 0 ? (e.price.base - e.price.low) / spread : 0.5;
  const closeShare = e.price.base > 0 ? e.atClose / e.price.base : 0;

  return (
    <div className="relative flex min-h-0 flex-1 gap-4 p-4">
      {/* left: year-end picker, the number, the deal */}
      <div className="relative flex w-[440px] shrink-0 flex-col gap-3">
        <div className="flex flex-col gap-2">
          {ex.map((x) => (
            <button key={x.y} onClick={() => setYear(x.y as 1 | 2 | 3)} aria-pressed={x.y === year}
              className={`flex h-[46px] items-center gap-3 rounded-xl px-4 text-left ring-1 transition-colors ${x.y === year ? 'bg-white ring-2 ring-brand/80' : 'bg-surface ring-line/70 hover:bg-surface2/60'}`}>
              <span className={`text-[13px] ${x.y === year ? 'font-semibold text-ink' : 'text-muted'}`}>End of Year {x.y}</span>
              <Badge lens={x.lens} />
              <Num v={x.price.base} f={compact} className="ml-auto text-[20px] font-semibold" />
            </button>
          ))}
        </div>

        <Card className="relative overflow-hidden px-5 pb-4 pt-4">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted">If you sold at the end of Year {year}</div>
          <Num v={e.price.base} f={compact} className="exit-grad mt-1 block text-[52px] font-bold leading-[62px] tracking-tight" />
          <div className="relative mt-2 h-2 rounded-full" style={{ background: `linear-gradient(90deg, ${C.brand}33, ${C.brand}, ${C.net})` }}>
            <div className="absolute -top-1 h-4 w-1 -translate-x-1/2 rounded-full bg-ink ring-2 ring-white transition-all duration-500" style={{ left: `${at * 100}%` }} />
          </div>
          <div className="relative mt-1.5 h-4 text-[12px] text-muted">
            <span className="absolute left-0">{compact(e.price.low)} low</span>
            <span className="absolute -translate-x-1/2 font-semibold text-ink" style={{ left: `${at * 100}%` }}>{compact(e.price.base)}</span>
            <span className="absolute right-0">high {compact(e.price.high)}</span>
          </div>
          <div className="mt-3 text-[12.5px] leading-[17px] text-sub">
            {e.lens === 'earnings'
              ? `${mult(e.tier.base)} adjusted EBITDA · ${e.buyer}`
              : `${mult(inputs.exitMdBookMult)} Medicare renewals + ${mult(inputs.exitFeBookMult)} FE renewals · ${e.buyer}`}
          </div>
        </Card>

        <Card className="flex min-h-0 flex-1 flex-col px-5 py-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-[14px] font-semibold">The deal</h2>
            <span className="text-[12px] text-muted">{inputs.exitSaleTax === 0 ? 'pre-tax' : `partners after ${pct(inputs.exitSaleTax)} tax`}</span>
          </div>
          <div className="flex h-3 gap-[2px] overflow-hidden rounded-full">
            <div className="transition-all duration-500" style={{ width: `${closeShare * 100}%`, background: GOLD }} />
            <div className="flex-1" style={{ background: `${GOLD}33` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[12px] text-muted">
            <span><span className="font-semibold" style={{ color: GOLD }}>{compact(e.atClose)}</span> cash at close</span>
            <span>earnout over 24 months <span className="font-semibold text-ink">{compact(e.earnout)}</span></span>
          </div>
          <div className="mt-2 rounded-lg bg-net/10 px-3 py-1.5 text-[12px] text-sub ring-1 ring-net/25">
            <span className="font-semibold text-netink">You also keep:</span> {money(e.receivable)} FE commissions still owed to you
          </div>
          <table className="mt-2 w-full text-[12.5px]">
            <thead>
              <tr className="h-6 text-[11.5px] text-muted">
                <th className="text-left font-medium">Partner</th>
                <th className="w-[56px] text-right font-medium">Split</th>
                <th className="w-[84px] text-right font-medium">Share</th>
                <th className="w-[84px] text-right font-medium">At close</th>
              </tr>
            </thead>
            <tbody>
              {e.partners.map((pt, k) => (
                <tr key={k} className="h-[26px] border-t border-line/70">
                  <td className="truncate font-medium text-ink">{names[k]}</td>
                  <td className="text-right text-sub">{pct(inputs[SPLIT_KEYS[k]])}</td>
                  {splitsOk ? (
                    <>
                      <td title={money(pt.share)} className="text-right font-semibold text-ink">{compact(pt.share)}</td>
                      <td title={money(pt.atClose)} className="text-right text-sub">{compact(pt.atClose)}</td>
                    </>
                  ) : <td colSpan={2} className="text-right text-muted">—</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {!splitsOk && (
            <div className="mt-2 rounded-md bg-cost/10 px-3 py-1.5 text-[12px] text-cost">
              Splits add up to {num1(out.splitTotal * 100)}%. Make them total 100% to see payouts.
            </div>
          )}
        </Card>
      </div>

      {/* right: how it's priced, sell vs hold, what moves it */}
      <div className="relative flex min-w-0 flex-1 flex-col gap-3">
        <Card className="shrink-0 px-4 pb-4 pt-3">
          <div className="mb-2.5 flex items-baseline gap-3">
            <h2 className="text-[14px] font-semibold">How a buyer prices you</h2>
            <span className="text-[12px] text-muted">End of Year {year} · the higher lens sets the price; they are never added</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <LensTile title="Earnings" sub={`${mult(e.tier.base)} · ${e.tier.buyer}`} win={e.lens === 'earnings'} lose={lose}>
              <Row label={`Year ${year} net profit`} value={compact(e.ttmNet)} to={e.ttmNet} scale={eScale} color={C.brand} />
              <Row label="Overhead buyers deduct" value={compact(-e.overhead)} from={e.adjEbitda} to={e.ttmNet} scale={eScale} color={C.cost} />
              <Row label="Adjusted EBITDA" value={compact(e.adjEbitda)} to={e.adjEbitda} scale={eScale} color={C.net} />
              <Row label="× multiple" value={mult(e.tier.base)} scale={eScale} />
              <Row label="Price" value={compact(e.earnings.base)} to={e.earnings.base} scale={eScale} color={GOLD} strong />
            </LensTile>
            <LensTile title="Book" sub="renewals the book pays next 12 months" win={e.lens === 'book'} lose={lose}>
              <Row label="Medicare renewals" value={compact(e.mdFwd)} to={e.mdFwd} scale={Math.max(e.book.base, 1)} color={C.md} />
              <Row label={`× ${mult(inputs.exitMdBookMult)}`} value={compact(e.mdFwd * inputs.exitMdBookMult)} scale={1} />
              <Row label="FE renewals" value={compact(e.feFwd)} to={e.feFwd} scale={Math.max(e.book.base, 1)} color={C.fe} />
              <Row label={`× ${mult(inputs.exitFeBookMult)}`} value={compact(e.feFwd * inputs.exitFeBookMult)} scale={1} />
              <Row label="Price" value={compact(e.book.base)} to={e.book.base} scale={Math.max(e.book.base, 1)} color={GOLD} strong />
            </LensTile>
          </div>
        </Card>

        <Card className="flex min-h-0 flex-1 flex-col p-4">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[14px] font-semibold">Sell now or keep building</h2>
            <span className="text-[12px] text-muted">Everything you walk away with if you sell at each year-end</span>
          </div>
          <div className="min-h-0 flex-1"><SellOrHoldChart ex={ex} /></div>
        </Card>

        <div className="flex shrink-0 gap-3 text-[12px] leading-[17px]">
          <div className="flex-1 rounded-xl bg-surface px-4 py-2.5 text-muted ring-1 ring-line/70">
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-sub">Next multiple</div>
            {e.nextTier
              ? <><B>{compact(e.nextTier.gap)}</B> more adjusted EBITDA moves you from {mult(e.tier.base)} to <B>{mult(e.nextTier.tier.base)}</B> — <B>{compact(e.nextTier.valueAtFloor)}</B> at that line.</>
              : <>Top tier.</>}
          </div>
          <div className="flex-1 rounded-xl bg-surface px-4 py-2.5 text-muted ring-1 ring-line/70">
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-sub">Biggest levers</div>
            {top.map((l) => (
              <div key={l.label} className="flex justify-between gap-2">
                <span className="truncate">{l.label}</span><span className="tnum shrink-0 font-semibold text-netink">{l.delta < 0 ? '' : '+'}{compact(l.delta)}</span>
              </div>
            ))}
          </div>
          {e.lockedIn > 0 && (
            <div className="flex-1 rounded-xl bg-gold/10 px-4 py-2.5 text-sub ring-1 ring-gold/25">
              <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: GOLD }}>Locked-in renewals</div>
              Next year's renewals already in force: <B>{compact(e.lockedIn)}</B> more than Year {year} paid. Trailing-earnings buyers get that free — push it into the earnout.
            </div>
          )}
        </div>
        <div className="-mt-1 flex shrink-0 justify-between gap-4 text-[11px] text-muted">
          <span>Ranges reflect FE/Medicare agency deal multiples. Price is pre-tax unless tax on sale is set. Earnout paid over 24 months subject to retention.</span>
          <a href="tel:+19045128487" className="shrink-0 font-semibold text-brand hover:underline">Questions? Call 904-512-8487</a>
        </div>
      </div>
    </div>
  );
}
