// Local type definition to avoid dependency on lightweight-charts if not installed
export type ChartTime = number | string | { year: number; month: number; day: number };

export interface DrawingObject {
  id: string;
  type: 'line' | 'rect' | 'text' | 'fib' | 'horizontal';
  p1: { time: number | ChartTime; price: number };
  p2?: { time: number | ChartTime; price: number };
  text?: string;
  color?: string;
  lineWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  opacity?: number; // Line opacity (0-100)
  // Text settings
  textColor?: string;
  textSize?: 'S' | 'M' | 'L';
  textBold?: boolean;
  textItalic?: boolean;
  textVAlign?: 'top' | 'middle' | 'bottom';
  textHAlign?: 'left' | 'center' | 'right';
  // Border settings (for rect)
  borderColor?: string;
  borderOpacity?: number;
  // Fill settings (for rect)
  fillColor?: string;
  fillOpacity?: number;
  // Fibonacci
  fibLevels?: { value: number; active: boolean; color?: string; opacity?: number }[];
  extendLines?: boolean;
  showPrices?: boolean;
  showTrendline?: boolean;
  visibleTimeframes?: string[];
}

export interface DrawingTemplate {
  id: string;
  name: string;
  type: 'line' | 'rect' | 'horizontal' | 'fib';
  styles: {
    color?: string;
    lineWidth?: number;
    lineStyle?: 'solid' | 'dashed' | 'dotted';
    opacity?: number;
    borderColor?: string;
    borderOpacity?: number;
    fillColor?: string;
    fillOpacity?: number;
    textColor?: string;
    textSize?: 'S' | 'M' | 'L';
    textBold?: boolean;
    textItalic?: boolean;
    textVAlign?: 'top' | 'middle' | 'bottom';
    textHAlign?: 'left' | 'center' | 'right';
    extendLines?: boolean;
    fibLevels?: { value: number; active: boolean; color?: string; opacity?: number }[];
    showPrices?: boolean;
    showTrendline?: boolean;
  };
}

export type UserRole = 'owner' | 'friend';

export interface User {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  language?: 'cs' | 'en';
  currency?: 'USD' | 'CZK' | 'EUR';
  timezone?: string;
  preferences?: Record<string, any>; // extended preferences (networkNotifications etc.)
  role?: UserRole; // 'owner' = full access, 'friend' = limited, 'user' = default
}

export interface SocialConnection {
  id: string;
  sender_id: string;
  receiver_id: string;
  status: 'pending' | 'accepted';
  created_at: string;
  sender?: User;
  receiver?: User;
  permissions?: {
    canSeePnl: boolean;
    pnlFormat?: 'usd' | 'rr' | 'hidden';
    canSeePrep?: boolean;
    canSeePrepRituals?: boolean;
    canSeeReviewStats?: boolean;
    canSeeReviewNotes?: boolean; // Replaces 'canSeeNotes' logic
    canSeeNotes?: boolean; // Made optional for backward compatibility
    canSeeScreenshots: boolean;
    allowedAccountIds?: string[]; // Which accounts follower can see (empty/undefined = all)
    notifications?: {
      newTrade: boolean;
      newPrep: boolean;
      newReview: boolean;
    };
  };
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
  isActive?: boolean;
}

export interface RuleCompletion {
  ruleId: string;
  status: 'Pass' | 'Fail' | 'Pending';
  label?: string;
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
  status: 'Active' | 'Inactive' | 'Archived';
  currency: string;
  createdAt: number;
  profitTarget?: number;
  propThreshold?: number; // Minimum PnL to count as "profitable day"
  parentAccountId?: string; // ID of the account this account copies
  /** Násobek risku/velikosti při AlphaBridge fan-outu (celé číslo, default 1).
   *  Např. challenge účet s 2× riskem = 2. Master/základ = 1. */
  copyMultiplier?: number;
  isArchived?: boolean;
  archivedAt?: number;
  result?: 'Passed' | 'Failed';
  instrumentFees?: Record<string, number>;
  // Account Funeral metadata (vyplněné v AccountFuneralModal při markování jako Failed)
  failureReason?: string;
  failureDate?: string;
  failureWhatHappened?: string;
  failureAmountLost?: number;
  failureProgressPct?: number;
  failureDaysOfConsistency?: number;
  failureKeyLesson?: string;
}

export type PnLDisplayMode = 'usd' | 'percent' | 'rr';

