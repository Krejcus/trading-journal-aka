
export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
}

export interface SocialConnection {
  id: string;
  sender_id: string;
  receiver_id: string;
  status: 'pending' | 'accepted';
  created_at: string;
  sender?: User;
  receiver?: User;
}

export interface UserSearch {
  id: string;
  email: string;
  full_name: string;
}

export interface IronRule {
  id: string;
  label: string;
  type: 'ritual' | 'trading';
  description?: string;
}

export interface RuleCompletion {
  ruleId: string;
  status: 'Pass' | 'Fail' | 'Pending';
  comment?: string;
}

export interface Account {
  id: string;
  name: string;
  initialBalance: number;
  challengeCost?: number;
  profitSplit?: number;
  totalGrossWithdrawals?: number;
  totalWithdrawals?: number;
  phase?: 'Challenge' | 'Funded';
  accumulatedChallengePnL?: number;
  type: 'Live' | 'Paper' | 'Backtest' | 'Funded';
  status: 'Active' | 'Inactive';
  currency: string;
  createdAt: number;
}

export interface TradeFilters {
  days: string[];
  hours: number[];
  accounts: string[];
  directions: ('Long' | 'Short')[];
  outcomes: ('Win' | 'Loss' | 'BE' | 'Missed')[];
  period: 'all' | 'week' | 'month' | 'quarter' | 'year';
  signals: string[];
  executionStatuses: ('Valid' | 'Invalid' | 'Missed')[];
  htfConfluences: string[];
  ltfConfluences: string[];
  mistakes: string[];
}

export interface Trade {
  id: number | string;
  accountId: string;
  instrument?: string;
  signal: string;
  pnl: number;
  riskAmount?: number;
  targetAmount?: number;
  riskPercent?: number;
  profitPercent?: number;
  pnlPercentage?: number;
  runUp: number;
  drawdown: number;
  date: string;
  timestamp: number;
  duration: string;
  durationMinutes: number;
  direction: 'Long' | 'Short';
  screenshot?: string;
  screenshots?: string[];
  notes?: string;
  entryPrice?: number;
  exitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  positionSize?: number;
  emotions?: string[];
  mistakes?: string[];
  planAdherence?: 'Yes' | 'No' | 'Partial';
  isValid?: boolean;
  executionStatus?: 'Valid' | 'Invalid' | 'Missed';
  tags?: string[];
  session?: string;
  htfConfluence?: string[];
  ltfConfluence?: string[];
}

export interface SignalStat {
  signalName: string;
  count: number;
  winRate: number;
  totalPnL: number;
  avgPnL: number;
}

export interface TimeStat {
  label: string;
  pnl: number;
  profit: number;
  loss: number;
  winRate: number;
  trades: number;
}

export interface CalendarDay {
  date: string;
  pnl: number;
  trades: number;
}

export interface MonthlyData {
  year: number;
  months: Record<number, { pnl: number; gainPct: number; accumGainPct: number }>;
  yearlyPnl: number;
  yearlyGainPct: number;
}

export interface EquityPoint {
  date: string;
  equity: number;
  validEquity: number;
  drawdown: number;
}

export interface TradeStats {
  initialBalance: number;
  totalPnL: number;
  winRate: number;
  executionRate: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  bestWinPct: number;
  worstLossPct: number;
  avgWinPct: number;
  avgLossPct: number;
  avgRR: number;
  maxDrawdown: number;
  currentDrawdownPct: number;
  avgRisk: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  missedTrades: number;
  winningDays: number;
  losingDays: number;
  breakEvenDays: number;
  dayWinRate: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgConsecutiveWins: number;
  avgConsecutiveLosses: number;
  avgDurationWin: number;
  avgDurationLoss: number;
  zScore: number;
  sharpeRatio: number;
  sortinoRatio: number;
  sqn: number;
  kellyCriterion: number;
  profitPerHour: number;
  signals: SignalStat[];
  equityCurve: EquityPoint[];
  dayStats: TimeStat[];
  hourStats: TimeStat[];
  longStats: { count: number; pnl: number; wins: number; winRate: number };
  shortStats: { count: number; pnl: number; wins: number; winRate: number };
  calendarData: CalendarDay[];
  monthlyBreakdown: MonthlyData[];
  trades: Trade[];
}

