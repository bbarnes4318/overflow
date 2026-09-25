import {
  Area, Bar, CartesianGrid, ComposedChart, LabelList, Legend, Line, ReferenceArea, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { Outputs } from './engine/model';
import type { YearExit } from './engine/valuation';
import { compact, fmt, FE_ROWS, MD_ROWS, type Kind } from './format';

// NetEnroll light theme. brand = the site's green (UI and profit taken), net = success green, fe = blue so the
// Final Expense line never reads as a second green; every mark is >= 3:1 on white. Costs are neutral on purpose.
// Keep in sync with the @theme block in index.css.
export const C = {
  brand: '#0c5c43',
  fe: '#0c5c43', feLight: '#7fb5a1',
  md: '#475569', mdLight: '#9aa7b8',
  net: '#15a06a', cost: '#b3bcb8',
  surface: '#ffffff', grid: '#e3e7ed', muted: '#5a6660', ink: '#0e1512', neg: '#b42318',
};
const cursor = { fill: '#0f172a', fillOpacity: 0.04 };

const axis = { stroke: C.muted, fontSize: 12, tickLine: false, axisLine: false } as const;
const legend = { verticalAlign: 'top' as const, align: 'right' as const, iconType: 'circle' as const, iconSize: 8, itemSorter: null, wrapperStyle: { fontSize: 12, color: C.muted, paddingBottom: 12 },
  // Recharts colors legend text by series; keep the label readable and let the dot carry the color.
  formatter: (v: unknown) => <span style={{ color: C.muted }}>{String(v)}</span> };
const bar = { isAnimationActive: false, stroke: C.surface, strokeWidth: 2 } as const;
const topLabel = { position: 'top' as const, formatter: (v: unknown) => compact(Number(v)), fill: C.ink, fontSize: 12, fontWeight: 600 };

// Sizes charts in layout pixels. Recharts' ResponsiveContainer can measure the CSS-scaled (screen) size and overflow.
function Fit({ children }: { children: (w: number, h: number) => ReactElement }) {
  const ref = useRef<HTMLDivElement>(null);
  const [s, setS] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setS({ w: el.offsetWidth, h: el.offsetHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div ref={ref} className="h-full w-full overflow-hidden">{s.w > 0 && children(s.w, s.h)}</div>;
}

function Tip({ title, rows }: { title: string; rows: [string, Kind, number, string?][] }) {
  return (
    <div className="min-w-[220px] rounded-lg border border-line bg-white px-3 py-2.5 text-[12px] leading-[18px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.18)]">
      <div className="mb-1.5 font-semibold text-ink">{title}</div>
      {rows.map(([l, k, v, color]) => (
        <div key={l} className="flex items-center justify-between gap-6">
          <span className="flex items-center gap-2 text-muted">
            {color && <span className="h-2 w-2 rounded-full" style={{ background: color }} />}{l}
          </span>
          <span className={`tnum ${v < 0 ? 'text-cost' : 'text-ink'}`}>{fmt(k, v)}</span>
        </div>
      ))}
    </div>
  );
}

export function OverviewChart({ out }: { out: Outputs }) {
  const data = out.years.map((y, i) => ({ name: `Year ${i + 1}`, ...y }));
  return (
    <Fit>{(w, h) => (
      <ComposedChart width={w} height={h} data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={6} barCategoryGap="24%">
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="name" {...axis} fontSize={13} tick={{ fill: C.ink }} dy={6} />
        <YAxis tickFormatter={compact} width={60} {...axis} />
        <Tooltip cursor={cursor} content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const y = payload[0].payload as (typeof data)[number];
          return <Tip title={y.name} rows={[
            ['Final Expense revenue', '$', y.feRev, C.fe], ['Medicare revenue', '$', y.mdRev, C.md],
            ['Costs', '$', y.totalCost, C.cost], ['Net profit', '$', y.totalNet, C.net],
          ]} />;
        }} />
        <Legend {...legend} />
        <Bar dataKey="feRev" name="Final Expense revenue" stackId="rev" fill={C.fe} {...bar} />
        <Bar dataKey="mdRev" name="Medicare revenue" stackId="rev" fill={C.md} {...bar} minPointSize={1} radius={[4, 4, 0, 0]}>
          <LabelList dataKey="totalRev" {...topLabel} />
        </Bar>
        <Bar dataKey="totalCost" name="Costs" fill={C.cost} {...bar} radius={[4, 4, 0, 0]} />
        <Bar dataKey="totalNet" name="Net profit" fill={C.net} {...bar} radius={[4, 4, 0, 0]}>
          <LabelList dataKey="totalNet" {...topLabel} />
        </Bar>
      </ComposedChart>
    )}</Fit>
  );
}

// Final Expense cash, month by month: what actually lands (advances + months 10–12 payments) vs what goes out.
export function CashFlowChart({ out }: { out: Outputs }) {
  const data = out.fe.map((r) => ({ ...r, name: `M${r.month}` }));
  return (
    <Fit>{(w, h) => (
      <ComposedChart width={w} height={h} data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%">
        <ReferenceArea x1="M13" x2="M24" fill="#0f172a" fillOpacity={0.03} />
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="name" {...axis} ticks={['M1', 'M6', 'M12', 'M13', 'M18', 'M24', 'M25', 'M30', 'M36']}
          tickFormatter={(v: string) => (v === 'M1' ? 'Year 1' : v === 'M13' ? 'Year 2' : v === 'M25' ? 'Year 3' : v.replace('M', 'Mo '))} dy={6} />
        <YAxis tickFormatter={compact} width={60} {...axis} />
        <Tooltip cursor={cursor} content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const r = payload[0].payload as (typeof data)[number];
          return <Tip title={`Month ${r.month} · Year ${Math.ceil(r.month / 12)}`} rows={[
            ['Advanced commissions', '$', r.advRev, C.feLight], ['Months 10–12 payments', '$', r.tailCash, '#c6dfd5'],
            ['Cash in', '$', r.cashIn], ['Agent payouts', '$', r.agentPayout, C.cost], ['Application costs', '$', r.callCost, C.cost],
            ['Chargebacks', '$', r.lapseCost, C.cost], ['Cash out', '$', r.totalCost], ['Net cash flow', '$', r.cashNet, C.net],
          ]} />;
        }} />
        <Legend {...legend} />
        <Bar dataKey="advRev" name="Advanced commissions" stackId="in" fill={C.feLight} isAnimationActive={false} />
        <Bar dataKey="tailCash" name="Months 10–12 payments" stackId="in" fill="#c6dfd5" isAnimationActive={false} radius={[2, 2, 0, 0]} />
        <Line dataKey="totalCost" name="Cash out (costs)" stroke={C.md} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
        <Line dataKey="cashNet" name="Net cash flow" stroke={C.fe} strokeWidth={3} dot={false} isAnimationActive={false} />
      </ComposedChart>
    )}</Fit>
  );
}

