import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  Scatter,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS,
  Chart,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  MoneyTooltip,
  SERIES,
  TIME_AXIS,
  TOTAL,
  useChartMotion,
  useMoneyTick,
  useTimeAxis,
} from "@/components/chart.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { getDateFormat } from "@/lib/dates.js";

// Every figure on this page is fabricated. It exists so a feature phase can
// copy a working example rather than reconstruct one from the Recharts docs
// and get the app's axis chrome, tooltip and colours wrong on the way.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const LINE_ROWS = [4200, 4350, 4100, 4600, 4800, 4700, 5000, 5200, 5100, 5400, 5600, 5800].map(
  (balance, i) => ({ label: MONTHS[i] ?? "", balance }),
);

const BAR_ROWS = [
  { label: "Groceries", spend: 620 },
  { label: "Utilities", spend: 310 },
  { label: "Transport", spend: 180 },
  { label: "Dining", spend: 240 },
  { label: "Subscriptions", spend: 95 },
  { label: "Other", spend: 150 },
];

const PIE_ROWS = [
  { name: "Housing", value: 1800 },
  { name: "Insurance", value: 600 },
  { name: "Groceries", value: 700 },
  { name: "Fun", value: 400 },
  { name: "Savings", value: 900 },
].map((slice, i) => ({ ...slice, fill: SERIES[i % SERIES.length] ?? SERIES[0] }));

const STACK_ROWS = MONTHS.map((label, i) => ({
  label,
  essential: 1400 + ((i * 97) % 260),
  nonEssential: 500 + ((i * 53) % 340),
}));

// Fortnightly paydays with a bill on every third one, so the marker series is
// genuinely sparse — the shape /costs/fixed's balance curve has.
const CURVE_ROWS = Array.from({ length: 26 }, (_, i) => {
  const iso = `2026-01-${String((i % 28) + 1).padStart(2, "0")}`;
  const date = new Date(2026, 0, 1 + i * 14);
  const t = date.getTime();
  const balance = 2400 + Math.round(Math.sin(i / 2) * 900) + i * 40;
  return {
    t,
    label: getDateFormat("en-AU", { dateStyle: "medium" }).format(date),
    iso,
    balance,
    bill: i % 3 === 0 ? balance : null,
  };
});

/**
 * Not in navigation. One working example of each chart shape this app uses —
 * area over categories, bar, donut, stacked area, and a real time axis with
 * sparse markers — for feature phases to copy from, per phase 02's
 * chart-foundation task.
 *
 * Kept in step with the app: when a chart type stops being used, it stops
 * being demonstrated here. The sankey and calendar heatmap that used to sit
 * on this page went when the last of each left the app.
 */