export type DashboardMode = 'funded' | 'challenge' | 'combined' | 'archive' | 'backtesting';

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
  time?: string;      // Added for AI context
  symbol?: string;    // Added for AI context
  direction: 'Long' | 'Short';
  outcome?: 'Win' | 'Loss' | 'BE'; // Added for AI context
  /** Manual override — i když pnl ≠ 0, počítá se jako BE ve statistikách.
   *  Použij pro obchody co byly fakticky BE ale fees / slippage daly +/-$10. */
  isBE?: boolean;
  timestamp: number;
  duration: string;
  durationMinutes: number;
  entryTime?: number;
  entryDate?: string;
  /** Datum výstupu (YYYY-MM-DD) — u vícedenních obchodů se liší od entryDate. */
  exitDate?: string;
  screenshot?: string;
  screenshots?: string[];
  notes?: string;
  shareNotes?: boolean; // Při sdílení veřejného linku: smí se zobrazit poznámka? (default false)
  drawings?: DrawingObject[]; // Array of drawing objects (lines, rects, text, fib, etc.)
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
  groupId?: string;
  isMaster?: boolean; // If this is the source trade for a copy group
  masterTradeId?: string | number; // ID of the master trade if this is a copy
  phase?: 'Challenge' | 'Funded';
  accountCount?: number; // How many accounts this trade was copied to (social feed dedup)
  miniViewRange?: { from: number; to: number };
  miniViewLayout?: 'single' | 'split';
  miniViewSecondaryRange?: { from: number; to: number };
  miniViewSecondaryTimeframe?: '1m' | '5m' | '15m' | '1h' | '4h' | 'D' | 'W';
  /** User manuálně označil import-trade jako "doplněno" (bulk-tag flow, nemá smysl
   *  k němu cokoli dál přidávat — typicky revenge/overtrading session). Odebere
   *  obchod z "K doplnění" fronty i bez screenshotu/konfluence. */
  enrichmentSkipped?: boolean;
  /** AI návrhy tagů vygenerované Edge Function `enrich-trade` po save obchodu. */
  aiSuggestions?: {
    htf?: Array<{ value: string; reasoning: string }>;
    ltf?: Array<{ value: string; reasoning: string }>;
    mistakes?: Array<{ value: string; reasoning: string }>;
    emotions?: Array<{ value: string; reasoning: string }>;
    summary?: string;
    generatedAt?: string;
    unreviewed?: boolean;
  };
  /** Vision debrief — Claude-vision rozbor grafu (analyze-chart edge function). */
  visionAnalysis?: {
    verdict: string;
    observations: string[];
    lesson: string;
    confidence: 'high' | 'medium' | 'low';
    generatedAt: string;
  };

  // ── AlphaBridge rich intel — počítá extension z grafu, ukládá do data blobu. ──
  // Historicky se tato pole ukládala do DB, ale read-path (getTrades/getDashboardData)
  // je zahazoval → v UI neviditelná. Teď se načítají, ať je vidí TradeDetailModal i analytika.
  /** Max Favorable Excursion v R (kam až cena došla ve prospěch). */
  mfeR?: number;
  /** Max Adverse Excursion v R (kam až proti pozici). */
  maeR?: number;
  mfePoints?: number;
  maePoints?: number;
  /** false = MFE/MAE se nepodařilo z grafu načíst (ne že jsou 0). */
  excursionAvailable?: boolean;
  /** true = SL i TP v jednom baru (auto-výsledek nejistý, default LOSS). */
  outcomeAmbiguous?: boolean;
  /** Kam reálně dal SL: fvg | swing | ote | other. */
  slPlacement?: string;
  /** Kam cílil TP: deviation | daily | fixed_rr | liquidity | other. */
  targetType?: string;
  /** Konkrétní detekovaný TP level (např. "PDH", "VWAP +1σ"). */
  targetLevel?: string;
  /** Řízení pozice: trail_bos | fixed | partial_runner | be_runner. */
  management?: string;
  /** "Co kdyby" pro 3 SL placementy (swing/ote/fvg) + tpTargets. */
  counterfactual?: any;
  /** Kam by to došlo do konce dne (mfePotentialR, leftOnTableR, levels[], trail). */
  excursion?: any;
  /** false = excursion sken narazil na konec barů (den nedojel) → „pending", dopočítá se později.
   *  true = úplné (dojelo k flat-by nebo SL). null/undefined = žádná excursion (manuál/špatný SL). */
  excursionComplete?: boolean | null;
  /** Entry model — structureType/order, odrazLevels, entryFvg. */
  entryMap?: any;
  /** Kontext vstupu (snapshot z AlphaBridge): kotvy DO/WO/pdVWAP/VWAP, sweepy, magnet mapa, Londýn vs Asie. */
  entryContext?: any;
  /** Backtest session kontext otisknutý do obchodu (per účet). */
  sessionBias?: 'Long' | 'Short' | 'Neutral' | null;
  sessionPreNotes?: string | null;
  sessionPostNotes?: string | null;
  /** true = obchod ve směru session biasu, false = proti, null = Neutral/nezadáno. */
  biasAligned?: boolean | null;
  /** Verze schématu data blobu (AlphaBridge zápis). */
  schemaVersion?: number;
  /** Zdroj obchodu: 'alphabridge' | 'tradesyncer' | 'tradovate' | manuál. */
  source?: string;
  /** Provenance pro import dedup (Tradesyncer). */
  tsOrderIds?: string[];
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
  trade?: {
    id: string | number;
    instrument: string;
    direction: string;
    pnl: number;
    screenshot?: string;
  };
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
  currentDayStreak: number;
  maxWinningDayStreak: number;
  maxLosingDayStreak: number;
  currentTradeStreak: number;
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