// Headcount needed: FE agents ramp every quarter; Medicare agents are set per selling season.
export function TeamChart({ out }: { out: Outputs }) {
  const data = out.fe.map((r) => ({ name: `M${r.month}`, fe: r, md: out.md[Math.ceil(r.month / 12) - 1] }));
  return (
    <Fit>{(w, h) => (
      <ComposedChart width={w} height={h} data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%">
        <ReferenceArea x1="M13" x2="M24" fill="#0f172a" fillOpacity={0.03} />
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="name" {...axis} ticks={['M1', 'M6', 'M12', 'M13', 'M18', 'M24', 'M25', 'M30', 'M36']}
          tickFormatter={(v: string) => (v === 'M1' ? 'Year 1' : v === 'M13' ? 'Year 2' : v === 'M25' ? 'Year 3' : v.replace('M', 'Mo '))} dy={6} />
        <YAxis width={60} {...axis} allowDecimals={false} />
        <Tooltip cursor={cursor} content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const d = payload[0].payload as (typeof data)[number];
          return <Tip title={`Month ${d.fe.month} · Year ${Math.ceil(d.fe.month / 12)}`} rows={[
            ['FE agents', 'n', d.fe.agents, C.fe], ['FE calls per day', 'n', d.fe.callsPerDay], ['FE applications', 'n', d.fe.totalApps],
            ['FE policies placed', 'n', d.fe.totalPlaced], ['Medicare agents (season)', 'n', d.md.agents, C.md],
            ['Medicare calls per day', 'n', d.md.callsPerDay], ['Medicare policies / selling mo.', 'n', d.md.totalPlaced],
          ]} />;
        }} />
        <Legend {...legend} />
        <Bar dataKey="fe.agents" name="Final Expense agents" fill={C.fe} isAnimationActive={false} radius={[2, 2, 0, 0]} />
        <Line dataKey="md.agents" name="Medicare agents (selling season)" type="stepAfter" stroke={C.md} strokeWidth={2.5} dot={false} isAnimationActive={false} />
      </ComposedChart>
    )}</Fit>
  );
}

