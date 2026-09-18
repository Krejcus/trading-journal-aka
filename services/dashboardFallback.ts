export const dashboardTradeFields = [
  'setup', 'mistake', 'notes', 'tags', 'runUp', 'drawdown', 'riskAmount', 'targetAmount',
  'entryPrice', 'exitPrice', 'stopLoss', 'takeProfit', 'quantity', 'signal', 'session',
  'backtestRunId', 'confidence', 'rr', 'duration', 'durationMinutes', 'isValid', 'groupId',
  'phase', 'htfConfluence', 'ltfConfluence', 'autoConfluence', 'mistakes', 'emotions',
  'planAdherence', 'executionStatus', 'needsReview', 'exitReason', 'copierTradeId',
  'copierEpisodeId', 'copierSnapshots', 'journalSupersededBy', 'pnlEstimated', 'setupType', 'miniViewRange',
  'miniViewLayout', 'miniViewSecondaryRange', 'miniViewSecondaryTimeframe',
  'positionSize', 'isMaster', 'masterTradeId', 'entryTime', 'entryDate',
  'source', 'tsOrderIds', 'isBE', 'exitDate', 'mfeR', 'maeR', 'mfePoints', 'maePoints',
  'excursionAvailable', 'excursionComplete', 'executionPathComplete',
  'outcomeAmbiguous', 'excursionAmbiguous', 'slPlacement', 'targetType', 'targetLevel',
  'management', 'sessionBias', 'sessionPreNotes', 'sessionPostNotes', 'biasAligned',
  'schemaVersion',
];

/** Fields the light dashboard read defers (see lib/tradeAnalyticsMerge). */
export const deferredDashboardTradeFields = [
  'counterfactual', 'excursion', 'entryMap', 'entryContext', 'aiSuggestions', 'executionPath', 'visionAnalysis',
] as const;

/** PostgREST caps a page at 1 000 rows; 500 keeps a page under a few hundred kB and halves the round trips of 100. */
export const DASHBOARD_PAGE_SIZE = 500;

export const dashboardTables = {
  profiles: 'id,email,full_name,avatar_url,role,preferences',
  accounts: '*',
  trades: ['id,user_id,account_id,instrument,pnl,direction,date,timestamp,is_public,created_at',
    ...dashboardTradeFields.map(field => `${field}:data->${field}`),
    'screenshot_url:data->screenshot', 'screenshots_urls:data->screenshots'].join(','),
  daily_preps: 'id,date,data',
  daily_reviews: 'id,date,data',
  weekly_focus: 'id,week_iso,goals',
};

export type DashboardTable = keyof typeof dashboardTables;
export type DashboardRawRow = Record<string, unknown>;

export async function loadDashboardFallback(
  readPage: (table: DashboardTable, offset: number, limit: number) => Promise<DashboardRawRow[]>,
) {
  const readAll = async (table: DashboardTable) => {
    const rows: DashboardRawRow[] = [];
    for (let offset = 0; ; offset += DASHBOARD_PAGE_SIZE) {
      const page = await readPage(table, offset, DASHBOARD_PAGE_SIZE);
      rows.push(...page);
      if (page.length < DASHBOARD_PAGE_SIZE) return rows;
    }
  };
  const [profiles, accounts, trades, preps, reviews, weeklyFocus] = await Promise.all(
    (Object.keys(dashboardTables) as DashboardTable[]).map(readAll),
  );
  if (profiles.length !== 1) throw new Error('dashboard-profile-unavailable');
  return {
    user: profiles[0], preferences: profiles[0].preferences || null, accounts,
    trades: trades.map(row => ({
      ...row,
      data: Object.fromEntries(dashboardTradeFields.map(field => [field, row[field]])),
    })),
    daily_preps: preps, daily_reviews: reviews, weekly_focus: weeklyFocus,
  };
}
