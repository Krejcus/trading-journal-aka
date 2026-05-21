
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { DailyPrep, DailyReview, Trade, IronRule, RuleCompletion, WeeklyReview, WeeklyFocus, PsychoMetricConfig, SessionConfig, SessionAnalysis, GoalResult } from '../types';
import DisciplineDashboard from './DisciplineDashboard';
import TacticalTimeline from './TacticalTimeline';
import ImageZoomModal from './ImageZoomModal';
import WeeklyOverview from './WeeklyOverview';
import { storageService } from '../services/storageService';
import {
  Coffee,
  Moon,
  CheckCircle2,
  Save,
  Download,
  Sparkles,
  Zap,
  Brain,
  Star,
  Plus,
  X,
  Target,
  AlertCircle,
  ShieldCheck,
  ShieldAlert,
  Clock,
  LayoutGrid,
  Calendar,
  BarChart3,
  TrendingUp,
  TrendingDown,
  Trophy,
  History,
  Activity,
  Award,
  ImageIcon,
  Maximize2,
  AlertOctagon,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Smile,
  Frown,
  Meh,
  FileText,
  TrendingUp as TrendUp,
  AlertTriangle,
  Check,
  Scissors,
  Flag,
  Rocket,
  List,
  Filter,
  Layers,
  ArrowRight,
  MessageSquare,
  StickyNote,
  DollarSign,
  Gauge,
  CircleCheck,
  CircleAlert,
  Sun,
  ClipboardCheck,
  Loader2,
  Info
} from 'lucide-react';

interface DailyJournalProps {
  theme: 'dark' | 'light' | 'oled';
  trades: Trade[];
  preps: DailyPrep[];
  reviews: DailyReview[];
  onSavePrep: (prep: DailyPrep) => Promise<void> | void;
  onSaveReview: (review: DailyReview) => Promise<void> | void;
  onDeletePrep?: (date: string) => void;
  onDeleteReview?: (date: string) => void;
  standardGoals: string[];
  ironRules: IronRule[];
  psychoMetrics?: PsychoMetricConfig[];
  viewMode: 'individual' | 'combined';
  weeklyFocusList: WeeklyFocus[];
  activeTab: 'daily' | 'weekly' | 'archives';
  onTabChange: (tab: 'daily' | 'weekly' | 'archives') => void;
  sessions?: SessionConfig[];
  initialDate?: string; // Přeskočit na konkrétní datum (z AI Chatu)
}