export function MedicareChart({ out }: { out: Outputs }) {
  const data = out.years.map((y, i) => ({ name: `Year ${i + 1}`, ...y, month: out.md[i] }));
  return (
    <Fit>{(w, h) => (
      <ComposedChart width={w} height={h} data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={6} barCategoryGap="24%">
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey="name" {...axis} fontSize={13} tick={{ fill: C.ink }} dy={6} />
        <YAxis tickFormatter={compact} width={60} {...axis} />
        <Tooltip cursor={cursor} content={({ active, payload }) => {
          if (!active || !payload?.length) return null;
          const d = payload[0].payload as (typeof data)[number];
          return <Tip title={`${d.name} · per selling month (×5)`} rows={[
            ...MD_ROWS.map(([k, l, kind]) => [l, kind, d.month[k]] as [string, Kind, number]),
            ['Year new revenue', '$', d.mdNew, C.md], ['Year renewal revenue', '$', d.mdResid, C.mdLight], ['Year net profit', '$', d.mdNet, C.net],
          ]} />;
        }} />
        <Legend {...legend} />
        <Bar dataKey="mdNew" name="New policies" stackId="rev" fill={C.md} {...bar} />
        <Bar dataKey="mdResid" name="Renewals" stackId="rev" fill={C.mdLight} {...bar} minPointSize={1} radius={[4, 4, 0, 0]}>
          <LabelList dataKey="mdRev" {...topLabel} />
        </Bar>
        <Bar dataKey="mdCosts" name="Costs" fill={C.cost} {...bar} radius={[4, 4, 0, 0]} />
        <Bar dataKey="mdNet" name="Net profit" fill={C.net} {...bar} radius={[4, 4, 0, 0]}>
          <LabelList dataKey="mdNet" {...topLabel} />
        </Bar>
      </ComposedChart>
    )}</Fit>
  );
}

export const GOLD = '#15a06a'; // sale price: the money green

// Total wealth if you sell at each year-end: profit already taken + sale price + FE money still owed.
export function SellOrHoldChart({ ex }: { ex: YearExit[] }) {
  const data = ex.map((e, k) => ({ ...e, name: `Year ${e.y}`, sale: e.price.base, gain: k < 2 ? ex[k + 1].walkAway - e.walkAway : null }));
  const margin = { top: 28, right: 8, left: 0, bottom: 0 };
  return (
    <Fit>{(w, h) => {
      const band = (w - margin.left - margin.right - 60) / data.length;
      return (
        <ComposedChart width={w} height={h} data={data} margin={margin} barCategoryGap="38%">
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="name" {...axis} fontSize={13} tick={{ fill: C.ink }} dy={6} />
          <YAxis tickFormatter={compact} width={60} {...axis} />
          <Tooltip cursor={cursor} content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload as (typeof data)[number];
            return <Tip title={`Sell at the end of ${d.name}`} rows={[
              ['Profit already taken', '$', d.cumProfit, C.brand], ['Sale price', '$', d.sale, GOLD],
              ['FE commissions still owed', '$', d.receivable, C.feLight], ['Total if sold here', '$', d.walkAway],
            ]} />;
          }} />
          <Legend {...legend} />
          <Bar dataKey="cumProfit" name="Profit already taken" stackId="w" fill={C.brand} {...bar} />
          <Bar dataKey="sale" name="Sale price" stackId="w" fill={GOLD} {...bar} />
          <Bar dataKey="receivable" name="FE commissions still owed" stackId="w" fill={C.feLight} {...bar} radius={[4, 4, 0, 0]}>
            <LabelList dataKey="walkAway" {...topLabel} />
            <LabelList dataKey="gain" content={(p) => {
              const g = data[p.index ?? 0]?.gain;
              if (g == null) return null;
              const x = Number(p.x) + Number(p.width) / 2 + band / 2;
              return (
                <text x={x} y={Number(p.y) - 8} textAnchor="middle" fontSize={12}>
                  <tspan x={x} fill={g < 0 ? C.neg : C.net} fontWeight={600}>{g < 0 ? '' : '+'}{compact(g)}</tspan>
                  <tspan x={x} dy={15} fill={C.muted} fontSize={11}>one more year</tspan>
                </text>
              );
            }} />
          </Bar>
        </ComposedChart>
      );
    }}</Fit>
  );
}