export function DevChartsPage() {
  const moneyTick = useMoneyTick();
  const motion = useChartMotion();
  const timeAxis = useTimeAxis(CURVE_ROWS[0]?.t ?? 0, CURVE_ROWS[CURVE_ROWS.length - 1]?.t ?? 0);

  return (
    <>
      <PageHeader
        title="Chart reference"
        description="Hidden dev route — not linked from navigation. A working example of each chart shape for feature phases to copy from."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard title="Area over categories">
          <Chart
            height={280}
            ariaLabel="Demo area chart with fabricated data."
            config={{ balance: { label: "Balance", color: TOTAL } }}
          >
            <AreaChart data={LINE_ROWS} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...AXIS} minTickGap={16} />
              <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
              <ChartTooltip content={<MoneyTooltip />} />
              <Area
                dataKey="balance"
                type="monotone"
                stroke="var(--color-balance)"
                fill="var(--color-balance)"
                fillOpacity={0.15}
                strokeWidth={2}
                dot={false}
                {...motion}
              />
            </AreaChart>
          </Chart>
        </ChartCard>

        <ChartCard title="Bar">
          <Chart
            height={280}
            ariaLabel="Demo bar chart with fabricated data."
            config={{ spend: { label: "Spend", color: TOTAL } }}
          >
            <BarChart data={BAR_ROWS} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...AXIS} interval={0} />
              <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
              <ChartTooltip content={<MoneyTooltip />} />
              {/* Rounded caps are a per-series style, not something the
                  shared wrapper can guess at. */}
              <Bar dataKey="spend" fill="var(--color-spend)" radius={[6, 6, 0, 0]} maxBarSize={32} {...motion} />
            </BarChart>
          </Chart>
        </ChartCard>

        <ChartCard title="Donut">
          <Chart
            height={320}
            ariaLabel="Demo donut chart with fabricated data."
            // Keyed by the displayed name and carrying no colour: a custom
            // property named after free text would not be a valid CSS
            // identifier. Colours go on the <Cell>.
            config={Object.fromEntries(PIE_ROWS.map((slice) => [slice.name, { label: slice.name }]))}
          >
            <PieChart>
              <ChartTooltip content={<MoneyTooltip nameKey="name" hideLabel />} />
              <Pie data={PIE_ROWS} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="75%" {...motion}>
                {PIE_ROWS.map((slice) => (
                  <Cell key={slice.name} fill={slice.fill} stroke="var(--surface)" strokeWidth={2} />
                ))}
              </Pie>
              <ChartLegend content={<ChartLegendContent nameKey="name" />} />
            </PieChart>
          </Chart>
        </ChartCard>

        <ChartCard title="Stacked area">
          <Chart
            height={280}
            ariaLabel="Demo stacked area chart with fabricated data."
            config={{
              essential: { label: "Essential", color: TOTAL },
              nonEssential: { label: "Non-essential", color: SERIES[1] },
            }}
          >
            <AreaChart data={STACK_ROWS} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...AXIS} minTickGap={16} />
              <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
              <ChartTooltip content={<MoneyTooltip />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Area
                dataKey="essential"
                type="monotone"
                stackId="total"
                stroke="var(--color-essential)"
                fill="var(--color-essential)"
                fillOpacity={0.3}
                strokeWidth={2}
                dot={false}
                {...motion}
              />
              <Area
                dataKey="nonEssential"
                type="monotone"
                stackId="total"
                stroke="var(--color-nonEssential)"
                fill="var(--color-nonEssential)"
                fillOpacity={0.3}
                strokeWidth={2}
                dot={false}
                {...motion}
              />
            </AreaChart>
          </Chart>
        </ChartCard>

        <ChartCard title="Time axis with sparse markers">
          <Chart
            height={280}
            ariaLabel="Demo time-axis chart with fabricated data and sparse event markers."
            config={{
              balance: { label: "Balance", color: TOTAL },
              bill: { label: "Bill due", color: "var(--negative)" },
            }}
          >
            <ComposedChart data={CURVE_ROWS} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              {/* `TIME_AXIS` + `useTimeAxis` is the pattern for anything
                  plotted against real dates: the helper decides whether the
                  span calls for day or month gridlines. */}
              <XAxis dataKey="t" {...AXIS} {...TIME_AXIS} {...timeAxis} minTickGap={32} />
              <YAxis {...AXIS} width={56} tickFormatter={moneyTick} />
              <ChartTooltip content={<MoneyTooltip />} />
              <Area
                dataKey="balance"
                type="monotone"
                stroke="var(--color-balance)"
                fill="var(--color-balance)"
                fillOpacity={0.15}
                strokeWidth={2}
                dot={false}
                {...motion}
              />
              <Scatter dataKey="bill" fill="var(--color-bill)" shape="circle" {...motion} />
            </ComposedChart>
          </Chart>
        </ChartCard>

        <ChartCard title="Non-money values">
          <Chart
            height={280}
            ariaLabel="Demo bar chart of plain multipliers with fabricated data."
            config={{ factor: { label: "Factor", color: TOTAL } }}
          >
            <BarChart
              data={MONTHS.map((label, i) => ({ label, factor: 1 + Math.sin(i / 2) * 0.3 }))}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" {...AXIS} interval={0} />
              <YAxis {...AXIS} width={40} />
              {/* Plain `ChartTooltipContent`, not `MoneyTooltip` — these are
                  multipliers, and money formatting would render 1.2 as
                  "$1.20". */}
              <ChartTooltip content={<ChartTooltipContent hideIndicator />} />
              <Bar dataKey="factor" fill="var(--color-factor)" radius={[6, 6, 0, 0]} maxBarSize={32} {...motion} />
            </BarChart>
          </Chart>
        </ChartCard>
      </div>
    </>
  );
}

/** @param {{ title: string, children: import("react").ReactNode }} props */
function ChartCard({ title, children }) {
  return (
    <div className="rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
      <p className="mb-3 text-sm font-medium text-text-muted">{title}</p>
      {children}
    </div>
  );
}