export interface SessionAnalysis {
  id: string; // e.g. "london", "ny", or a UUID
  label: string;
  image?: string;
  plan: string;
  color?: string;
  bias?: 'Bullish' | 'Neutral' | 'Bearish';
}

export interface DailyPrep {
  id: string;
  date: string;
  bias?: string; // Overall market bias (bullish/bearish/neutral)
  scenarios: {
    bullish: string; // Legacy
    bearish: string; // Legacy
    scenarioImages?: string[]; // Legacy way
    bullishImage?: string; // Legacy
    bearishImage?: string; // Legacy
    sessions?: SessionAnalysis[]; // New way: bento cards per session
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
  /** Confidence level (0-100) */
  confidence: number;
  completed?: boolean;
  /** Hlavní fokus dne (volně psaný) — používá DailyJournal/DailyFocusWidget. */
  dailyFocus?: string;
}

export interface GoalResult {
  text: string;
  achieved: boolean;
}

export interface PsychoState {
  stressors: string;
  gratitude: string;
  notes: string;
}

export interface SessionBreakdown {
  sessionId: string;
  sessionLabel: string;
  notes: string;
  screenshot?: string;
}

export interface QuickNote {
  id: string;
  timestamp: number;
  text: string;
}

export interface DailyReview {
  id: string;
  date: string;
  mainTakeaway: string;
  mistakes: string[];
  lessons: string;
  /** Day rating (1-5 stars) */
  rating: number;
  goalResults?: GoalResult[];
  scenarioResult?: 'Bullish' | 'Bearish' | 'Range' | 'Unpredicted';
  ruleAdherence?: RuleCompletion[];
  weeklyGoalAdherence?: RuleCompletion[];
  psycho?: PsychoState;
  sessionBreakdowns?: SessionBreakdown[];
  completed?: boolean;
  /** Free-form myšlenky během dne (timestamp + text). Přidáváno přes FAB v V2 Deníku. */
  quickNotes?: QuickNote[];
  /** Auto-debrief flag pro loss day debrief modal. */
  autoDebrief?: boolean;
}

export interface WeeklyGoal {
  id: string;
  text: string;
  emoji?: string;
}

export interface WeeklyFocus {
  id: string;
  weekISO: string; // e.g. "2026-W02"
  goals: WeeklyGoal[];
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
  user_id?: string;
  date: string;
  label: string;
  description?: string;
  amount: number;
  category: string;
  recurring?: 'monthly' | 'yearly' | 'one-time';
  receipt_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface BusinessPayout {
  id: string;
  user_id?: string;
  date: string;
  amount: number;
  grossAmount?: number;
  profitSplitUsed?: number;
  accountId?: string;
  description?: string;
  notes?: string;
  image?: string;
  status?: 'Received' | 'Pending';
  payout_method?: string;
  created_at?: string;
  updated_at?: string;
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

export interface BusinessGoal {
  id: string;
  user_id?: string;
  title?: string;
  description?: string;
  target_amount?: number;
  deadline?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  // Fields used by BusinessHub component
  type?: string;
  metric?: string;
  label?: string;
  target?: number;
  current?: number;
  category?: string;
  logs?: Array<{ date: string; value?: number; amount?: number; note?: string }>;
}

/** Lab experiment — uzavřená smyčka „leak → změna pravidla → měření efektu".
 *  Obchody PŘED startTs = baseline, PO startTs = běh experimentu; po targetTrades
 *  obchodech Lab nabídne vyhodnocení. Čísla počítá labAnalytics (deterministicky). */
export interface LabExperiment {
    id: string;
    createdAt: number;
    world: 'live' | 'backtest';
    /** Krátký název, např. „Neobchoduji London". */
    title: string;
    /** Co očekávám, že se stane. */
    hypothesis: string;
    /** Konkrétní pravidlo, které od startu dodržuji. */
    rule: string;
    /** ID leak detektoru, ze kterého experiment vznikl (volitelné). */
    sourceLeakId?: string;
    /** Po kolika obchodech vyhodnotit. */
    targetTrades: number;
    /** Obchody s ts >= startTs se počítají do běhu experimentu. */
    startTs: number;
    status: 'running' | 'evaluated' | 'cancelled';
    /** Závěr po vyhodnocení (předvyplní deterministický verdikt, jde přepsat). */
    conclusion?: string;
    evaluatedAt?: number;
}

export interface ConstitutionRule {
  id: string;
  label: string;
  description?: string;
  type: 'daily_loss' | 'daily_trades' | 'weekly_loss' | 'absolute_dd' | 'custom' | 'habit';
  value: number;
  unit: '%' | 'trades' | 'fixed' | 'binary';
  action: 'stop_trading' | 'warning' | 'reset' | 'coaching';
  penaltyDays?: number;
  isActive: boolean;
}

export interface CareerCheckpoint {
  id: string;
  label: string;
  dayTarget: number;
  description: string;
  criteria: {
    label: string;
    metric: 'dd' | 'risk_adherence' | 'psych_score' | 'pnl';
    condition: '<' | '>' | '==';
    targetValue: number;
  }[];
  rules: ConstitutionRule[];
  status: 'locked' | 'active' | 'completed';
}


export interface BusinessResource {
  id: string;
  user_id: string;
  title: string;
  url?: string;
  description?: string;
  category?: string;
  created_at?: string;
  updated_at?: string;
}

export interface BusinessSettings {
  taxRatePct: number;
  defaultPropThreshold: number;
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
  // react-grid-layout position
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  // Legacy (for migration from old format)
  size?: 'small' | 'medium' | 'large' | 'full';
  rowSpan?: number;
  order?: number;
  // Widget metadata
  showDisciplinedCurve?: boolean;
}

/** Per-breakpoint layout storage. Keys: 'lg' (12 cols, notebook), 'xxl' (24 cols, ultrawide). */
export type DashboardLayouts = Record<string, DashboardWidgetConfig[]>;

export interface SessionConfig {
  id: string;
  name: string;
  startTime: string; // "HH:mm"
  endTime: string;   // "HH:mm"
  color: string;
}

export type AccentColor = 'blue' | 'purple' | 'pink' | 'green' | 'orange' | 'red' | 'cyan';

export interface UserPreferences {
  emotions: CustomEmotion[];
  standardGoals: string[];
  standardMistakes?: string[];
  dashboardLayout?: DashboardWidgetConfig[]; // Legacy — flat array (pre-migration)
  dashboardLayouts?: DashboardLayouts; // Legacy/sdílený — per-breakpoint layout (pre per-mód)
  liveLayoutsByMode?: Record<string, DashboardLayouts>; // New — layout zvlášť per dashboard mód (funded/challenge/combined)
  backtestDashboardLayouts?: DashboardLayouts; // Separátní layout pro backtest svět
  defaultRisk?: number; // % of account
  defaultStopLoss?: number; // ticks
  soundEnabled?: boolean;
  sessionTimeframe?: 'London' | 'NY' | 'Asia';
  dashboardMode?: 'combined' | 'funded' | 'challenge' | 'archive';

  sessions?: SessionConfig[];
  /** Samostatná sada obchodních sessionů pro BACKTEST svět (např. testuju Londýn,
   *  ale live obchoduju hlavně NY). Když je prázdné/nenastavené, backtest použije `sessions`. */
  backtestSessions?: SessionConfig[];
  htfOptions?: string[];
  ltfOptions?: string[];
  ironRules?: IronRule[];
  instrumentFees?: Record<string, number>;
  businessExpenses?: BusinessExpense[];
  businessPayouts?: BusinessPayout[];
  playbookItems?: PlaybookItem[];
  businessGoals?: BusinessGoal[];
  businessResources?: BusinessResource[];
  businessSettings?: BusinessSettings;
  constitutionRules?: ConstitutionRule[];
  careerRoadmap?: CareerCheckpoint[];
  labExperiments?: LabExperiment[];
  theme?: 'dark' | 'light' | 'oled';
  accentColor?: AccentColor;
  systemSettings?: SystemSettings;
  pushSubscription?: any; // Stores the Web Push Subscription object (endpoint, keys)
  networkNotifications?: Record<string, { newTrade: boolean; newPrep: boolean; newReview: boolean }>;
}

export interface SystemSettings {
  sessionAlertsEnabled: boolean;
  sessionStartAlert15m: boolean;
  sessionStartAlertExact: boolean;
  sessionEndAlertExact: boolean;
  sessionEndAlert10m: boolean;
  guardianEnabled: boolean;
  morningPrepAlert60m: boolean;
  morningPrepAlert15m: boolean;
  morningPrepAlertCritical: boolean;
  strictModeEnabled: boolean;
  eveningAuditAlertEnabled: boolean;
  eveningAuditAlertTime: string; // HH:mm
  morningWakeUpDebtAlert: boolean;
  testModeEnabled?: boolean;
}



export interface AIConversation {
  id: string;
  user_id?: string;
  title: string;
  category: 'general' | 'analysis' | 'report';
  scope?: 'live' | 'backtest';
  created_at: string;
  updated_at: string;
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