const DailyJournal: React.FC<DailyJournalProps> = ({
  theme, trades, preps, reviews, onSavePrep, onSaveReview, onDeletePrep, onDeleteReview, standardGoals, ironRules, psychoMetrics, viewMode, weeklyFocusList, activeTab, onTabChange, sessions = [], initialDate
}) => {
  const getToday = () => new Date().toLocaleDateString('en-CA');
  const [selectedDate, setSelectedDate] = useState(initialDate ?? getToday());
  const today = getToday();

  // Přeskočit na datum z AI Chatu
  useEffect(() => {
    if (initialDate) setSelectedDate(initialDate);
  }, [initialDate]);

  const [view, setView] = useState<'timeline' | 'edit-prep' | 'edit-review' | 'edit-weekly'>('timeline');
  // Auto-expand signál pro TacticalTimeline (klik z týdenního přehledu)
  const [autoExpand, setAutoExpand] = useState<'prep' | 'review' | null>(null);
  const [activeImageField, setActiveImageField] = useState<'bullish' | 'bearish' | 'scenarios' | string | null>(null);
  const [zoomImg, setZoomImg] = useState<string | null>(null);

  const [weeklyReviews, setWeeklyReviews] = useState<WeeklyReview[]>([]);

  // Weekly Navigation State
  const [activeWeekMonday, setActiveWeekMonday] = useState(() => {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff)).toLocaleDateString('en-CA');
  });

  const [activeSessionTab, setActiveSessionTab] = useState<string | null>(null);

  // Export State
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [exportRange, setExportRange] = useState<'7' | '30' | '90' | 'all'>('30');
  const [exportFormat, setExportFormat] = useState<'pdf' | 'csv' | 'ai'>('pdf');
  const [exportFields, setExportFields] = useState({
    notes: true,
    mistakes: true,
    stressors: true,
    gratitude: true,
    pnl: true,
    rating: true,
    analysisScreenshots: true,
    tradeScreenshots: true,
    showTimestamps: true
  });

  const [quickNote, setQuickNote] = useState('');

  // Auto-save State
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unsaved changes warning
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const rituals = useMemo(() => ironRules.filter(r => r.type === 'ritual'), [ironRules]);
  const tradeRules = useMemo(() => ironRules.filter(r => r.type === 'trading'), [ironRules]);

  // Cleanup save-status timer on unmount to avoid setState on unmounted component
  useEffect(() => {
    return () => {
      if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
    };
  }, []);

  const groupedTrades = useMemo(() => {
    const groups: { [key: string]: Trade[] } = {};

    trades.forEach(t => {
      let key = t.groupId;
      if (!key) {
        const dateStr = t.date.split('T')[0];
        const timeBucket = Math.floor(t.timestamp / 60000);
        key = `legacy_${dateStr}_${t.instrument}_${t.direction}_${timeBucket}`;
      }

      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    });

    return Object.values(groups).map(group => {
      if (group.length === 1) return group[0];
      const master = { ...group[0] };
      master.pnl = group.reduce((sum, t) => sum + t.pnl, 0);
      (master as any).accountCount = group.length - 1;
      (master as any).originalTrades = group;
      return master;
    });
  }, [trades]);

  const currentPrep = useMemo(() => preps.find(p => p.date === selectedDate), [preps, selectedDate]);
  const currentTrades = useMemo(() => groupedTrades.filter(t => t.date.startsWith(selectedDate)), [groupedTrades, selectedDate]);


  const [prepForm, setPrepForm] = useState<DailyPrep>({
    id: `prep_${selectedDate}`,
    date: selectedDate,
    scenarios: { bullish: '', bearish: '', scenarioImages: [], bullishImage: '', bearishImage: '' },
    goals: standardGoals.length > 0 ? [...standardGoals] : [''],
    checklist: { sleptWell: false, planReady: false, disciplineCommitted: false, newsChecked: false },
    ritualCompletions: rituals.map(r => ({ ruleId: r.id, status: 'Pending', label: r.label })),
    mindsetState: '',
    confidence: 5
  });

  const [reviewForm, setReviewForm] = useState<DailyReview>({
    id: `review_${selectedDate}`,
    date: selectedDate,
    mainTakeaway: '',
    mistakes: [],
    lessons: '',
    rating: 0,
    goalResults: [],
    scenarioResult: undefined,
    ruleAdherence: tradeRules.map(r => ({ ruleId: r.id, status: 'Pending', label: r.label })),
    weeklyGoalAdherence: [],
    psycho: { metrics: (psychoMetrics || []).reduce((acc, m) => ({ ...acc, [m.id]: 5 }), {}), stressors: '', gratitude: '', notes: '' }
  });

  // Track the most recent form state to save on switch/unmount
  const lastPrepForm = useRef(prepForm);
  const lastReviewForm = useRef(reviewForm);
  const skipAutoSavePrep = useRef(false);
  const skipAutoSaveReview = useRef(false);
  const prepFormDirty = useRef(false);
  const reviewFormDirty = useRef(false);

  // Wrapper: marks form dirty before updating (for user edits only)
  const editPrepForm: typeof setPrepForm = (action) => {
    prepFormDirty.current = true;
    setPrepForm(action);
  };
  const editReviewForm: typeof setReviewForm = (action) => {
    reviewFormDirty.current = true;
    setReviewForm(action);
  };

  const handleUpdateBreakdown = useCallback((sessionId: string, sessionLabel: string, notes: string, screenshot?: string) => {
    editReviewForm((prev: DailyReview) => {
      const existing = prev.sessionBreakdowns || [];
      const idx = existing.findIndex(b => b.sessionId === sessionId);
      const updated = idx >= 0
        ? existing.map((b, i) => i === idx ? { ...b, notes, screenshot } : b)
        : [...existing, { sessionId, sessionLabel, notes, screenshot }];
      return { ...prev, sessionBreakdowns: updated };
    });
  }, []);

  useEffect(() => { lastPrepForm.current = prepForm; }, [prepForm]);
  useEffect(() => { lastReviewForm.current = reviewForm; }, [reviewForm]);

  // Force save on unmount (only if not empty)
  useEffect(() => {
    return () => {
      const p = lastPrepForm.current;
      const r = lastReviewForm.current;
      const isPrepEmpty = !p.scenarios.bullish && !p.scenarios.bearish && !p.mindsetState && !p.scenarios.scenarioImages?.length && !p.scenarios.sessions?.some(s => s.plan?.trim() || s.image) && !p.ritualCompletions?.some(r => r.status === 'Pass');
      const isReviewEmpty = !r.mainTakeaway && !r.lessons && r.rating === 0 && !r.psycho?.notes && !r.psycho?.stressors?.trim() && !r.psycho?.gratitude?.trim() && !r.ruleAdherence?.some(a => a.status !== 'Pending') && !r.sessionBreakdowns?.some(b => b.notes?.trim()) && !r.goalResults?.some(g => g.achieved) && !r.weeklyGoalAdherence?.some(a => a.status !== 'Pending');

      if (!isPrepEmpty) onSavePrep(p);
      if (!isReviewEmpty) onSaveReview(r);
    };
  }, []);

  // Flush pending journal data when browser tab is closed/refreshed or hidden
  useEffect(() => {
    const flushOnClose = (e?: BeforeUnloadEvent) => {
      const p = lastPrepForm.current;
      const r = lastReviewForm.current;
      const isPrepEmpty = !p.scenarios.bullish && !p.scenarios.bearish && !p.mindsetState && !p.scenarios.scenarioImages?.length && !p.scenarios.sessions?.some(s => s.plan?.trim() || s.image) && !p.ritualCompletions?.some(r => r.status === 'Pass');
      const isReviewEmpty = !r.mainTakeaway && !r.lessons && r.rating === 0 && !r.psycho?.notes && !r.psycho?.stressors?.trim() && !r.psycho?.gratitude?.trim() && !r.ruleAdherence?.some(a => a.status !== 'Pending') && !r.sessionBreakdowns?.some(b => b.notes?.trim()) && !r.goalResults?.some(g => g.achieved) && !r.weeklyGoalAdherence?.some(a => a.status !== 'Pending');

      if (!isPrepEmpty) onSavePrep(p);
      if (!isReviewEmpty) onSaveReview(r);

      // CRITICAL: pokud má uživatel neuložené změny, zabraň zavření tabu — save běží na pozadí ale prohlížeč se vypne dřív
      if (e && (hasUnsavedChanges || prepFormDirty.current || reviewFormDirty.current)) {
        e.preventDefault();
        e.returnValue = 'Máš neuložené změny v deníku. Opravdu chceš odejít?';
        return e.returnValue;
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushOnClose();
    };
    window.addEventListener('beforeunload', flushOnClose);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', flushOnClose);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [onSavePrep, onSaveReview, hasUnsavedChanges]);

  // Current Week Focus Helper - Harmonized with Settings.tsx
  const getSelectedWeekISO = (dateStr: string) => {
    const date = new Date(dateStr);
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  };

  const currentWeekFocus = useMemo(() => {
    const weekISO = getSelectedWeekISO(selectedDate);
    return weeklyFocusList.find(wf => wf.weekISO === weekISO);
  }, [selectedDate, weeklyFocusList]);

  // Normalize prep for comparison (strips undefined, normalizes empty arrays/strings)
  const normalizePrep = (p: DailyPrep) => JSON.stringify({
    id: p.id, date: p.date, bias: p.bias || '',
    scenarios: {
      bullish: p.scenarios.bullish || '', bearish: p.scenarios.bearish || '',
      bullishImage: p.scenarios.bullishImage || '',
      bearishImage: p.scenarios.bearishImage || '',
      scenarioImages: p.scenarios.scenarioImages || [],
      sessions: (p.scenarios.sessions || []).map(s => ({ id: s.id, label: s.label || '', color: s.color || '', plan: s.plan || '', image: s.image || '', bias: s.bias || '' })),
    },
    goals: p.goals || [], checklist: p.checklist,
    ritualCompletions: p.ritualCompletions || [],
    mindsetState: p.mindsetState || '', confidence: p.confidence ?? 50
  });

  // Normalize review for comparison (prevents save loops from JSON.stringify field-order differences)
  const normalizeReview = (r: DailyReview) => JSON.stringify({
    date: r.date,
    mainTakeaway: r.mainTakeaway || '',
    lessons: r.lessons || '',
    rating: r.rating ?? 0,
    scenarioResult: r.scenarioResult || '',
    mistakes: r.mistakes || [],
    goalResults: (r.goalResults || []).map(g => ({ text: g.text || '', achieved: !!g.achieved })),
    ruleAdherence: (r.ruleAdherence || []).map(a => ({ ruleId: a.ruleId, status: a.status, label: a.label || '' })),
    weeklyGoalAdherence: (r.weeklyGoalAdherence || []).map(a => ({ ruleId: a.ruleId, status: a.status, label: a.label || '' })),
    sessionBreakdowns: (r.sessionBreakdowns || []).map(b => ({ sessionId: b.sessionId, notes: b.notes || '', screenshot: b.screenshot || '' })),
    psycho: {
      stressors: r.psycho?.stressors || '',
      gratitude: r.psycho?.gratitude || '',
      notes: r.psycho?.notes || '',
      metrics: r.psycho?.metrics || {},
    }
  });

  // Auto-save Logic for Prep
  useEffect(() => {
    if (skipAutoSavePrep.current) {
      skipAutoSavePrep.current = false;
      return;
    }
    // Only auto-save when user has actually edited the form
    if (!prepFormDirty.current) return;
    // Skip initial mount or invalid forms
    if (!prepForm || !prepForm.date) return;

    // Check if form is actually different from saved prop to avoid loops/unnecessary saves
    const saved = preps.find(p => p.date === prepForm.date);
    if (!saved || normalizePrep(prepForm) !== normalizePrep(saved)) {
      // Don't auto-save a brand new prep if it's still empty
      if (!saved) {
        const isEmpty = !prepForm.scenarios.bullish && !prepForm.scenarios.bearish && !prepForm.mindsetState && !prepForm.scenarios.scenarioImages?.length && !prepForm.scenarios.sessions?.some(s => s.plan?.trim() || s.image) && !prepForm.ritualCompletions?.some(r => r.status === 'Pass');
        if (isEmpty) return;
      }
      // Skip autosave when tab is hidden — prevents concurrent writes when multiple clients are open
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      setHasUnsavedChanges(true);
      setSaveStatus('saving');
      setIsSaving(true);
      const timer = setTimeout(async () => {
        try {
          await onSavePrep(prepForm);
          prepFormDirty.current = false;
          setLastSaved(new Date());
          setHasUnsavedChanges(false);
          setSaveStatus('saved');
          if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
          saveStatusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
        } catch {
          setSaveStatus('error');
        } finally {
          setIsSaving(false);
        }
      }, 2000);

      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepForm, onSavePrep]);

  // Auto-save Logic for Review
  useEffect(() => {
    if (skipAutoSaveReview.current) {
      skipAutoSaveReview.current = false;
      return;
    }
    // Only auto-save when user has actually edited the form
    if (!reviewFormDirty.current) return;
    // Skip initial mount or invalid forms
    if (!reviewForm || !reviewForm.date) return;

    // Check if form is actually different from saved prop
    const saved = reviews.find(r => r.date === reviewForm.date);
    if (!saved || normalizeReview(reviewForm) !== normalizeReview(saved)) {
      // Don't auto-save a brand new review if it's still empty
      if (!saved) {
        const isEmpty = !reviewForm.mainTakeaway && !reviewForm.lessons && reviewForm.rating === 0 && !reviewForm.psycho?.notes && !reviewForm.psycho?.stressors?.trim() && !reviewForm.psycho?.gratitude?.trim() && !reviewForm.ruleAdherence?.some(a => a.status !== 'Pending') && !reviewForm.sessionBreakdowns?.some(b => b.notes?.trim());
        if (isEmpty) return;
      }
      // Skip autosave when tab is hidden — prevents concurrent writes when multiple clients are open
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      setHasUnsavedChanges(true);
      setSaveStatus('saving');
      setIsSaving(true);
      const timer = setTimeout(async () => {
        try {
          await onSaveReview(reviewForm);
          reviewFormDirty.current = false;
          setLastSaved(new Date());
          setHasUnsavedChanges(false);
          setSaveStatus('saved');
          if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current);
          saveStatusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
        } catch {
          setSaveStatus('error');
        } finally {
          setIsSaving(false);
        }
      }, 2000);

      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewForm, onSaveReview]);

  const addQuickNote = () => {
    if (!quickNote.trim()) return;
    const now = new Date();
    const timestamp = `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}]`;
    const newNote = `${timestamp} ${quickNote}`;
    editReviewForm(prev => ({
      ...prev,
      psycho: {
        ...prev.psycho!,
        notes: prev.psycho?.notes ? `${prev.psycho.notes}\n${newNote}` : newNote
      }
    }));
    setQuickNote('');
  };

  // Manual immediate save (bypasses debounce)
  const handleManualSave = useCallback(async () => {
    setSaveStatus('saving');
    setIsSaving(true);
    try {
      await Promise.all([onSavePrep(prepForm), onSaveReview(reviewForm)]);
      prepFormDirty.current = false;
      reviewFormDirty.current = false;
      setLastSaved(new Date());
      setHasUnsavedChanges(false);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
    }
  }, [prepForm, reviewForm, onSavePrep, onSaveReview]);

  // Handle navigation with unsaved changes check
  const handleNavigateWithCheck = useCallback((action: () => void) => {
    const isEditingForm = view === 'edit-prep' || view === 'edit-review';
    if (hasUnsavedChanges || isEditingForm) {
      setPendingAction(() => action);
      setShowUnsavedWarning(true);
    } else {
      action();
    }
  }, [hasUnsavedChanges, view]);

  // Handle warning dialog actions
  const handleSaveAndProceed = useCallback(async () => {
    try {
      if (view === 'edit-prep') {
        await onSavePrep({ ...prepForm, completed: true });
      } else if (view === 'edit-review') {
        await onSaveReview({ ...reviewForm, completed: true });
      } else {
        await handleManualSave();
      }
    } catch { /* save failed, proceed anyway */ }
    prepFormDirty.current = false;
    reviewFormDirty.current = false;
    setHasUnsavedChanges(false);
    if (pendingAction) pendingAction();
    setShowUnsavedWarning(false);
    setPendingAction(null);
  }, [handleManualSave, pendingAction, view, prepForm, reviewForm, onSavePrep, onSaveReview]);

  const handleDiscardAndProceed = useCallback(() => {
    prepFormDirty.current = false;
    reviewFormDirty.current = false;
    setHasUnsavedChanges(false);
    if (pendingAction) pendingAction();
    setShowUnsavedWarning(false);
    setPendingAction(null);
  }, [pendingAction]);

  const handleCancelNavigation = useCallback(() => {
    setShowUnsavedWarning(false);
    setPendingAction(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadExtra = async () => {
      try {
        const data = await storageService.getWeeklyReviews();
        if (mounted) setWeeklyReviews(data);
      } catch (err) {
        console.warn('[DailyJournal] Failed to load weekly reviews:', err);
      }
    };
    loadExtra();
    return () => { mounted = false; };
  }, []);

  // --- EXPORT LOGIC ---
  const handleExport = () => {
    let filteredReviews = [...reviews].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    if (exportRange !== 'all') {
      const days = parseInt(exportRange);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      filteredReviews = filteredReviews.filter(r => new Date(r.date) >= cutoff);
    }

    if (exportFormat === 'csv') {
      const headers = ['Datum'];
      if (exportFields.rating) headers.push('Rating');
      if (exportFields.stressors) headers.push('Stresory');
      if (exportFields.gratitude) headers.push('Vděčnost');
      if (exportFields.mistakes) headers.push('Mistakes');
      if (exportFields.notes) headers.push('Reflections');
      if (exportFields.pnl) headers.push('Day PnL');

      const rows = filteredReviews.map(r => {
        const rowData: any[] = [r.date];
        if (exportFields.rating) rowData.push(r.rating || 0);
        if (exportFields.stressors) rowData.push(`"${(r.psycho?.stressors || '').replace(/"/g, '""')}"`);
        if (exportFields.gratitude) rowData.push(`"${(r.psycho?.gratitude || '').replace(/"/g, '""')}"`);
        if (exportFields.mistakes) rowData.push(`"${(r.mistakes || []).join(', ').replace(/"/g, '""')}"`);
        if (exportFields.notes) {
          let notes = r.psycho?.notes || r.mainTakeaway || '';
          if (!exportFields.showTimestamps) {
            notes = notes.replace(/\[\d{2}:\d{2}\]\s?/g, '');
          }
          rowData.push(`"${notes.replace(/"/g, '""')}"`);
        }
        if (exportFields.pnl) {
          const dayPnL = groupedTrades.filter(t => t.date.startsWith(r.date)).reduce((s, t) => s + t.pnl, 0);
          rowData.push(dayPnL);
        }
        return rowData;
      });

      const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `alphatrade_export_${exportRange}d.csv`;
      link.click();
    } else if (exportFormat === 'ai') {
      let mdContent = `# ALPHATRADE EXPORT - ${exportRange === 'all' ? 'ALL TIME' : `LAST ${exportRange} DAYS`}\n\n`;
      filteredReviews.forEach(r => {
        const prep = preps.find(p => p.date === r.date);
        mdContent += `## DATE: ${r.date}\n`;
        if (exportFields.rating || exportFields.pnl) {
          mdContent += `### Stats\n`;
          if (exportFields.rating) mdContent += `- Rating: ${r.rating || 0}/5\n`;
          if (exportFields.pnl) {
            const dayPnL = groupedTrades.filter(t => t.date.startsWith(r.date)).reduce((s, t) => s + t.pnl, 0);
            mdContent += `- Day PnL: $${dayPnL.toLocaleString(undefined, { maximumFractionDigits: 0 })}\n`;
          }
          mdContent += `\n`;
        }

        if (exportFields.stressors || exportFields.gratitude) {
          mdContent += `### Psycho\n`;
          if (exportFields.stressors) mdContent += `- Stressors: ${r.psycho?.stressors || 'None'}\n`;
          if (exportFields.gratitude) mdContent += `- Gratitude: ${r.psycho?.gratitude || 'None'}\n`;
          mdContent += `\n`;
        }

        if (exportFields.mistakes) {
          mdContent += `### Performance\n`;
          mdContent += `- Mistakes: ${(r.mistakes || []).join(', ') || 'None'}\n`;
          const weekISO = getSelectedWeekISO(r.date);
          const wf = weeklyFocusList.find(focus => focus.weekISO === weekISO);
          if (wf && wf.goals.length > 0) {
            mdContent += `- Weekly Focus: ${wf.goals.map((g, i) => `${g} (${r.weeklyGoalAdherence?.[i]?.status === 'Pass' ? 'PASS' : 'FAIL'})`).join(', ')}\n`;
          }
          mdContent += `\n`;
        }
        if (exportFields.notes) {
          mdContent += `### Reflections\n`;
          let notes = r.psycho?.notes || r.mainTakeaway || 'No notes.';
          if (!exportFields.showTimestamps) {
            notes = notes.replace(/\[\d{2}:\d{2}\]\s?/g, '');
          }
          mdContent += `${notes}\n\n`;
        }

        if (exportFields.analysisScreenshots || exportFields.tradeScreenshots) {
          mdContent += `### Screenshots\n`;
          if (exportFields.analysisScreenshots) mdContent += `- Analysis: Yes\n`;
          if (exportFields.tradeScreenshots) mdContent += `- Trades: Yes\n`;
          mdContent += `\n`;
        }
        mdContent += `---\n\n`;
      });
      const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `alphatrade_ai_export_${exportRange}d.md`;
      link.click();
    } else if (exportFormat === 'pdf') {
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        const reportTitle = `AlphaTrade Journal Report - ${exportRange === 'all' ? 'All Time' : `${exportRange} Days`}`;
        const htmlStyles = `
          <style>
            @page { size: A4; margin: 10mm; }
            body { font-family: 'Inter', sans-serif; color: #1e293b; margin: 0; padding: 0; font-size: 10px; line-height: 1.4; }
            .week-container { page-break-after: always; }
            .header-main { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #3b82f6; padding-bottom: 5px; margin-bottom: 15px; }
            .header-main h1 { margin: 0; font-size: 18px; font-weight: 900; text-transform: uppercase; letter-spacing: -0.5px; }
            .day { margin-bottom: 15px; border: 1px solid #e2e8f0; border-radius: 12px; padding: 10px; page-break-inside: avoid; }
            .day-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid #f1f5f9; padding-bottom: 5px; }
            .day-title { font-weight: 900; text-transform: uppercase; font-size: 11px; color: #3b82f6; }
            .pnl-badge { font-weight: 900; font-family: monospace; font-size: 11px; }
            .section { margin-top: 8px; }
            .section-label { font-size: 7px; font-weight: 900; text-transform: uppercase; color: #64748b; letter-spacing: 0.5px; margin-bottom: 2px; }
            .content-text { font-style: italic; color: #334155; border-left: 2px solid #e2e8f0; padding-left: 8px; }
            .screenshots-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin-top: 8px; }
            .screenshot-item { position: relative; border-radius: 4px; overflow: hidden; border: 1px solid #e2e8f0; }
            .screenshot-item img { width: 100%; height: auto; display: block; }
            .screenshot-label { position: absolute; top: 2px; left: 2px; background: rgba(0,0,0,0.6); color: white; font-size: 6px; padding: 1px 3px; font-weight: 900; border-radius: 2px; }
            .psycho-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 8px; }
            .psycho-box { background: #f1f5f9; padding: 6px; border-radius: 8px; }
            .stats-row { display: flex; gap: 15px; margin-top: 5px; font-size: 8px; font-weight: 700; text-transform: uppercase; }
            .stat-box { background: #f8fafc; padding: 4px 8px; border-radius: 6px; }
          </style>
        `;

        let html = `<html><head><title>${reportTitle}</title>${htmlStyles}</head><body>`;
        html += `
          <div class="header-main">
            <div>
              <h1>Trading Journal Report</h1>
              <div style="font-size: 10px; font-weight: 700; color: #64748b; margin-top: 2px; text-transform: uppercase;">Generated for: Alpha Trader</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 8px; font-weight: 900; color: #64748b; text-transform: uppercase;">Reporting Period</div>
              <div style="font-size: 12px; font-weight: 900; color: #1e293b;">${filteredReviews.length > 0 ? filteredReviews[filteredReviews.length - 1].date : '-'} TO ${filteredReviews[0]?.date || '-'}</div>
            </div>
          </div>
        `;

        filteredReviews.forEach((r, idx) => {
          const dayTrades = groupedTrades.filter(t => t.date.startsWith(r.date));
          const dayPnL = dayTrades.reduce((s, t) => s + t.pnl, 0);

          // Add weekly break logic
          const date = new Date(r.date);
          const isMonday = date.getDay() === 1;
          if (idx > 0 && isMonday) {
            html += `<div style="page-break-after: always;"></div>`;
          }

          html += `
            <div class="day">
              <div class="day-header">
                <div class="day-title">${new Date(r.date).toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'numeric' })}</div>
                <div class="pnl-badge" style="color: ${dayPnL >= 0 ? '#10b981' : '#f43f5e'}">
                  ${dayPnL >= 0 ? '+' : '-'}$${Math.abs(dayPnL).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </div>
              </div>

              <div class="stats-row">
                <div class="stat-box">Rating: ${r.rating || 0}/5</div>
                <div class="stat-box">Trades: ${dayTrades.length}</div>
                ${(r.mistakes || []).length > 0 ? `<div class="stat-box" style="color: #ef4444">Mistakes: ${(r.mistakes || []).length}</div>` : ''}
              </div>

              ${(exportFields.stressors || exportFields.gratitude) ? `
                <div class="psycho-grid">
                  ${exportFields.stressors ? `
                    <div class="psycho-box">
                      <div class="section-label">Stresory</div>
                      <div style="font-size: 9px; font-style: italic;">${r.psycho?.stressors || 'None'}</div>
                    </div>
                  ` : ''}
                  ${exportFields.gratitude ? `
                    <div class="psycho-box">
                      <div class="section-label">Vděčnost</div>
                      <div style="font-size: 9px; font-style: italic;">${r.psycho?.gratitude || 'None'}</div>
                    </div>
                  ` : ''}
                </div>
              ` : ''}

              ${exportFields.notes ? `
                <div class="section">
                  <div class="section-label">Reflexe & Poznámky</div>
                  <div class="content-text">${r.psycho?.notes || r.mainTakeaway || 'Bez poznámek.'}</div>
                </div>
              ` : ''}

              ${(exportFields.analysisScreenshots || exportFields.tradeScreenshots) ? (() => {
              const prep = preps.find(p => p.date === r.date);
              const allImgs: { src: string, label: string }[] = [];

              if (exportFields.analysisScreenshots) {
                if (prep?.scenarios?.scenarioImages) prep.scenarios.scenarioImages.forEach((img, i) => allImgs.push({ src: img, label: `Prep ${i + 1}` }));
                if (prep?.scenarios?.bullishImage) allImgs.push({ src: prep.scenarios.bullishImage, label: 'Bullish' });
                if (prep?.scenarios?.bearishImage) allImgs.push({ src: prep.scenarios.bearishImage, label: 'Bearish' });
              }

              if (exportFields.tradeScreenshots) {
                dayTrades.forEach((t) => {
                  const tImgs = t.screenshots && t.screenshots.length > 0 ? t.screenshots : (t.screenshot ? [t.screenshot] : []);
                  tImgs.forEach((img, j) => allImgs.push({ src: img, label: `${t.instrument} ${j + 1}` }));
                });
              }

              if (allImgs.length === 0) return '';

              const gridItems = allImgs.map(img => `
                  <div class="screenshot-item">
                    <div class="screenshot-label">${img.label}</div>
                    <img src="${img.src}" />
                  </div>
                `).join('');

              return `<div class="screenshots-grid">${gridItems}</div>`;
            })() : ''}
            </div>
          `;
        });

        html += '</body></html>';
        printWindow.document.write(html);
        printWindow.document.close();
      }
    }
    setIsExportModalOpen(false);
  };

  // --- WEEKLY LOGIC ---
  const currentWeekInfo = useMemo(() => {
    const monday = new Date(activeWeekMonday);
    const weekDays = Array.from({ length: 5 }, (_, i) => {
      const current = new Date(monday);
      current.setDate(monday.getDate() + i);
      return current.toLocaleDateString('en-CA');
    });
    const onejan = new Date(monday.getFullYear(), 0, 1);
    const weekNum = Math.ceil((((monday.getTime() - onejan.getTime()) / 86400000) + onejan.getDay() + 1) / 7);
    return { days: weekDays, weekNumber: weekNum, year: monday.getFullYear(), mondayDate: activeWeekMonday };
  }, [activeWeekMonday]);

  const navigateWeek = (direction: 'prev' | 'next') => {
    const d = new Date(activeWeekMonday);
    if (direction === 'prev') d.setDate(d.getDate() - 7);
    else d.setDate(d.getDate() + 7);
    setActiveWeekMonday(d.toLocaleDateString('en-CA'));
  };

  const weeklyStats = useMemo(() => {
    const weekTrades = groupedTrades.filter(t => currentWeekInfo.days.includes(t.date.split('T')[0]));
    const weekPreps = preps.filter(p => currentWeekInfo.days.includes(p.date));
    const weekReviews = reviews.filter(r => currentWeekInfo.days.includes(r.date));

    const pnl = weekTrades.reduce((s, t) => s + t.pnl, 0);
    const validTrades = weekTrades.filter(t => t.isValid !== false);
    const invalidTrades = weekTrades.filter(t => t.isValid === false);
    const disciplinedPnL = validTrades.reduce((s, t) => s + t.pnl, 0);
    const wins = weekTrades.filter(t => t.pnl > 0).length;

    // Counts for Prep/Audit (only completed ones)
    const prepCount = weekPreps.filter(p => p.completed).length;
    const auditCount = weekReviews.filter(r => r.completed).length;

    // Session Analytics
    const sessions = { ASIA: 0, LDN: 0, NY: 0 };
    weekTrades.forEach(t => {
      const h = new Date(t.timestamp).getHours();
      if (h >= 8 && h < 14) sessions.LDN += t.pnl;
      else if (h >= 14 && h < 21) sessions.NY += t.pnl;
      else sessions.ASIA += t.pnl;
    });

    const sessionEntries = Object.entries(sessions);
    const bestSession = sessionEntries.length > 0 ? sessionEntries.sort((a, b) => b[1] - a[1])[0] : ['N/A', 0];
    const worstSession = sessionEntries.length > 0 ? sessionEntries.sort((a, b) => a[1] - b[1])[0] : ['N/A', 0];

    // Iron Rule Compliance
    const ritualCompliance = ironRules.map(rule => {
      let passedCount = 0;
      currentWeekInfo.days.forEach(day => {
        const p = weekPreps.find(prep => prep.date === day);
        const r = weekReviews.find(rev => rev.date === day);
        const isRitualPass = p?.ritualCompletions?.find(c => c.ruleId === rule.id)?.status === 'Pass';
        const isTradingPass = r?.ruleAdherence?.find(a => a.ruleId === rule.id)?.status === 'Pass';
        if (isRitualPass || isTradingPass) passedCount++;
      });
      return { label: rule.label, count: passedCount, total: 5 };
    });

    const goalsAchieved = weekReviews.reduce((sum, r) => sum + (r.goalResults?.filter(g => g.achieved).length || 0), 0);
    const totalMistakes = weekReviews.reduce((sum, r) => sum + (r.mistakes?.filter(m => m.trim() !== '').length || 0), 0);
    const dailyNotes = weekReviews.map(r => ({ date: r.date, text: r.mainTakeaway })).filter(n => n.text.trim() !== '');

    return {
      pnl,
      disciplinedPnL,
      validCount: validTrades.length,
      invalidCount: invalidTrades.length,
      count: weekTrades.length,
      wr: weekTrades.length > 0 ? (wins / weekTrades.length) * 100 : 0,
      totalMistakes,
      goalsAchieved,
      dailyNotes,
      bestSession,
      worstSession,
      ritualCompliance,
      prepCount,
      auditCount,
      weeklyGoalStats: currentWeekFocus?.goals.map((goal, idx) => {
        let passCount = 0;
        currentWeekInfo.days.forEach(day => {
          const rev = reviews.find(r => r.date === day);
          if (rev?.weeklyGoalAdherence?.[idx]?.status === 'Pass') passCount++;
        });
        return { label: goal.text, emoji: goal.emoji, count: passCount };
      }) || []
    };
  }, [trades, reviews, preps, currentWeekInfo, ironRules, weeklyFocusList, currentWeekFocus]);

  const navigateDate = (direction: 'prev' | 'next') => {
    const doNavigate = () => {
      const d = new Date(selectedDate);
      if (direction === 'prev') d.setDate(d.getDate() - 1);
      else d.setDate(d.getDate() + 1);
      const newDateStr = d.toLocaleDateString('en-CA');
      if (newDateStr <= today) { setSelectedDate(newDateStr); setView('timeline'); }
    };
    handleNavigateWithCheck(doNavigate);
  };

  const currentReview = useMemo(() => reviews.find(r => r.date === selectedDate), [reviews, selectedDate]);

  useEffect(() => {
    // 1. Force save the PREVIOUS date's form if it was dirty and not empty
    if (lastPrepForm.current.date && lastPrepForm.current.date !== selectedDate && prepFormDirty.current) {
      const p = lastPrepForm.current;
      const isEmpty = !p.scenarios.bullish && !p.scenarios.bearish && !p.mindsetState && !p.scenarios.scenarioImages?.length && !p.scenarios.sessions?.some(s => s.plan?.trim() || s.image) && !p.ritualCompletions?.some(r => r.status === 'Pass');
      if (!isEmpty) void onSavePrep(p);
    }

    // 2. Load the new date's form
    skipAutoSavePrep.current = true;
    prepFormDirty.current = false;
    if (currentPrep) {
      // Hydrate missing fields for legacy preps and SYNC labels with current settings
      const configSessions = sessions.length > 0
        ? sessions.slice(0, 3).map(s => ({ id: s.id, label: s.name, plan: '', image: '' }))
        : [
          { id: 'session1', label: 'Session 1', plan: '', image: '' }
        ];

      const storedSessions = currentPrep.scenarios.sessions || configSessions;
      // Keep only sessions that still exist in config, sync labels/colors
      const mergedSessions = storedSessions
        .filter(stored => sessions.some(s => s.id === stored.id))
        .map(stored => {
          const configMatch = sessions.find(s => s.id === stored.id)!;
          return { ...stored, label: configMatch.name, color: configMatch.color };
        });
      // Add new sessions from config that aren't in stored prep yet
      const newFromConfig = sessions
        .filter(s => !mergedSessions.some(m => m.id === s.id))
        .map(s => ({ id: s.id, label: s.name, plan: '', image: '', color: s.color }));

      const allSessions = [...mergedSessions, ...newFromConfig];
      setPrepForm({
        ...currentPrep,
        bias: currentPrep.bias || 'Neutral',
        scenarios: {
          ...currentPrep.scenarios,
          sessions: allSessions
        }
      });

      // Set initial tab or reset if current tab was deleted
      if (allSessions.length && (!activeSessionTab || !allSessions.some(s => s.id === activeSessionTab))) {
        setActiveSessionTab(allSessions[0].id);
      }
    } else {
      // Intelligently initialize sessions based on preferences
      const initialSessions: SessionAnalysis[] = sessions.length > 0
        ? sessions.slice(0, 3).map(s => ({ id: s.id, label: s.name, plan: '', image: '', color: s.color }))
        : [
          { id: 'session1', label: 'Session 1', plan: '', image: '', color: '#3b82f6' }
        ];

      setPrepForm({
        id: `prep_${selectedDate}`,
        date: selectedDate,
        bias: 'Neutral',
        scenarios: {
          bullish: '',
          bearish: '',
          scenarioImages: [],
          sessions: initialSessions
        },
        goals: standardGoals.slice(0, 3),
        checklist: {
          sleptWell: false,
          planReady: false,
          disciplineCommitted: false,
          newsChecked: false
        },
        mindsetState: '',
        confidence: 50
      });
      if (!activeSessionTab && initialSessions.length) {
        setActiveSessionTab(initialSessions[0].id);
      }
    }
  }, [currentPrep, selectedDate, standardGoals, sessions]);

  const prevSelectedDateRef = useRef(selectedDate);
  useEffect(() => {
    const dateActuallyChanged = prevSelectedDateRef.current !== selectedDate;
    prevSelectedDateRef.current = selectedDate;

    // 1. Force save the PREVIOUS date's review if date changed, was dirty, and not empty
    if (dateActuallyChanged && lastReviewForm.current.date && lastReviewForm.current.date !== selectedDate && reviewFormDirty.current) {
      const r = lastReviewForm.current;
      const isEmpty = !r.mainTakeaway && !r.lessons && r.rating === 0 && !r.psycho?.notes && !r.psycho?.stressors?.trim() && !r.psycho?.gratitude?.trim() && !r.ruleAdherence?.some(a => a.status !== 'Pending') && !r.sessionBreakdowns?.some(b => b.notes?.trim());
      if (!isEmpty) void onSaveReview(r);
    }

    // 2. Load the new date's review — only reset dirty flags when actually loading new data
    if (currentReview) {
      if (reviewForm.date !== selectedDate || (currentReview.id && reviewForm.id !== currentReview.id)) {
        skipAutoSaveReview.current = true;
        reviewFormDirty.current = false;
        setReviewForm(currentReview);
      }
      // else: same date & ID, just a reference change from save round-trip → do NOT reset dirty flags
    } else if (dateActuallyChanged) {
      skipAutoSaveReview.current = true;
      reviewFormDirty.current = false;
      const initialPrep = currentPrep || (lastPrepForm.current.date === selectedDate ? lastPrepForm.current : undefined);
      const initialResults: GoalResult[] = initialPrep?.goals?.filter(g => g && g.trim() !== '').map(g => ({ text: g, achieved: true })) || [];
      setReviewForm({
        id: `review_${selectedDate}`,
        date: selectedDate,
        mainTakeaway: '',
        mistakes: [],
        lessons: '',
        rating: 0,
        goalResults: initialResults,
        scenarioResult: undefined,
        ruleAdherence: tradeRules.map(r => ({ ruleId: r.id, status: 'Pending', label: r.label })),
        psycho: { metrics: (psychoMetrics || []).reduce((acc, m) => ({ ...acc, [m.id]: 5 }), {}), stressors: '', gratitude: '', notes: '' }
      });
    }
  }, [currentReview, selectedDate]); // Omezení závislostí

  const handleToggleRitual = (ruleId: string) => {
    editPrepForm(prev => {
      const completions = prev.ritualCompletions || [];
      const index = completions.findIndex(c => c.ruleId === ruleId);
      const newCompletions = [...completions];
      const label = rituals.find(r => r.id === ruleId)?.label;
      if (index === -1) newCompletions.push({ ruleId, status: 'Pass', label });
      else newCompletions[index] = { ...newCompletions[index], status: newCompletions[index].status === 'Pass' ? 'Pending' : 'Pass', label: newCompletions[index].label || label };
      return { ...prev, ritualCompletions: newCompletions };
    });
  };

  const handleSetRuleStatus = (ruleId: string, status: 'Pass' | 'Fail') => {
    editReviewForm(prev => {
      const adherence = prev.ruleAdherence || [];
      const index = adherence.findIndex(a => a.ruleId === ruleId);
      const newAdherence = [...adherence];
      const label = tradeRules.find(r => r.id === ruleId)?.label;
      if (index === -1) newAdherence.push({ ruleId, status, label });
      else newAdherence[index] = { ...newAdherence[index], status, label: newAdherence[index].label || label };
      return { ...prev, ruleAdherence: newAdherence };
    });
  };

  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (view !== 'edit-prep' || !activeImageField) return;
    const items = e.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4 MB
            if (blob.size > MAX_IMAGE_BYTES) {
              alert(`Obrázek je příliš velký (${(blob.size / 1024 / 1024).toFixed(1)} MB). Maximální velikost je 4 MB.`);
              return;
            }
            const reader = new FileReader();
            reader.onloadend = async () => {
              const base64 = reader.result as string;
              // Optimistic: zobraz base64 hned aby uživatel viděl obrázek okamžitě
              const showBase64 = (b64: string) => {
                if (activeImageField === 'scenarios') {
                  editPrepForm(prev => ({
                    ...prev,
                    scenarios: { ...prev.scenarios, scenarioImages: [...(prev.scenarios.scenarioImages || []), b64] }
                  }));
                } else if (activeImageField?.startsWith('session_')) {
                  const sessionId = activeImageField.replace('session_', '');
                  editPrepForm(prev => ({
                    ...prev,
                    scenarios: {
                      ...prev.scenarios,
                      sessions: prev.scenarios.sessions?.map(s => s.id === sessionId ? { ...s, image: b64 } : s)
                    }
                  }));
                } else {
                  editPrepForm(prev => ({ ...prev, scenarios: { ...prev.scenarios, [activeImageField === 'bullish' ? 'bullishImage' : 'bearishImage']: b64 } }));
                }
              };
              const replaceWithUrl = (url: string) => {
                if (activeImageField === 'scenarios') {
                  editPrepForm(prev => ({
                    ...prev,
                    scenarios: {
                      ...prev.scenarios,
                      // Nahraď poslední base64 (právě vložený) za URL
                      scenarioImages: (prev.scenarios.scenarioImages || []).map((img, idx, arr) =>
                        idx === arr.length - 1 && img === base64 ? url : img
                      )
                    }
                  }));
                } else if (activeImageField?.startsWith('session_')) {
                  const sessionId = activeImageField.replace('session_', '');
                  editPrepForm(prev => ({
                    ...prev,
                    scenarios: {
                      ...prev.scenarios,
                      sessions: prev.scenarios.sessions?.map(s => s.id === sessionId ? { ...s, image: url } : s)
                    }
                  }));
                } else {
                  editPrepForm(prev => ({ ...prev, scenarios: { ...prev.scenarios, [activeImageField === 'bullish' ? 'bullishImage' : 'bearishImage']: url } }));
                }
              };

              showBase64(base64);
              try {
                const url = await storageService.uploadScreenshot(base64, `prep_${activeImageField}_${Date.now()}`);
                replaceWithUrl(url);
              } catch (e) {
                console.warn('[DailyJournal] Upload failed, keeping base64:', e);
              }
            };
            reader.readAsDataURL(blob);
          }
        }
      }
    }
  }, [view, activeImageField]);

  useEffect(() => { window.addEventListener('paste', handlePaste); return () => window.removeEventListener('paste', handlePaste); }, [handlePaste]);

  const inputClass = `w-full px-4 py-3 rounded-xl border transition-all text-sm outline-none focus:ring-2 focus:ring-blue-500/40 ${theme !== 'light' ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-white placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-900'}`;
  const labelClass = `block text-[10px] font-black uppercase tracking-widest mb-2 text-slate-500`;

  return (
    <div className="space-y-6 lg:space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20">

      {/* Mobilní přepínač tabů — skrytý na md+ kde je přepínač v headeru */}
      <div className="flex md:hidden w-full p-1 rounded-2xl border gap-1 bg-[var(--bg-card)]/40 border-[var(--border-subtle)] backdrop-blur-md shadow-sm">
        {([
          { id: 'daily', label: 'Dnešek' },
          { id: 'weekly', label: 'Týden' },
          { id: 'archives', label: 'Deník' }
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`relative flex-1 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all ${
              activeTab === tab.id
                ? (theme !== 'light' ? 'bg-slate-700/60 text-white shadow-sm' : 'bg-white text-slate-900 shadow-sm border border-slate-200/60')
                : (theme !== 'light' ? 'text-slate-500' : 'text-slate-400')
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>


      {activeTab === 'daily' && view === 'timeline' ? (
        <div className="lg:grid lg:grid-cols-[1fr_56px] gap-4 items-start">
          {/* Main Column: Header + Timeline */}
          <div className="space-y-3 lg:space-y-8 min-w-0 order-2 lg:order-1">
            <div className={`flex flex-col md:flex-row justify-between items-start md:items-end gap-3 border-b pb-3 lg:pb-6 ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
              <div className="space-y-2">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6">
                  <h2 className="hidden lg:inline-flex text-3xl md:text-5xl font-black tracking-tighter italic items-center gap-4">
                    DENNÍ PŘEHLED
                  </h2>
                  <div className="flex items-center gap-2 theme-card p-1 rounded-2xl border theme-border shadow-inner self-start">
                    <button onClick={() => navigateDate('prev')} className="p-2 hover:bg-white/10 rounded-xl theme-text-secondary hover:text-[var(--text-primary)] transition-all active:scale-90"><ChevronLeft size={20} /></button>
                    <div className="px-3 py-1 text-center min-w-[100px]">
                      <p className="text-[8px] font-black text-blue-500 uppercase tracking-[0.2em] mb-0.5">Taktický Datum</p>
                      <p className="text-xs font-black font-mono">{selectedDate}</p>
                    </div>
                    <button onClick={() => navigateDate('next')} disabled={selectedDate === today} className={`p-2 rounded-xl transition-all active:scale-90 ${selectedDate === today ? 'opacity-20 cursor-not-allowed' : 'hover:bg-white/10 text-slate-400 hover:text-white'}`}><ChevronRight size={20} /></button>
                  </div>
                </div>
                <p className="text-slate-500 font-black uppercase text-[9px] tracking-[0.3em]">
                  Chronological Feed • Trace Engine
                </p>
              </div>
            </div>

            <div id="tactical-timeline-anchor" />
            <TacticalTimeline
              date={selectedDate}
              prep={currentPrep}
              review={currentReview}
              trades={currentTrades}
              theme={theme}
              autoExpand={autoExpand}
              onAutoExpandConsumed={() => setAutoExpand(null)}
              onEditPrep={() => setView('edit-prep')}
              onEditReview={() => setView('edit-review')}
              onDeletePrep={onDeletePrep}
              onDeleteReview={onDeleteReview}
              sessions={sessions}
              sessionBreakdowns={reviewForm.sessionBreakdowns}
              onUpdateBreakdown={handleUpdateBreakdown}
              prepForm={prepForm}
              reviewForm={reviewForm}
              editPrepForm={editPrepForm as any}
              editReviewForm={editReviewForm as any}
              onSavePrep={onSavePrep}
              onSaveReview={onSaveReview}
              rituals={rituals}
              tradeRules={tradeRules}
              psychoMetrics={psychoMetrics}
              currentWeekFocus={currentWeekFocus}
              isSaving={isSaving}
              lastSaved={lastSaved}
            />
          </div>

          {/* Sidebar: Stats — slim s hover expand */}
          <div className="lg:sticky lg:top-24 order-1 lg:order-2 group/disc relative z-40 hover:z-50">
            {/* Slim collapsed view — streak + mini heatmap */}
            <div className="lg:flex hidden flex-col items-center gap-2 p-2 rounded-2xl border bg-[var(--bg-card)]/60 border-[var(--border-subtle)] backdrop-blur-md cursor-pointer transition-all group-hover/disc:opacity-0 group-hover/disc:pointer-events-none">
              {(() => {
                // Vypočti streak + heatmap pro posledních 20 weekday dní
                const todayDate = new Date(today);
                let streak = 0;
                for (let i = 0; i < 30; i++) {
                  const d = new Date(todayDate); d.setDate(d.getDate() - i);
                  const ds = d.toLocaleDateString('en-CA');
                  const prep = preps.find(p => p.date === ds);
                  const review = reviews.find(r => r.date === ds);
                  if (prep?.completed && review?.completed) streak++;
                  else if (i > 0) break; // dnes se počítá i pokud není dokončeno
                }
                // Heatmap: posledních 20 weekday dní (Po–Pá)
                const heatmapDays: { ds: string; status: 'full' | 'partial' | 'trades-only' | 'none' }[] = [];
                let cursor = new Date(todayDate);
                while (heatmapDays.length < 20) {
                  const dow = cursor.getDay();
                  if (dow !== 0 && dow !== 6) {
                    const ds = cursor.toLocaleDateString('en-CA');
                    const hasPrep = preps.some(p => p.date === ds && p.completed);
                    const hasReview = reviews.some(r => r.date === ds && r.completed);
                    const hasTrades = groupedTrades.some(t => t.date.startsWith(ds));
                    let status: 'full' | 'partial' | 'trades-only' | 'none' = 'none';
                    if (hasPrep && hasReview) status = 'full';
                    else if (hasPrep || hasReview) status = 'partial';
                    else if (hasTrades) status = 'trades-only';
                    heatmapDays.unshift({ ds, status });
                  }
                  cursor.setDate(cursor.getDate() - 1);
                }
                const colorClass = (s: string) => s === 'full' ? 'bg-emerald-500' : s === 'partial' ? 'bg-amber-500' : s === 'trades-only' ? 'bg-rose-500' : (theme !== 'light' ? 'bg-white/5' : 'bg-slate-200');
                return (
                  <>
                    <div className="text-[7px] font-black uppercase tracking-widest text-slate-500">Score</div>
                    <div className="w-9 h-9 rounded-full border-[3px] border-slate-200 dark:border-slate-700 flex items-center justify-center">
                      <span className="text-xs font-black text-blue-500">{streak}</span>
                    </div>
                    <div className="text-[7px] font-black uppercase text-orange-500 tracking-widest">🔥 streak</div>

                    {/* Mini heatmap 2×10 */}
                    <div className="grid grid-cols-2 gap-0.5 mt-1 w-full px-1" title="Posledních 20 obchodních dní">
                      {heatmapDays.map((d, i) => (
                        <div
                          key={i}
                          title={d.ds}
                          className={`aspect-square w-full rounded-[2px] ${colorClass(d.status)}`}
                        />
                      ))}
                    </div>
                    <div className="mt-1 text-[7px] font-black text-slate-400 tracking-tighter">HOVER →</div>
                  </>
                );
              })()}
            </div>

            {/* Expanded full dashboard — viditelné na hover */}
            <div className="hidden lg:block absolute right-0 top-0 w-[320px] opacity-0 group-hover/disc:opacity-100 pointer-events-none group-hover/disc:pointer-events-auto transition-opacity duration-200 z-[60] shadow-2xl rounded-2xl">
              <DisciplineDashboard theme={theme} preps={preps} reviews={reviews} trades={groupedTrades} ironRules={ironRules} />
            </div>

            {/* Mobile: rovnou plně viditelné */}
            <div className="lg:hidden">
              <DisciplineDashboard theme={theme} preps={preps} reviews={reviews} trades={groupedTrades} ironRules={ironRules} />
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className={`flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b pb-6 ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
            <div className="space-y-2">
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6">
                <h2 className="text-3xl md:text-5xl font-black tracking-tighter italic flex items-center gap-4">
                  {activeTab === 'daily' ? 'DENNÍ PŘEHLED' : (activeTab === 'weekly' ? 'WEEKLY HUB' : 'DENÍK')}
                  {activeTab === 'archives' && (
                    <button
                      onClick={() => setIsExportModalOpen(true)}
                      className={`p-2 rounded-xl transition-all hover:scale-105 active:scale-95 flex items-center justify-center shadow-lg ${theme !== 'light' ? 'bg-blue-600 text-white shadow-blue-500/20' : 'bg-blue-600 text-white shadow-blue-500/20'}`}
                      title="Export Report"
                    >
                      <Download size={20} />
                    </button>
                  )}
                </h2>
                {activeTab !== 'archives' && (
                  <div className="flex items-center gap-2 theme-card p-1 rounded-2xl border theme-border shadow-inner">
                    <button onClick={() => activeTab === 'daily' ? navigateDate('prev') : navigateWeek('prev')} className="p-2 hover:bg-white/10 rounded-xl theme-text-secondary hover:text-[var(--text-primary)] transition-all active:scale-90"><ChevronLeft size={20} /></button>
                    <div className="px-3 py-1 text-center min-w-[100px]">
                      <p className="text-[8px] font-black text-blue-500 uppercase tracking-[0.2em] mb-0.5">{activeTab === 'daily' ? 'Taktický Datum' : `Týden ${currentWeekInfo.weekNumber}`}</p>
                      <p className="text-xs font-black font-mono">{activeTab === 'daily' ? selectedDate : currentWeekInfo.mondayDate}</p>
                    </div>
                    <button onClick={() => activeTab === 'daily' ? navigateDate('next') : navigateWeek('next')} disabled={activeTab === 'daily' && selectedDate === today} className={`p-2 rounded-xl transition-all active:scale-90 ${activeTab === 'daily' && selectedDate === today ? 'opacity-20 cursor-not-allowed' : 'hover:bg-white/10 text-slate-400 hover:text-white'}`}><ChevronRight size={20} /></button>
                  </div>
                )}
              </div>
              <p className="text-slate-500 font-black uppercase text-[9px] tracking-[0.3em]">
                {activeTab === 'daily' ? `Chronological Feed • Trace Engine` : (activeTab === 'weekly' ? `Weekly Debrief • Týden ${currentWeekInfo.weekNumber} ` : `Psycho Archives • Emoční Historie`)}
              </p>
            </div>
            <div className="flex gap-2 w-full sm:w-auto items-center">
              {view !== 'timeline' && (
                <>
                  <button onClick={() => handleNavigateWithCheck(() => setView('timeline'))} className={`flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl font-bold text-xs transition-all active:scale-95 ${theme !== 'light' ? 'bg-[var(--bg-card)] text-slate-300 border border-[var(--border-subtle)] hover:bg-[var(--bg-page)]' : 'bg-slate-800 text-white hover:bg-slate-700'}`}><LayoutGrid size={14} /> Feed</button>

                  {/* Save Button with Status */}
                  <button
                    onClick={handleManualSave}
                    disabled={!hasUnsavedChanges && saveStatus !== 'saving'}
                    className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold text-xs transition-all active:scale-95 ${saveStatus === 'saving'
                      ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                      : saveStatus === 'saved'
                        ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                        : saveStatus === 'error'
                          ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                          : hasUnsavedChanges
                            ? 'bg-orange-500 text-white shadow-lg shadow-orange-500/20 hover:bg-orange-400'
                            : 'bg-[var(--bg-card)] text-slate-500 border border-[var(--border-subtle)] opacity-50 cursor-not-allowed'
                      }`}
                  >
                    {saveStatus === 'saving' ? (
                      <><Loader2 size={14} className="animate-spin" /> Ukládám...</>
                    ) : saveStatus === 'saved' ? (
                      <><Check size={14} /> Uloženo</>
                    ) : saveStatus === 'error' ? (
                      <><AlertTriangle size={14} /> Chyba uložení</>
                    ) : (
                      <><Save size={14} /> Uložit</>
                    )}
                  </button>
                </>
              )}
            </div>
          </div>

          {activeTab === 'daily' && view === 'timeline' && (
            <TacticalTimeline
              date={selectedDate}
              prep={currentPrep}
              review={currentReview}
              trades={currentTrades}
              theme={theme}
              autoExpand={autoExpand}
              onAutoExpandConsumed={() => setAutoExpand(null)}
              onEditPrep={() => setView('edit-prep')}
              onEditReview={() => setView('edit-review')}
              onDeletePrep={onDeletePrep}
              onDeleteReview={onDeleteReview}
              sessions={sessions}
              sessionBreakdowns={reviewForm.sessionBreakdowns}
              onUpdateBreakdown={handleUpdateBreakdown}
              prepForm={prepForm}
              reviewForm={reviewForm}
              editPrepForm={editPrepForm as any}
              editReviewForm={editReviewForm as any}
              onSavePrep={onSavePrep}
              onSaveReview={onSaveReview}
              rituals={rituals}
              tradeRules={tradeRules}
              psychoMetrics={psychoMetrics}
              currentWeekFocus={currentWeekFocus}
              isSaving={isSaving}
              lastSaved={lastSaved}
            />
          )}
        </>
      )}

      {activeTab === 'weekly' && view === 'timeline' && (
        <WeeklyOverview
          weekDays={currentWeekInfo.days}
          weekNumber={currentWeekInfo.weekNumber}
          trades={groupedTrades}
          preps={preps}
          reviews={reviews}
          ironRules={ironRules}
          psychoMetrics={psychoMetrics}
          sessions={sessions}
          weeklyFocus={currentWeekFocus}
          theme={theme}
          today={today}
          onEditPrep={(date) => {
            // Pre-load prep data synchronously to prevent empty form flash
            const targetPrep = preps.find(p => p.date === date);
            if (targetPrep) {
              skipAutoSavePrep.current = true;
              prepFormDirty.current = false;
              setPrepForm(targetPrep);
            }
            setSelectedDate(date);
            setView('timeline'); // zůstaneme na timeline — TacticalTimeline rozbalí prep inline
            setAutoExpand('prep');
            onTabChange('daily');
          }}
          onEditReview={(date) => {
            const targetReview = reviews.find(r => r.date === date);
            if (targetReview) {
              skipAutoSaveReview.current = true;
              reviewFormDirty.current = false;
              setReviewForm(targetReview);
            }
            setSelectedDate(date);
            setView('timeline');
            setAutoExpand('review');
            onTabChange('daily');
          }}
        />
      )}

      {activeTab === 'archives' && (
        <div className="space-y-6 lg:space-y-8 animate-in fade-in slide-in-from-right-4 duration-500 print:bg-white print:p-0">

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 text-left print:grid-cols-1 print:gap-10">
            {reviews
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
              .map(review => {
                const dayTrades = groupedTrades.filter(t => t.date.startsWith(review.date));
                const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);

                return (
                  <div key={review.id} className={`p-6 rounded-[32px] border relative overflow-hidden flex flex-col h-full ${theme !== 'light' ? 'bg-[var(--bg-card)]/40 border-[var(--border-subtle)] hover:border-blue-500/30' : 'bg-white border-slate-200 shadow-sm hover:shadow-xl'} transition-all group`}>
                    <div className="flex justify-between items-start mb-6">
                      <div>
                        <p className="text-[10px] font-black uppercase text-blue-500 mb-1 tracking-widest">{new Date(review.date).toLocaleDateString('cs-CZ', { weekday: 'long' })}</p>
                        <h4 className={`text-xl font-black italic tracking-tighter uppercase ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>{new Date(review.date).toLocaleDateString('cs-CZ')}</h4>
                      </div>
                      <div className={`px-3 py-1 rounded-full text-[9px] font-black tracking-widest uppercase ${dayPnl >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                        ${dayPnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </div>
                    </div>

                    {review.psycho && (
                      <div className="grid grid-cols-2 gap-3 mb-6">
                        {psychoMetrics?.map(metric => {
                          const val = review.psycho?.metrics?.[metric.id] || 5;
                          return (
                            <div key={metric.id} className={`p-3 rounded-2xl ${theme !== 'light' ? 'bg-[var(--bg-page)]/50' : 'bg-slate-50'}`}>
                              <p className="text-[8px] font-black text-slate-500 mb-1">{metric.label}</p>
                              <div className="flex items-center gap-2">
                                <div className={`h-1 flex-1 rounded-full overflow-hidden ${theme !== 'light' ? 'bg-[var(--bg-card)]' : 'bg-slate-100'}`}>
                                  <div className="h-full" style={{ width: `${val * 10}% `, backgroundColor: metric.color }} />
                                </div>
                                <span className={`text-[10px] font-black ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>{val}/10</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="space-y-4 flex-1">
                      {review.psycho?.stressors && (
                        <div className="space-y-1">
                          <p className="text-[8px] font-black uppercase text-rose-500 flex items-center gap-1.5"><AlertCircle size={10} /> Stresory</p>
                          <p className="text-[11px] text-slate-400 leading-relaxed italic">"{review.psycho.stressors}"</p>
                        </div>
                      )}

                      {review.psycho?.gratitude && (
                        <div className="space-y-1">
                          <p className="text-[8px] font-black uppercase text-emerald-500 flex items-center gap-1.5"><Sun size={10} /> Vděčnost</p>
                          <p className="text-[11px] text-slate-400 leading-relaxed italic">"{review.psycho.gratitude}"</p>
                        </div>
                      )}

                      <div className="space-y-1">
                        <p className="text-[8px] font-black uppercase text-slate-500 flex items-center gap-1.5"><FileText size={10} /> Reflexe & Poznámky</p>
                        <p className={`text-[11px] leading-relaxed line-clamp-4 whitespace-pre-wrap ${theme !== 'light' ? 'text-slate-300' : 'text-slate-600'}`}>{review.psycho?.notes}</p>
                      </div>
                    </div>

                    <button
                      onClick={() => { setSelectedDate(review.date); setView('timeline'); onTabChange('daily'); window.scrollTo(0, 0); }}
                      className="mt-6 w-full py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-[9px] font-black uppercase tracking-widest transition-all shadow-lg shadow-blue-600/10"
                    >
                      Otevřít Detail
                    </button>
                  </div>
                );
              })}

            {reviews.length === 0 && (
              <div className={`col-span-full h-64 flex flex-col items-center justify-center border-2 border-dashed rounded-[40px] opacity-30 ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-200'}`}>
                <History size={48} className="mb-4" />
                <p className="text-xl font-black uppercase tracking-[0.2em]">Žádné záznamy k zobrazení</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* EDIT FORMS — now rendered inline in TacticalTimeline */}
      {false && (
        <div className="max-w-7xl mx-auto animate-in slide-in-from-right-4 duration-500">
          {view === 'edit-prep' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
              {/* Left Column: Tactical Hub */}
              <div className="lg:col-span-8 space-y-6 lg:space-y-8 order-2 lg:order-1">
                <section className={`p-6 md:p-10 rounded-[40px] border relative overflow-hidden transition-all duration-700 ${theme !== 'light' ? 'bg-slate-900/40 border-slate-800 backdrop-blur-xl' : 'bg-white/80 border-slate-200 backdrop-blur-md shadow-2xl shadow-slate-200/50'}`}>
                  {/* Background Glow */}
                  <div className={`absolute -top-40 -right-40 w-80 h-80 rounded-full blur-[120px] pointer-events-none opacity-20 bg-blue-500`} />

                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-8 mb-10 relative z-10">
                    <div className="flex items-center gap-5">
                      <div className={`p-4 rounded-2xl bg-blue-500/10 text-blue-500`}>
                        <Sparkles size={24} className="animate-pulse" />
                      </div>
                      <div>
                        <h3 className="text-2xl md:text-3xl font-black italic uppercase tracking-tight">SESSION ANALÝZA</h3>
                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.3em] opacity-70">Taktické plánování seancí</p>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-3">
                      <div className="flex items-center gap-2">
                        {isSaving ? (
                          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 text-blue-500 animate-pulse">
                            <div className="w-2 h-2 rounded-full bg-blue-500" />
                            <span className="text-[9px] font-black uppercase tracking-widest">Ukládám...</span>
                          </div>
                        ) : lastSaved ? (
                          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 text-emerald-500 transition-all duration-1000">
                            <Check size={12} />
                            <span className="text-[9px] font-black uppercase tracking-widest">Uloženo {lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                        ) : null}
                      </div>

                      {/* Tactical Tabs Switcher */}
                      <div className={`flex items-center p-1.5 rounded-[20px] border transition-all duration-500 ${theme !== 'light' ? 'bg-black/40 border-slate-800' : 'bg-slate-100 border-slate-200'}`}>
                        {prepForm.scenarios.sessions?.map((session) => {
                          const isActive = activeSessionTab === session.id;
                          const sessionColor = session.color || '#3b82f6'; // Default to blue
                          return (
                            <button
                              key={session.id}
                              onClick={() => setActiveSessionTab(session.id)}
                              className={`relative px-6 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all duration-300 ${isActive ? 'text-white' : 'text-slate-500 hover:text-slate-400 hover:bg-white/5'}`}
                            >
                              {isActive && (
                                <motion.div
                                  layoutId="activeSessionHubTab"
                                  className="absolute inset-0 rounded-2xl z-0"
                                  style={{ backgroundColor: sessionColor, boxShadow: `0 10px 15px -3px ${sessionColor}40, 0 4px 6px -4px ${sessionColor}40` }}
                                  transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                                />
                              )}
                              <span className="relative z-10">{session.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Focused Workspace for Single Active Session */}
                  <div className="relative z-10">
                    {prepForm.scenarios.sessions?.filter(s => s.id === activeSessionTab).map((session, idx) => {
                      const isEU = session.label.toLowerCase().includes('lon') || session.label.toLowerCase().includes('eu');
                      const isUS = session.label.toLowerCase().includes('ny') || session.label.toLowerCase().includes('us');
                      const accentColor = isEU ? 'blue' : isUS ? 'amber' : 'slate';

                      return (
                        <div key={session.id || idx} className={`group p-6 md:p-8 rounded-[36px] border transition-all duration-500 flex flex-col xl:flex-row gap-8 ${theme !== 'light' ? `bg-slate-900/60 border-slate-800` : `bg-white border-slate-100 shadow-xl shadow-slate-200/20`}`}>

                          {/* Left Side: Screenshot */}
                          <div className="w-full xl:w-[55%] space-y-4">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className={`w-2 h-2 rounded-full animate-pulse ${accentColor === 'blue' ? 'bg-blue-400' : accentColor === 'amber' ? 'bg-amber-400' : 'bg-slate-400'}`} />
                                <span className="text-[11px] font-black tracking-[0.2em] text-slate-500">{session.label} Analysis</span>
                              </div>
                              {session.image && (
                                <button
                                  onClick={() => setPrepForm(prev => ({
                                    ...prev,
                                    scenarios: {
                                      ...prev.scenarios,
                                      sessions: prev.scenarios.sessions?.map(s => s.id === session.id ? { ...s, image: '' } : s)
                                    }
                                  }))}
                                  className="px-3 py-1.5 bg-rose-500/10 text-rose-500 rounded-xl text-[9px] font-black uppercase tracking-widest hover:bg-rose-500 hover:text-white transition-all duration-300"
                                >
                                  Clear
                                </button>
                              )}
                            </div>

                            <div
                              onClick={() => setActiveImageField(`session_${session.id}`)}
                              className={`relative aspect-video rounded-3xl border-2 border-dashed overflow-hidden transition-all duration-500 flex flex-col items-center justify-center cursor-pointer ${activeImageField === `session_${session.id}`
                                ? 'border-blue-500 bg-blue-500/5 ring-8 ring-blue-500/5'
                                : theme !== 'light'
                                  ? 'border-slate-800/50 bg-theme-card-40 group-hover:bg-slate-900/40'
                                  : 'border-slate-200 bg-slate-50 group-hover:bg-slate-100/50 shadow-inner'
                                }`}
                            >
                              {session.image ? (
                                <>
                                  <img src={session.image} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
                                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all duration-300 flex items-center justify-center">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setZoomImg(session.image!); }}
                                      className="p-3 rounded-xl bg-black/50 backdrop-blur-md text-white border border-white/10 hover:bg-blue-600 transition-all shadow-xl opacity-0 group-hover:opacity-100"
                                    >
                                      <Maximize2 size={18} />
                                    </button>
                                  </div>
                                </>
                              ) : (
                                <div className="text-center p-6">
                                  <div className={`w-12 h-12 rounded-full mx-auto mb-4 flex items-center justify-center transition-all duration-500 ${activeImageField === `session_${session.id}` ? 'bg-blue-500 text-white' : 'bg-slate-800/50 text-slate-600'}`}>
                                    <ImageIcon size={20} />
                                  </div>
                                  <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest mb-1">Visual Analysis</p>
                                  <p className="text-[7px] font-bold text-slate-600 uppercase italic">CTRL+V to paste</p>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Right Side: Game Plan */}
                          <div className="w-full xl:w-[45%] flex flex-col">
                            <div className="flex items-center gap-2 mb-4 opacity-50">
                              <FileText size={12} className="text-slate-500" />
                              <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">Tactical Game Plan</span>
                            </div>
                            <textarea
                              value={session.plan}
                              onChange={(e) => setPrepForm(prev => ({
                                ...prev,
                                scenarios: {
                                  ...prev.scenarios,
                                  sessions: prev.scenarios.sessions?.map(s => s.id === session.id ? { ...s, plan: e.target.value } : s)
                                }
                              }))}
                              placeholder="Tvůj plán pro tuto seanci..."
                              className={`w-full flex-1 min-h-[220px] rounded-3xl p-6 border focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/30 text-sm leading-relaxed transition-all placeholder:text-slate-500 ${theme !== 'light' ? 'bg-theme-card-40 border-slate-800/50 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700 shadow-inner'}`}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Legacy Data Footnote */}
                  {(prepForm.scenarios.bullish || prepForm.scenarios.bearish) && (
                    <div className="mt-8 p-5 rounded-[28px] bg-slate-800/30 border border-slate-800/50 backdrop-blur-sm relative z-10">
                      <div className="flex items-center gap-3 mb-3">
                        <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500"><AlertTriangle size={14} /></div>
                        <p className="text-[10px] font-black uppercase text-amber-500/80 tracking-widest">Legacy Analysis Records</p>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 opacity-60">
                        {prepForm.scenarios.bullish && <div className="space-y-1"><p className="text-[8px] font-black uppercase text-slate-600">Bullish Scenario</p><p className="text-[11px] text-slate-400 italic font-medium leading-relaxed">"{prepForm.scenarios.bullish}"</p></div>}
                        {prepForm.scenarios.bearish && <div className="space-y-1"><p className="text-[8px] font-black uppercase text-slate-600">Bearish Scenario</p><p className="text-[11px] text-slate-400 italic font-medium leading-relaxed">"{prepForm.scenarios.bearish}"</p></div>}
                      </div>
                    </div>
                  )}

                  <div className="mt-8 relative z-10">
                    <button
                      onClick={() => {
                        // Same fix as Review: update local state FIRST so debounced autosave can't overwrite completed:true.
                        const completed = { ...prepForm, completed: true };
                        skipAutoSavePrep.current = true;
                        setPrepForm(completed);
                        onSavePrep(completed);
                        prepFormDirty.current = false;
                        setHasUnsavedChanges(false);
                        setView('timeline');
                        window.scrollTo(0, 0);
                      }}
                      className={`w-full py-5 rounded-[24px] font-black text-[12px] uppercase tracking-[0.3em] text-white shadow-2xl active:scale-95 transition-all duration-500 bg-blue-600 hover:bg-blue-500 shadow-blue-500/30`}
                    >
                      DOKONČIT PŘÍPRAVU
                    </button>
                  </div>
                </section>
              </div>

              {/* Right Column: Bias + Rituals + Confidence */}
              <div className="lg:col-span-4 space-y-6 order-1 lg:order-2">

                {/* Market Bias selector */}
                <section className={`p-6 rounded-[32px] border ${theme !== 'light' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-xl shadow-slate-200/20'}`}>
                  <div className="flex items-center gap-3 mb-5">
                    <div className={`p-3 rounded-2xl ${prepForm.bias === 'Bullish' ? 'bg-emerald-500/10 text-emerald-500' : prepForm.bias === 'Bearish' ? 'bg-rose-500/10 text-rose-500' : 'bg-slate-500/10 text-slate-400'}`}>
                      <TrendingUp size={20} />
                    </div>
                    <div>
                      <h3 className="text-xl font-black italic uppercase">MARKET BIAS</h3>
                      <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Dnešní tržní pohled</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(['Bullish', 'Neutral', 'Bearish'] as const).map(b => {
                      const isActive = prepForm.bias === b;
                      const colors = {
                        Bullish: isActive ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg shadow-emerald-600/25' : (theme !== 'light' ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-slate-500 hover:border-emerald-500/30 hover:text-emerald-400' : 'bg-slate-50 border-slate-200 text-slate-500 hover:border-emerald-300 hover:text-emerald-600'),
                        Neutral:  isActive ? 'bg-slate-600 border-slate-500 text-white shadow-lg shadow-slate-600/25' : (theme !== 'light' ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-slate-500 hover:border-slate-500 hover:text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-500 hover:border-slate-400 hover:text-slate-600'),
                        Bearish:  isActive ? 'bg-rose-600 border-rose-500 text-white shadow-lg shadow-rose-600/25' : (theme !== 'light' ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-slate-500 hover:border-rose-500/30 hover:text-rose-400' : 'bg-slate-50 border-slate-200 text-slate-500 hover:border-rose-300 hover:text-rose-600'),
                      };
                      const emoji = { Bullish: '🐂', Neutral: '⚖️', Bearish: '🐻' };
                      return (
                        <button
                          key={b}
                          onClick={() => editPrepForm(prev => ({ ...prev, bias: b }))}
                          className={`py-3 rounded-2xl border font-black text-[10px] uppercase tracking-widest transition-all active:scale-95 flex flex-col items-center gap-1 ${colors[b]}`}
                        >
                          <span className="text-lg">{emoji[b]}</span>
                          <span>{b}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border ${theme !== 'light' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-xl shadow-slate-200/20'}`}>
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-4">
                      <div className="p-3 rounded-2xl bg-blue-500/10 text-blue-500"><Zap size={20} /></div>
                      <div>
                        <h3 className="text-xl font-black italic uppercase">RANNÍ CHECKLIST</h3>
                        <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Aktivace před trhy</p>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    {rituals.map(ritual => {
                      const comp = prepForm.ritualCompletions?.find(c => c.ruleId === ritual.id);
                      const isDone = comp?.status === 'Pass';
                      return (
                        <button
                          key={ritual.id}
                          onClick={() => handleToggleRitual(ritual.id)}
                          className={`p-4 rounded-xl border flex items-center justify-between transition-all active:scale-95 ${isDone ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg shadow-emerald-600/20' : (theme !== 'light' ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-600')} `}
                        >
                          <span className="text-[10px] font-black uppercase tracking-tight text-left pr-2">{ritual.label}</span>
                          {isDone ? <Check size={16} /> : <div className={`w-4 h-4 rounded-full border shrink-0 ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'bg-slate-200'} `} />}
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Confidence slider */}
                <section className={`p-6 rounded-[32px] border ${theme !== 'light' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-xl shadow-slate-200/20'}`}>
                  <div className="flex items-center gap-4 mb-5">
                    <div className="p-3 rounded-2xl bg-violet-500/10 text-violet-500"><Brain size={20} /></div>
                    <div>
                      <h3 className="text-xl font-black italic uppercase">SEBEVĚDOMÍ</h3>
                      <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Jak se dnes cítíš?</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[10px] font-bold text-slate-500">0%</span>
                    <span className={`text-3xl font-black tabular-nums ${prepForm.confidence >= 70 ? 'text-emerald-400' : prepForm.confidence >= 40 ? 'text-amber-400' : 'text-rose-400'}`}>
                      {prepForm.confidence}%
                    </span>
                    <span className="text-[10px] font-bold text-slate-500">100%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={prepForm.confidence}
                    onChange={(e) => editPrepForm(prev => ({ ...prev, confidence: Number(e.target.value) }))}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                    style={{
                      accentColor: prepForm.confidence >= 70 ? '#10b981' : prepForm.confidence >= 40 ? '#f59e0b' : '#f43f5e',
                      background: `linear-gradient(to right, ${prepForm.confidence >= 70 ? '#10b981' : prepForm.confidence >= 40 ? '#f59e0b' : '#f43f5e'} ${prepForm.confidence}%, ${theme !== 'light' ? '#1e293b' : '#e2e8f0'} ${prepForm.confidence}%)`
                    }}
                  />
                  <div className="flex justify-between mt-2">
                    <span className="text-[9px] text-slate-600">Špatný den</span>
                    <span className="text-[9px] text-slate-600">Top forma</span>
                  </div>
                </section>

                <div className="p-6 rounded-[32px] bg-blue-500/5 border border-blue-500/10 backdrop-blur-sm">
                  <div className="flex items-center gap-3 mb-2">
                    <Info size={14} className="text-blue-500" />
                    <p className="text-[10px] font-black uppercase text-blue-500 tracking-widest">Command Center</p>
                  </div>
                  <p className="text-[10px] text-slate-500 leading-relaxed font-medium">Dokonči ranní rituály a vypiluj taktický plán pro nadcházející seanci.</p>
                </div>
              </div>
            </div>
          )}
          {view === 'edit-review' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start animate-in slide-in-from-right-4 duration-500">
              {/* --- COLUMN 1: CHECKLISTS & ACTION --- */}
              <div className="space-y-6">
                {/* EXECUTION AUDIT - Compact Grid */}
                <section className={`p-6 rounded-[32px] border ${theme !== 'light' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-500"><ShieldAlert size={18} /></div>
                      <div>
                        <h3 className="text-lg font-black italic uppercase">EXECUTION</h3>
                        <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest">Dodržení pravidel</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {isSaving ? (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 text-blue-500 animate-pulse">
                          <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                          <span className="text-[8px] font-black uppercase tracking-widest">Saving...</span>
                        </div>
                      ) : lastSaved ? (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 text-emerald-500">
                          <Check size={10} />
                          <span className="text-[8px] font-black uppercase tracking-widest">{lastSaved.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {tradeRules.map(rule => {
                      const comp = reviewForm.ruleAdherence?.find(a => a.ruleId === rule.id);
                      const status = comp?.status || 'Pending';
                      return (
                        <div key={rule.id} className={`p-3 rounded-xl border flex flex-col justify-between gap-3 ${theme !== 'light' ? 'bg-[var(--bg-page)]/50 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-200'} `}>
                          <h4 className="text-[9px] font-black uppercase tracking-widest leading-tight h-7 line-clamp-2">{rule.label}</h4>
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => handleSetRuleStatus(rule.id, 'Pass')}
                              className={`flex-1 py-1.5 rounded-lg font-black text-[8px] uppercase tracking-widest transition-all ${status === 'Pass' ? 'bg-emerald-600 text-white' : (theme !== 'light' ? 'bg-[var(--bg-card)] text-slate-500 hover:bg-white/5' : 'bg-white text-slate-400 hover:bg-slate-100 shadow-sm')} `}
                            >
                              Pass
                            </button>
                            <button
                              onClick={() => handleSetRuleStatus(rule.id, 'Fail')}
                              className={`flex-1 py-1.5 rounded-lg font-black text-[8px] uppercase tracking-widest transition-all ${status === 'Fail' ? 'bg-rose-600 text-white' : (theme !== 'light' ? 'bg-[var(--bg-card)] text-slate-500 hover:bg-white/5' : 'bg-white text-slate-400 hover:bg-slate-100 shadow-sm')} `}
                            >
                              Fail
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* WEEKLY FOCUS - Compact Checklist */}
                  {currentWeekFocus && (
                    <div className={`mt-6 p-5 rounded-[28px] border ${theme !== 'light' ? 'bg-emerald-500/5 border-emerald-500/10' : 'bg-emerald-50 border-emerald-100'}`}>
                      <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 rounded-lg bg-emerald-500 text-white"><ClipboardCheck size={14} /></div>
                        <h4 className="text-[10px] font-black uppercase tracking-widest text-emerald-500">Weekly Focus</h4>
                      </div>
                      <div className="space-y-1.5">
                        {currentWeekFocus.goals.map((goal, idx) => {
                          const adherence = reviewForm.weeklyGoalAdherence?.[idx]?.status === 'Pass';
                          return (
                            <button
                              key={idx}
                              onClick={() => {
                                editReviewForm(prev => {
                                  const newList = [...(prev.weeklyGoalAdherence || [])];
                                  while (newList.length <= idx) newList.push({ ruleId: `wf_${idx}`, status: 'Pending' });
                                  newList[idx] = { ruleId: `wf_${idx}`, status: adherence ? 'Pending' : 'Pass' };
                                  return { ...prev, weeklyGoalAdherence: newList };
                                });
                              }}
                              className={`w-full px-4 py-2.5 rounded-xl border flex items-center justify-between transition-all group ${adherence
                                ? 'bg-emerald-500 text-white border-emerald-400 shadow-sm'
                                : (theme !== 'light' ? 'bg-[var(--bg-input)]/50 border-[var(--border-subtle)]' : 'bg-white border-slate-100 shadow-sm')
                                }`}
                            >
                              <div className="flex items-center gap-3">
                                <span className={`text-xs ${adherence ? 'filter-none' : 'grayscale opacity-50'}`}>{goal.emoji || '🎯'}</span>
                                <span className={`text-[10px] font-black tracking-tight ${adherence ? 'text-white' : 'text-slate-400'}`}>{goal.text}</span>
                              </div>
                              {adherence && <Check size={10} strokeWidth={4} />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="mt-6">
                    <button
                      onClick={() => {
                        // Update local state FIRST so subsequent autosaves carry completed:true.
                        // Otherwise the 2s debounced autosave fires with the stale form and overwrites DB back to undefined.
                        const completed = { ...reviewForm, completed: true };
                        skipAutoSaveReview.current = true; // suppress imminent autosave for this state transition
                        setReviewForm(completed);
                        onSaveReview(completed);
                        reviewFormDirty.current = false;
                        setHasUnsavedChanges(false);
                        setView('timeline');
                        window.scrollTo(0, 0);
                      }}
                      className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl shadow-indigo-500/20 active:scale-95 transition-all"
                    >
                      DOKONČIT REVIEW
                    </button>
                  </div>
                </section>
              </div>

              {/* --- COLUMN 2: PSYCHO & REFLECTIONS --- */}
              <div className="space-y-6">
                <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border relative overflow-hidden ${theme !== 'light' ? 'bg-indigo-950/10 border-indigo-500/20' : 'bg-indigo-50 border-indigo-200 shadow-sm'}`}>
                  <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />
                  <div className="flex items-center gap-4 mb-6 relative z-10">
                    <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-500"><Brain size={18} /></div>
                    <div>
                      <h3 className="text-lg font-black italic uppercase">PSYCHO-CYBERNETICS</h3>
                      <p className="text-[8px] font-black uppercase text-indigo-500 tracking-widest">Mindset & Emoční Audit</p>
                    </div>
                  </div>

                  <div className="space-y-6 relative z-10">
                    {/* Dynamic Metrics Sliders - Compact 2-col */}
                    <div className="grid grid-cols-2 gap-3">
                      {psychoMetrics?.map(metric => {
                        const value = reviewForm.psycho?.metrics?.[metric.id] || 5;
                        return (
                          <div key={metric.id} className={`p-4 rounded-2xl border ${theme !== 'light' ? 'bg-[var(--bg-page)]/50 border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                            <div className="flex justify-between items-center mb-3">
                              <label className="text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
                                <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: metric.color }} />
                                {metric.label}
                              </label>
                              <span className="text-[10px] font-black text-blue-500">{value}/10</span>
                            </div>
                            <input
                              type="range" min="1" max="10" step="1"
                              value={value}
                              onChange={(e) => {
                                const newMetrics = { ...reviewForm.psycho?.metrics, [metric.id]: Number(e.target.value) };
                                editReviewForm({ ...reviewForm, psycho: { ...reviewForm.psycho!, metrics: newMetrics } });
                              }}
                              className={`w-full h-1.5 rounded-lg appearance-none cursor-pointer ${theme !== 'light' ? 'bg-[var(--bg-card)]' : 'bg-slate-200'}`}
                              style={{ accentColor: metric.color }}
                            />
                          </div>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className={`${labelClass} text-rose-500 text-[9px]`}>Stresory & Spouštěče</label>
                        <textarea
                          value={reviewForm.psycho?.stressors || ''}
                          onChange={(e) => editReviewForm({ ...reviewForm, psycho: { ...reviewForm.psycho!, stressors: e.target.value } })}
                          className={`${inputClass} !h-20 !p-3 resize-none text-[11px]`}
                          placeholder="Co mě rozhodilo?"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className={`${labelClass} text-emerald-500 text-[9px]`}>Vděčnost & Radost</label>
                        <textarea
                          value={reviewForm.psycho?.gratitude || ''}
                          onChange={(e) => editReviewForm({ ...reviewForm, psycho: { ...reviewForm.psycho!, gratitude: e.target.value } })}
                          className={`${inputClass} !h-20 !p-3 resize-none text-[11px]`}
                          placeholder="Co se povedlo?"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className={`${labelClass} text-[9px]`}>Osobní Deník</label>
                      <div className="flex gap-2 mb-2">
                        <input
                          type="text"
                          value={quickNote}
                          onChange={(e) => setQuickNote(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && addQuickNote()}
                          placeholder="Rychlý zápis..."
                          className={`${inputClass} flex-1 !h-8 !px-3 text-[11px]`}
                        />
                        <button
                          onClick={addQuickNote}
                          className="px-3 bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-all font-black uppercase text-[8px]"
                        >
                          Zapsat
                        </button>
                      </div>
                      <textarea
                        value={reviewForm.psycho?.notes || ''}
                        onChange={(e) => editReviewForm({ ...reviewForm, psycho: { ...reviewForm.psycho!, notes: e.target.value } })}
                        className={`${inputClass} !h-24 !p-3 resize-none font-mono text-[10px] leading-relaxed`}
                        placeholder="Proud myšlenek..."
                      />
                    </div>
                  </div>
                </section>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Export Modal */}
      {isExportModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">
          <div className={`w-full max-w-md p-8 rounded-[40px] border shadow-2xl ${theme !== 'light' ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
            <div className="flex justify-between items-center mb-8">
              <div>
                <h3 className={`text-2xl font-black italic tracking-tighter uppercase ${theme !== 'light' ? 'text-white' : 'text-slate-900'}`}>Export Deníku</h3>
                <p className="text-[10px] font-black uppercase text-blue-500 tracking-widest">Vyberte parametry exportu</p>
              </div>
              <button
                onClick={() => setIsExportModalOpen(false)}
                className={`p-2 rounded-xl transition-colors ${theme !== 'light' ? 'hover:bg-white/10 text-slate-400' : 'hover:bg-black/5 text-slate-500'}`}
              >
                <X size={20} />
              </button>
            </div>

            <div className="space-y-8">
              {/* Range Selection */}
              <div className="space-y-4">
                <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em]">Časové období</p>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: '7', label: '7 dní' },
                    { id: '30', label: '30 dní' },
                    { id: '90', label: '90 dní' },
                    { id: 'all', label: 'Vše' }
                  ].map(r => (
                    <button
                      key={r.id}
                      onClick={() => setExportRange(r.id as any)}
                      className={`relative px-4 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${exportRange === r.id
                        ? 'text-white shadow-lg shadow-blue-600/20 scale-[1.02]'
                        : `${theme !== 'light' ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`
                        }`}
                    >
                      {exportRange === r.id && (
                        <motion.div
                          layoutId="exportRangeBubble"
                          className="absolute inset-0 bg-blue-600 rounded-2xl z-0"
                          transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                        />
                      )}
                      <span className="relative z-10">{r.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Field Selection */}
              <div className="space-y-4">
                <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em]">Data k exportu</p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { id: 'notes', label: 'Reflexe' },
                    { id: 'mistakes', label: 'Chyby' },
                    { id: 'stressors', label: 'Stresory' },
                    { id: 'gratitude', label: 'Vděčnost' },
                    { id: 'pnl', label: 'PnL' },
                    { id: 'rating', label: 'Rating' },
                    { id: 'analysisScreenshots', label: 'Analýza (Screeny)' },
                    { id: 'tradeScreenshots', label: 'Obchody (Screeny)' },
                    { id: 'showTimestamps', label: 'Časy v pozn.' }
                  ].map(field => (
                    <button
                      key={field.id}
                      onClick={() => setExportFields(prev => ({ ...prev, [field.id]: !prev[field.id as keyof typeof prev] }))}
                      className={`px-4 py-2.5 rounded-xl border text-[9px] font-black uppercase tracking-widest transition-all flex items-center justify-between ${exportFields[field.id as keyof typeof exportFields]
                        ? 'bg-blue-600/10 border-blue-600/50 text-blue-500'
                        : `${theme !== 'light' ? 'bg-white/5 border-white/5 text-slate-500 hover:bg-white/10' : 'bg-slate-50 border-slate-200 text-slate-400 hover:bg-slate-100'}`
                        }`}
                    >
                      {field.label}
                      <div className={`w-3.5 h-3.5 rounded-md border flex items-center justify-center transition-all ${exportFields[field.id as keyof typeof exportFields]
                        ? 'bg-blue-600 border-blue-600'
                        : 'border-slate-600'
                        }`}>
                        {exportFields[field.id as keyof typeof exportFields] && <Check size={10} className="text-white" />}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Format Selection */}
              <div className="space-y-4">
                <p className="text-[10px] font-black uppercase text-slate-500 tracking-[0.2em]">Formát exportu</p>
                <div className="space-y-2">
                  {[
                    { id: 'pdf', label: 'Vizuální PDF Report', sub: 'Ideální pro čtení a tisk', icon: FileText },
                    { id: 'csv', label: 'Data pro Excel (CSV)', sub: 'Ideální pro vlastní analýzu', icon: List },
                    { id: 'ai', label: 'AI Optimized (MD)', sub: 'Nejlepší pro Gemini / ChatGPT', icon: Brain }
                  ].map(f => (
                    <button
                      key={f.id}
                      onClick={() => setExportFormat(f.id as any)}
                      className={`w-full p-4 rounded-3xl flex items-center gap-4 transition-all text-left group ${exportFormat === f.id
                        ? 'bg-blue-600/10 border-2 border-blue-600'
                        : `${theme !== 'light' ? 'bg-[var(--bg-input)] border-2 border-transparent hover:bg-white/10' : 'bg-slate-50 border-2 border-transparent hover:bg-slate-100'}`
                        }`}
                    >
                      <div className={`p-2.5 rounded-xl ${exportFormat === f.id ? 'bg-blue-600 text-white' : (theme !== 'light' ? 'bg-[var(--bg-card)] text-slate-400' : 'bg-slate-800 text-slate-400')}`}>
                        <f.icon size={18} />
                      </div>
                      <div className="flex-1">
                        <p className={`text-[10px] font-black uppercase tracking-widest ${exportFormat === f.id ? 'text-blue-500' : 'text-slate-400'}`}>{f.label}</p>
                        <p className="text-[9px] text-slate-500 font-bold uppercase">{f.sub}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={handleExport}
                className="w-full py-5 rounded-[28px] bg-blue-600 hover:bg-blue-500 text-white text-[12px] font-black uppercase tracking-widest transition-all hover:scale-[1.02] active:scale-[0.98] shadow-xl shadow-blue-600/30 flex items-center justify-center gap-3 mt-4"
              >
                Stáhnout Export <Download size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unsaved Changes Warning Modal */}
      {showUnsavedWarning && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className={`w-full max-w-md rounded-3xl shadow-2xl p-6 ${theme !== 'light' ? 'bg-[var(--bg-card)] border border-[var(--border-subtle)]' : 'bg-white border border-slate-200'}`}>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-3 rounded-2xl bg-orange-500/20">
                <AlertTriangle size={24} className="text-orange-400" />
              </div>
              <div>
                <h3 className="text-lg font-black">{(view === 'edit-prep' || view === 'edit-review') ? 'Nedokončeno' : 'Neuložené změny'}</h3>
                <p className="text-sm text-slate-500">{(view === 'edit-prep') ? 'Příprava není dokončená. Chceš ji dokončit?' : (view === 'edit-review') ? 'Review není dokončené. Chceš ho dokončit?' : 'Tvoje poznámky ještě nejsou uložené.'}</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={handleSaveAndProceed} className="flex-1 py-3 rounded-2xl bg-green-600 hover:bg-green-500 text-white font-black text-xs uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2"><Check size={16} /> {(view === 'edit-prep' || view === 'edit-review') ? 'Dokončit' : 'Uložit'}</button>
              <button onClick={handleDiscardAndProceed} className="flex-1 py-3 rounded-2xl bg-red-600/20 hover:bg-red-600/30 text-red-400 font-black text-xs uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2 border border-red-500/30"><X size={16} /> Odejít</button>
              <button onClick={handleCancelNavigation} className={`flex-1 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all active:scale-95 ${theme !== 'light' ? 'bg-[var(--bg-page)] text-slate-300 border border-[var(--border-subtle)] hover:bg-[var(--bg-input)]' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>Zrušit</button>
            </div>
          </div>
        </div>
      )}
      {zoomImg && <ImageZoomModal src={zoomImg} onClose={() => setZoomImg(null)} />}
    </div>
  );
};

export default DailyJournal;
