"use client";


import EquityCurve from "@/components/EquityCurve";
import TradingCalendar from "@/components/TradingCalendar";
import DashboardGrid from "@/components/DashboardGrid";
import { BalanceWidget, PnlWidget, WinRateWidget } from "@/components/StatsCards";
import RecentTrades from "@/components/RecentTrades";
import QuickStats from "@/components/QuickStats";
import DashboardWidget from "@/components/DashboardWidget";
import DashboardLayout from "@/components/DashboardLayout";

export default function Home() {
  return (
    <DashboardLayout>
      <div className="p-8 pb-0">
        <h1 className="text-3xl font-bold text-white">Vítej zpět, Filipe! 👋</h1>
        <p className="text-slate-400 mt-1">Zde je přehled tvého obchodního účtu pro dnešní den.</p>
      </div>

      <DashboardGrid>
        <div key="balance">
          <DashboardWidget className="bg-slate-900 border border-slate-800 rounded-xl">
            <BalanceWidget />
          </DashboardWidget>
        </div>
        <div key="pnl">
          <DashboardWidget className="bg-slate-900 border border-slate-800 rounded-xl">
            <PnlWidget />
          </DashboardWidget>
        </div>
        <div key="winrate">
          <DashboardWidget className="bg-slate-900 border border-slate-800 rounded-xl">
            <WinRateWidget />
          </DashboardWidget>
        </div>

        <div key="equity">
          <DashboardWidget title="Vývoj Kapitálu (Equity)" className="bg-slate-900 border border-slate-800 rounded-xl">
            <EquityCurve />
          </DashboardWidget>
        </div>

        <div key="calendar">
          <DashboardWidget title="Kalendář" className="bg-slate-900 border border-slate-800 rounded-xl">
            <div className="h-full overflow-auto">
              <TradingCalendar />
            </div>
          </DashboardWidget>
        </div>

        <div key="trades">
          <DashboardWidget title="Poslední Obchody" className="bg-slate-900 border border-slate-800 rounded-xl" headerAction={<button className="text-sm text-blue-400 hover:text-blue-300 font-medium">Zobrazit Vše</button>}>
            <div className="h-full overflow-auto -mx-6">
              <RecentTrades />
            </div>
          </DashboardWidget>
        </div>

        <div key="quick-stats">
          <DashboardWidget title="Rychlý Přehled" className="bg-slate-900 border border-slate-800 rounded-xl">
            <div className="space-y-4 p-4 pt-0">
              <div className="flex justify-between items-center">
                <span className="text-slate-300">Avg R:R</span>
                <span className="text-white font-mono">1:2.5</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-300">Profit Factor</span>
                <span className="text-emerald-400 font-mono">2.1</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-slate-300">Max Drawdown</span>
                <span className="text-rose-400 font-mono">-1.2%</span>
              </div>
            </div>
          </DashboardWidget>
        </div>


      </DashboardGrid>
    </DashboardLayout>
  );
}
