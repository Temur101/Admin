import { apiRequest } from "./client.js";

export interface DashboardMetrics {
  mrrUzs: number;
  cashCollectedThisMonthUzs: number;
  cashCollectedTotalUzs: number;
  activePayingBots: number;
  trialBots: number;
  totalBots: number;
  pendingReceiptsCount: number;
  expiringIn3DaysCount: number;
  totalLeadsCount: number;
  totalBookingsCount: number;
  inboxErrors24hCount: number;
  botsBreakdown: Array<{
    id: string;
    botUsername: string | null;
    botType: "LEADCATCH" | "QUICKBOOK";
    tenantName: string;
    leadsCount: number;
    bookingsCount: number;
    status: string;
  }>;
}

export async function getDashboardMetrics(): Promise<DashboardMetrics> {
  const data = await apiRequest<{ ok: true; metrics: DashboardMetrics }>("/api/v1/analytics/dashboard");
  return data.metrics;
}
