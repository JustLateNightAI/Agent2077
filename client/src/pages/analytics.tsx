import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import {
  TrendingUp, Zap, Clock, Brain, Box, Loader2, RefreshCw, BarChart2,
  Timer, CheckCircle2, Cpu, ArrowDownToLine, ArrowUpFromLine,
} from "lucide-react";

type OverviewData = {
  summary: {
    totalEventsToday: number;
    totalTokensToday: number;
    avgResponseTimeMs: number;
    activeModels: number;
  };
  dailyUsage: { date: string; events: number; tokens: number; tokensIn: number; tokensOut: number }[];
  tokensByModel: { model: string; tokens: number; totalIn: number; totalOut: number }[];
  taskTypeDistribution: { taskType: string; count: number }[];
  avgResponseByModel: { model: string; avgMs: number }[];
  dockerStatus?: { ready: boolean; running: number; total: number };
  efficiencyMetrics?: {
    totalComputeHours: number;
    successRate: number;
    tokensPerConversation: number;
    tokensPerToolCall: number;
    totalTokensIn: number;
    totalTokensOut: number;
  };
};

type ConversationTokenRow = {
  conversationId: number | null;
  title: string;
  totalIn: number;
  totalOut: number;
  modelId: string | null;
  date: string;
};

const CHART_COLORS = [
  "hsl(190 95% 50%)", // cyan primary
  "hsl(330 85% 60%)", // pink accent
  "hsl(45 95% 60%)",  // amber
  "hsl(120 60% 50%)", // green
  "hsl(270 60% 60%)", // purple
  "hsl(0 75% 55%)",   // red
];

const TASK_COLORS: Record<string, string> = {
  coding: "hsl(120 60% 50%)",
  research: "hsl(210 80% 60%)",
  creative: "hsl(270 60% 60%)",
  math: "hsl(45 95% 60%)",
  general: "hsl(190 95% 50%)",
};

