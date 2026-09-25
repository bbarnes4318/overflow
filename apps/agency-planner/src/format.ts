import type { FeMonth, MdMonth, YearSummary } from './engine/model';

const usd = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const wrap = (v: number, s: string) => (v < -0.5 ? `(${s})` : s);
export const money = (v: number) => wrap(v, `$${usd.format(Math.abs(v))}`);
export const pct = (v: number) => `${one.format(v * 100)}%`;
export const num1 = (v: number) => one.format(v);
export const int = (v: number) => usd.format(v);

export function compact(v: number) {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${(a / 1e3).toFixed(1)}K` : `$${usd.format(a)}`;
  return v < 0 ? `(${s})` : s;
}

export const count = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : int(v));

export type Kind = '$' | 'n' | 'n1';
export const fmt = (k: Kind, v: number) => (k === '$' ? money(v) : k === 'n1' ? num1(v) : int(v));

export const FE_ROWS: [keyof FeMonth, string, Kind][] = [
  ['callsPerDay', 'Calls per day', 'n'],
  ['agents', 'Agents', 'n1'],
  ['totalCalls', 'Total calls', 'n'],
  ['appsPerDay', 'Apps per day', 'n1'],
  ['totalApps', 'Total apps', 'n1'],
  ['placedPerDay', 'Placed per day', 'n1'],
  ['totalPlaced', 'Total placed', 'n1'],
  ['advRevPerDay', 'Advanced revenue / day', '$'],
  ['advRev', 'Advanced revenue', '$'],
  ['agentPayout', 'Agent payout', '$'],
  ['callCost', 'Application cost', '$'],
  ['lapseCost', 'Lapse cost (chargebacks)', '$'],
  ['totalCost', 'Total cost', '$'],
  ['net', 'Net', '$'],
  ['netPerPlaced', 'Net per placed policy', '$'],
  ['tailEarned', 'Months 10–12 earned', '$'],
  ['tailCash', 'Months 10–12 cash received', '$'],
  ['cashIn', 'Cash in (advances + months 10–12)', '$'],
  ['cashNet', 'Net cash flow', '$'],
];

export const MD_ROWS: [keyof MdMonth, string, Kind][] = [
  ['agents', 'Agents', 'n1'],
  ['callsPerDay', 'Calls per day', 'n'],
  ['totalCalls', 'Total calls', 'n1'],
  ['appsPerDay', 'Apps per day', 'n1'],
  ['totalApps', 'Total apps', 'n1'],
  ['placedPerDay', 'Placed per day', 'n1'],
  ['totalPlaced', 'Total placed', 'n1'],
  ['revPerDay', 'Revenue / day', '$'],
  ['rev', 'Revenue', '$'],
  ['agentPayout', 'Agent payout', '$'],
  ['callCost', 'Application cost', '$'],
  ['lapseCost', 'Lapse cost', '$'],
  ['totalCost', 'Total cost', '$'],
  ['net', 'Net', '$'],
  ['netPerPlaced', 'Net per placed policy', '$'],
];

// [key, label, style] — style: '' plain, 't' total, 'n' net (bold)
export const SUMMARY_ROWS: [keyof YearSummary, string, '' | 't' | 'n'][] = [
  ['feAdv', 'FE Advanced Revenue', ''],
  ['feTail', 'FE Months 10–12 Revenue', ''],
  ['feRenew', 'FE Renewal Revenue', ''],
  ['feRev', 'Total FE Revenue', 't'],
  ['feRetention', 'FE Retention Cost', ''],
  ['feNet', 'Total FE Net', 'n'],
  ['mdNew', 'New Medicare Revenue', ''],
  ['mdResid', 'Medicare Renewal Revenue', ''],
  ['mdRev', 'Total Medicare Revenue', 't'],
  ['mdRetention', 'Medicare Retention Cost', ''],
  ['mdNet', 'Total Medicare Net', 'n'],
  ['totalRev', 'Total Revenue', 't'],
  ['totalNet', 'Total Net', 'n'],
];