export interface DailyPrep {
  id: string;
  date: string;
  scenarios: {
    bullish: string;
    bearish: string;
    bullishImage?: string;
    bearishImage?: string;
  };
  goals: string[];
  checklist: {
    sleptWell: boolean;
    planReady: boolean;
    disciplineCommitted: boolean;
    newsChecked: boolean;
  };
  ritualCompletions?: RuleCompletion[];
  mindsetState: string;
  confidence: number;
}

export interface GoalResult {
  text: string;
  achieved: boolean;
}

export interface DailyReview {
  id: string;
  date: string;
  mainTakeaway: string;
  mistakes: string[];
  lessons: string;
  rating: number;
  goalResults?: GoalResult[];
  scenarioResult?: 'Bullish' | 'Bearish' | 'Range' | 'Unpredicted';
  ruleAdherence?: RuleCompletion[];
}

export interface WeeklyReview {
  id: string;
  year: number;
  weekNumber: number;
  mainTakeaway: string;
  repeatOffender: string;
  mistakeCost: number;
  disciplineScore: number;
  weekendCommitment: string;
  topInstrument: string;
  worstInstrument: string;
  achievements: string[];
}

export interface MonthlyReview {
  id: string;
  year: number;
  month: number;
  strategyVerdict: string;
  totalMistakeCost: number;
  marketEdgeAnalysis: string;
  progressLevel: 'Gambler' | 'Apprentice' | 'Trader' | 'Elite';
  emotionalHeatmap: Record<string, string>;
  goalsForNextMonth: string[];
}

export interface BusinessExpense {
  id: string;
  date: string;
  label: string;
  amount: number;
  category: 'Subscription' | 'Data' | 'Software' | 'Education' | 'Hardware' | 'Office' | 'Other';
  recurring?: 'monthly' | 'yearly';
}

export interface BusinessPayout {
  id: string;
  date: string;
  amount: number;
  accountId: string;
  status: 'Pending' | 'Received';
  notes?: string;
}

export interface PlaybookItem {
  id: string;
  name: string;
  description: string;
  image?: string;
  additionalImages?: string[];
  rules: string[];
  type: 'Setup' | 'Pattern' | 'Concept';
  rating: number; // 1-5 stars
}

export interface CustomEmotion {
  id: string;
  label: string;
  icon: string;
}

export interface DashboardWidgetConfig {
  id: string;
  label: string;
  visible: boolean;
  size: 'small' | 'large' | 'full';
  order: number;
  showDisciplinedCurve?: boolean;
}

export interface SessionConfig {
  id: string;
  name: string;
  startTime: string; // "HH:mm"
  endTime: string;   // "HH:mm"
  color: string;
}

export interface UserPreferences {
  emotions: CustomEmotion[];
  standardGoals: string[];
  standardMistakes?: string[];
  dashboardLayout?: DashboardWidgetConfig[];
  sessions?: SessionConfig[];
  htfOptions?: string[];
  ltfOptions?: string[];
  ironRules?: IronRule[];
  instrumentFees?: Record<string, number>;
  businessExpenses?: BusinessExpense[];
  businessPayouts?: BusinessPayout[];
  playbookItems?: PlaybookItem[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface SharedLinkConfig {
  id: string;
  name: string;
  created: number;
  expires?: number;
  active: boolean;
  permissions: {
    maskPnL: boolean;
    hideBalance: boolean;
    hideJournal: boolean;
    hideEmotions: boolean;
    hideExactTimes: boolean;
    hideTickers: boolean;
    hideTags: boolean;
    accounts: string[];
  };
  views: number;
}