function SummaryCard({ title, value, sub, icon: Icon, color }: {
  title: string; value: string | number; sub?: string; icon: any; color?: string;
}) {
  return (
    <Card data-testid={`summary-card-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <CardContent className="pt-4 pb-4 px-4">
        <div className="flex items-start gap-3">
          <div className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 ${color || "bg-primary/10"}`}>
            <Icon className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{title}</p>
            <p className="text-lg font-mono font-bold text-foreground" data-testid={`value-${title.toLowerCase().replace(/\s+/g, "-")}`}>{value}</p>
            {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border border-border rounded-md p-2 text-xs shadow-lg">
      <p className="font-mono text-muted-foreground mb-1">{label}</p>
      {payload.map((entry: any, i: number) => (
        <p key={i} style={{ color: entry.color }} className="text-[10px]">
          {entry.name}: <span className="font-mono">{entry.value?.toLocaleString()}</span>
        </p>
      ))}
    </div>
  );
};

function truncateModel(id: string, max = 14) {
  const name = id.split("/").pop() || id;
  return name.length > max ? name.slice(0, max) + "…" : name;
}

export default function AnalyticsPage() {
  const [days, setDays] = useState("30");

  const { data, isLoading, isError, error, refetch } = useQuery<OverviewData>({
    queryKey: ["/api/analytics/overview", days],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/analytics/overview?days=${days}`);
      return res.json();
    },
  });

  const { data: tokenUsageRows } = useQuery<ConversationTokenRow[]>({
    queryKey: ["/api/analytics/token-usage"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/analytics/token-usage?limit=15");
      return res.json();
    },
  });

  const summary = data?.summary ?? { totalEventsToday: 0, totalTokensToday: 0, avgResponseTimeMs: 0, activeModels: 0 };
  const dailyUsage = data?.dailyUsage ?? [];
  const tokensByModel = (data?.tokensByModel ?? []).map(t => ({ ...t, model: truncateModel(t.model) }));
  const taskDist = data?.taskTypeDistribution ?? [];
  const avgResponse = (data?.avgResponseByModel ?? []).map(t => ({ ...t, model: truncateModel(t.model) }));
  const docker = data?.dockerStatus;
  const efficiency = data?.efficiencyMetrics;
  const convTokenRows = tokenUsageRows ?? [];

  const avgMs = summary.avgResponseTimeMs;
  const avgSec = avgMs >= 1000 ? `${(avgMs / 1000).toFixed(1)}s` : `${avgMs}ms`;

  return (
    <div className="h-full flex flex-col" data-testid="analytics-page">
      {/* Header */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3">
        <BarChart2 className="w-4 h-4 text-primary" />
        <div className="flex-1">
          <h1 className="text-sm font-mono font-bold text-primary">ANALYTICS</h1>
          <p className="text-[10px] text-muted-foreground">Usage metrics and performance data</p>
        </div>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-28 h-8 text-xs" data-testid="select-days">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7" className="text-xs">Last 7 days</SelectItem>
            <SelectItem value="14" className="text-xs">Last 14 days</SelectItem>
            <SelectItem value="30" className="text-xs">Last 30 days</SelectItem>
            <SelectItem value="90" className="text-xs">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-refresh-analytics">
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading analytics...
          </div>
        </div>
      ) : isError ? (
        <div className="flex items-center justify-center flex-1">
          <div className="text-center space-y-2">
            <p className="text-sm text-destructive">Failed to load analytics</p>
            <p className="text-xs text-muted-foreground">{(error as Error)?.message || "Unknown error"}</p>
            <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-retry-analytics">
              <RefreshCw className="w-3.5 h-3.5 mr-1" /> Retry
            </Button>
          </div>
        </div>
      ) : (
        <ScrollArea className="flex-1 p-4">
          <div className="max-w-5xl mx-auto space-y-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <SummaryCard title="Events Today" value={summary.totalEventsToday.toLocaleString()} icon={TrendingUp} />
              <SummaryCard title="Tokens Today" value={summary.totalTokensToday >= 1000 ? `${(summary.totalTokensToday / 1000).toFixed(1)}K` : summary.totalTokensToday} icon={Zap} />
              <SummaryCard title="Avg Response" value={avgSec} icon={Clock} />
              <SummaryCard title="Active Models" value={summary.activeModels} icon={Brain} />
            </div>

            {/* Docker Status Card */}
            <Card>
              <CardContent className="py-3 px-4">
                <div className="flex items-center gap-3">
                  <Box className="w-4 h-4 text-primary" />
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${docker?.ready ? "bg-green-400" : "bg-muted-foreground"}`} />
                    <span className="text-xs font-mono">Docker: {docker?.ready ? "Connected" : "Unavailable"}</span>
                    {docker?.ready && (
                      <span className="text-xs text-muted-foreground">
                        — {docker.running} running / {docker.total} total containers
                      </span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Daily Usage Chart */}
            <Card>
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-xs font-mono text-primary">DAILY USAGE</CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-4">
                {dailyUsage.length === 0 ? (
                  <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">No data</div>
                ) : (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={dailyUsage} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickFormatter={v => v.slice(5)} />
                      <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} yAxisId="left" />
                      <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} yAxisId="right" orientation="right" />
                      <Tooltip content={<CustomTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Line yAxisId="left" type="monotone" dataKey="events" stroke={CHART_COLORS[0]} strokeWidth={2} dot={false} name="Events" />
                      <Line yAxisId="right" type="monotone" dataKey="tokens" stroke={CHART_COLORS[1]} strokeWidth={2} dot={false} name="Tokens" />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Tokens by Model */}
              <Card>
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-mono text-primary">TOKEN USAGE BY MODEL</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-4">
                  {tokensByModel.length === 0 ? (
                    <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">No data</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={180}>
                      <BarChart data={tokensByModel} layout="vertical" margin={{ top: 0, right: 20, left: 10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                        <YAxis dataKey="model" type="category" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} width={90} />
                        <Tooltip content={<CustomTooltip />} />
                        <Bar dataKey="tokens" name="Tokens" radius={[0, 3, 3, 0]}>
                          {tokensByModel.map((_, i) => (
                            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              {/* Task Type Distribution */}
              <Card>
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-mono text-primary">TASK TYPE DISTRIBUTION</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-4">
                  {taskDist.length === 0 ? (
                    <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">No data</div>
                  ) : (
                    <div className="flex items-center gap-4">
                      <ResponsiveContainer width="50%" height={160}>
                        <PieChart>
                          <Pie
                            data={taskDist}
                            dataKey="count"
                            nameKey="taskType"
                            cx="50%"
                            cy="50%"
                            innerRadius={40}
                            outerRadius={65}
                            paddingAngle={2}
                          >
                            {taskDist.map((entry, i) => (
                              <Cell key={i} fill={TASK_COLORS[entry.taskType] || CHART_COLORS[i % CHART_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip content={<CustomTooltip />} />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="flex-1 space-y-1.5">
                        {taskDist.map((entry, i) => {
                          const total = taskDist.reduce((s, e) => s + e.count, 0);
                          const pct = total ? ((entry.count / total) * 100).toFixed(0) : "0";
                          return (
                            <div key={i} className="flex items-center gap-2" data-testid={`task-dist-${entry.taskType}`}>
                              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: TASK_COLORS[entry.taskType] || CHART_COLORS[i % CHART_COLORS.length] }} />
                              <span className="text-[10px] flex-1">{entry.taskType}</span>
                              <span className="text-[10px] font-mono text-muted-foreground">{pct}%</span>
                              <span className="text-[10px] font-mono">{entry.count}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Avg Response by Model */}
            <Card>
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-xs font-mono text-primary">AVG RESPONSE TIME BY MODEL (ms)</CardTitle>
              </CardHeader>
              <CardContent className="px-2 pb-4">
                {avgResponse.length === 0 ? (
                  <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">No data</div>
                ) : (
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={avgResponse} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="model" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                      <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="avgMs" name="Avg ms" radius={[3, 3, 0, 0]}>
                        {avgResponse.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* ── TOKEN USAGE SECTION ─────────────────────────────── */}
            <div className="pt-2">
              <p className="text-[10px] font-mono text-primary uppercase tracking-widest mb-3 px-1">Token Usage</p>

              {/* Token In/Out over time — stacked area chart */}
              <Card className="mb-4">
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-mono text-primary">TOKENS IN / OUT OVER TIME</CardTitle>
                </CardHeader>
                <CardContent className="px-2 pb-4" data-testid="token-split-chart">
                  {dailyUsage.length === 0 ? (
                    <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">No data</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={dailyUsage} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                        <defs>
                          <linearGradient id="colorIn" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={CHART_COLORS[0]} stopOpacity={0.25} />
                            <stop offset="95%" stopColor={CHART_COLORS[0]} stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="colorOut" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={CHART_COLORS[1]} stopOpacity={0.25} />
                            <stop offset="95%" stopColor={CHART_COLORS[1]} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="date" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickFormatter={v => v.slice(5)} />
                        <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Area
                          type="monotone"
                          dataKey="tokensIn"
                          name="Tokens In"
                          stroke={CHART_COLORS[0]}
                          strokeWidth={2}
                          fill="url(#colorIn)"
                          dot={false}
                        />
                        <Area
                          type="monotone"
                          dataKey="tokensOut"
                          name="Tokens Out"
                          stroke={CHART_COLORS[1]}
                          strokeWidth={2}
                          fill="url(#colorOut)"
                          dot={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              {/* Efficiency + Compute stat cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4" data-testid="efficiency-metrics">
                <SummaryCard
                  title="Compute Hours"
                  value={efficiency ? efficiency.totalComputeHours >= 1
                    ? `${efficiency.totalComputeHours.toFixed(2)}h`
                    : `${(efficiency.totalComputeHours * 60).toFixed(1)}m`
                    : "—"}
                  sub="Total inference time"
                  icon={Timer}
                />
                <SummaryCard
                  title="Success Rate"
                  value={efficiency ? `${efficiency.successRate}%` : "—"}
                  sub="Events succeeded"
                  icon={CheckCircle2}
                />
                <SummaryCard
                  title="Tokens / Conv"
                  value={efficiency ? (efficiency.tokensPerConversation >= 1000
                    ? `${(efficiency.tokensPerConversation / 1000).toFixed(1)}K`
                    : efficiency.tokensPerConversation) : "—"}
                  sub="Avg per conversation"
                  icon={Cpu}
                />
                <SummaryCard
                  title="Tokens / Tool Call"
                  value={efficiency ? (efficiency.tokensPerToolCall >= 1000
                    ? `${(efficiency.tokensPerToolCall / 1000).toFixed(1)}K`
                    : efficiency.tokensPerToolCall || "—") : "—"}
                  sub="Avg per tool call"
                  icon={Zap}
                />
              </div>

              {/* Tokens In vs Out totals mini-cards */}
              {efficiency && (
                <div className="grid grid-cols-2 gap-3 mb-4" data-testid="token-totals">
                  <Card>
                    <CardContent className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <ArrowDownToLine className="w-4 h-4 shrink-0" style={{ color: CHART_COLORS[0] }} />
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Total Tokens In</p>
                          <p className="text-lg font-mono font-bold" data-testid="total-tokens-in">
                            {efficiency.totalTokensIn >= 1000000
                              ? `${(efficiency.totalTokensIn / 1000000).toFixed(2)}M`
                              : efficiency.totalTokensIn >= 1000
                              ? `${(efficiency.totalTokensIn / 1000).toFixed(1)}K`
                              : efficiency.totalTokensIn}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <ArrowUpFromLine className="w-4 h-4 shrink-0" style={{ color: CHART_COLORS[1] }} />
                        <div>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Total Tokens Out</p>
                          <p className="text-lg font-mono font-bold" data-testid="total-tokens-out">
                            {efficiency.totalTokensOut >= 1000000
                              ? `${(efficiency.totalTokensOut / 1000000).toFixed(2)}M`
                              : efficiency.totalTokensOut >= 1000
                              ? `${(efficiency.totalTokensOut / 1000).toFixed(1)}K`
                              : efficiency.totalTokensOut}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}

              {/* Per-conversation token totals table */}
              <Card>
                <CardHeader className="pb-2 pt-3 px-4">
                  <CardTitle className="text-xs font-mono text-primary">TOKEN USAGE BY CONVERSATION</CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-4" data-testid="conversation-token-table">
                  {convTokenRows.length === 0 ? (
                    <div className="h-24 flex items-center justify-center text-xs text-muted-foreground">No conversation data</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-[11px]" data-testid="conv-token-table-inner">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="text-left py-1.5 font-mono text-muted-foreground font-normal pr-4">Conversation</th>
                            <th className="text-right py-1.5 font-mono text-muted-foreground font-normal pr-4">Tokens In</th>
                            <th className="text-right py-1.5 font-mono text-muted-foreground font-normal pr-4">Tokens Out</th>
                            <th className="text-right py-1.5 font-mono text-muted-foreground font-normal pr-4">Total</th>
                            <th className="text-left py-1.5 font-mono text-muted-foreground font-normal pr-4">Model</th>
                            <th className="text-right py-1.5 font-mono text-muted-foreground font-normal">Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {convTokenRows.map((row, i) => (
                            <tr
                              key={i}
                              className="border-b border-border/40 hover:bg-muted/30 transition-colors"
                              data-testid={`conv-token-row-${i}`}
                            >
                              <td className="py-1.5 pr-4 max-w-[180px] truncate font-medium">
                                {row.title || "(no title)"}
                              </td>
                              <td className="py-1.5 pr-4 text-right font-mono" style={{ color: CHART_COLORS[0] }}>
                                {row.totalIn.toLocaleString()}
                              </td>
                              <td className="py-1.5 pr-4 text-right font-mono" style={{ color: CHART_COLORS[1] }}>
                                {row.totalOut.toLocaleString()}
                              </td>
                              <td className="py-1.5 pr-4 text-right font-mono text-foreground font-bold">
                                {(row.totalIn + row.totalOut).toLocaleString()}
                              </td>
                              <td className="py-1.5 pr-4 text-muted-foreground truncate max-w-[120px]">
                                {row.modelId ? truncateModel(row.modelId) : "—"}
                              </td>
                              <td className="py-1.5 text-right text-muted-foreground font-mono">
                                {row.date}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
