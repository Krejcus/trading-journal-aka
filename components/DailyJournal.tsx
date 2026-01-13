
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { DailyPrep, DailyReview, WeeklyReview, Trade, GoalResult, IronRule, RuleCompletion, PsychoMetricConfig, WeeklyFocus } from '../types';
import DisciplineDashboard from './DisciplineDashboard';
import TacticalTimeline from './TacticalTimeline';
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
  ClipboardCheck
} from 'lucide-react';

interface DailyJournalProps {
  theme: 'dark' | 'light' | 'oled';
  trades: Trade[];
  preps: DailyPrep[];
  reviews: DailyReview[];
  onSavePrep: (prep: DailyPrep) => void;
  onSaveReview: (review: DailyReview) => void;
  onDeletePrep?: (date: string) => void;
  onDeleteReview?: (date: string) => void;
  standardGoals: string[];
  ironRules: IronRule[];
  psychoMetrics?: PsychoMetricConfig[];
  viewMode: 'individual' | 'combined';
  weeklyFocusList: WeeklyFocus[];
}

const DailyJournal: React.FC<DailyJournalProps> = ({
  theme, trades, preps, reviews, onSavePrep, onSaveReview, onDeletePrep, onDeleteReview, standardGoals, ironRules, psychoMetrics, viewMode, weeklyFocusList
}) => {
  const getToday = () => new Date().toLocaleDateString('en-CA');
  const [selectedDate, setSelectedDate] = useState(getToday());
  const today = getToday();

  const [activeTab, setActiveTab] = useState<'daily' | 'weekly' | 'archives'>('daily');
  const [view, setView] = useState<'timeline' | 'edit-prep' | 'edit-review' | 'edit-weekly'>('timeline');
  const [activeImageField, setActiveImageField] = useState<'bullish' | 'bearish' | 'scenarios' | null>(null);

  const [weeklyReviews, setWeeklyReviews] = useState<WeeklyReview[]>([]);

  // Weekly Navigation State
  const [activeWeekMonday, setActiveWeekMonday] = useState(() => {
    const d = new Date();
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff)).toLocaleDateString('en-CA');
  });

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

  const rituals = useMemo(() => ironRules.filter(r => r.type === 'ritual'), [ironRules]);
  const tradeRules = useMemo(() => ironRules.filter(r => r.type === 'trading'), [ironRules]);

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

  const autoMistakes = useMemo(() => {
    const m = new Set<string>();
    currentTrades.forEach(t => t.mistakes?.forEach(mistake => m.add(mistake)));
    return Array.from(m);
  }, [currentTrades]);

  const [prepForm, setPrepForm] = useState<DailyPrep>({
    id: `prep_${selectedDate}`,
    date: selectedDate,
    scenarios: { bullish: '', bearish: '', scenarioImages: [], bullishImage: '', bearishImage: '' },
    goals: standardGoals.length > 0 ? [...standardGoals] : [''],
    checklist: { sleptWell: false, planReady: false, disciplineCommitted: false, newsChecked: false },
    ritualCompletions: rituals.map(r => ({ ruleId: r.id, status: 'Pending' })),
    mindsetState: '',
    confidence: 5
  });

  const [reviewForm, setReviewForm] = useState<DailyReview>({
    id: `review_${selectedDate}`,
    date: selectedDate,
    mainTakeaway: '',
    mistakes: autoMistakes.length > 0 ? autoMistakes : [''],
    lessons: '',
    rating: 0,
    goalResults: [],
    scenarioResult: 'Range',
    ruleAdherence: tradeRules.map(r => ({ ruleId: r.id, status: 'Pending' })),
    weeklyGoalAdherence: [],
    psycho: { metrics: (psychoMetrics || []).reduce((acc, m) => ({ ...acc, [m.id]: 5 }), {}), stressors: '', gratitude: '', notes: '' }
  });

  // Track the most recent form state to save on switch/unmount
  const lastPrepForm = useRef(prepForm);
  const lastReviewForm = useRef(reviewForm);

  useEffect(() => { lastPrepForm.current = prepForm; }, [prepForm]);
  useEffect(() => { lastReviewForm.current = reviewForm; }, [reviewForm]);

  // Force save on unmount
  useEffect(() => {
    return () => {
      onSavePrep(lastPrepForm.current);
      onSaveReview(lastReviewForm.current);
    };
  }, []);

  // Current Week Focus Helper
  const getSelectedWeekISO = (dateStr: string) => {
    const d = new Date(dateStr);
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

  // Auto-save Logic for Prep
  useEffect(() => {
    // Skip initial mount or invalid forms
    if (!prepForm || !prepForm.date) return;

    // Check if form is actually different from saved prop to avoid loops/unnecessary saves
    const saved = preps.find(p => p.date === prepForm.date);
    if (!saved || JSON.stringify(prepForm) !== JSON.stringify(saved)) {
      setIsSaving(true);
      const timer = setTimeout(() => {
        onSavePrep(prepForm);
        setLastSaved(new Date());
        setIsSaving(false);
      }, 1000);

      return () => clearTimeout(timer);
    }
  }, [prepForm, onSavePrep, preps]);

  // Auto-save Logic for Review
  useEffect(() => {
    // Skip initial mount or invalid forms
    if (!reviewForm || !reviewForm.date) return;

    // Check if form is actually different from saved prop
    const saved = reviews.find(r => r.date === reviewForm.date);
    if (!saved || JSON.stringify(reviewForm) !== JSON.stringify(saved)) {
      setIsSaving(true);
      const timer = setTimeout(() => {
        onSaveReview(reviewForm);
        setLastSaved(new Date());
        setIsSaving(false);
      }, 1000);

      return () => clearTimeout(timer);
    }
  }, [reviewForm, onSaveReview, reviews]);

  const addQuickNote = () => {
    if (!quickNote.trim()) return;
    const now = new Date();
    const timestamp = `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}]`;
    const newNote = `${timestamp} ${quickNote}`;
    setReviewForm(prev => ({
      ...prev,
      psycho: {
        ...prev.psycho!,
        notes: prev.psycho?.notes ? `${prev.psycho.notes}\n${newNote}` : newNote
      }
    }));
    setQuickNote('');
  };

  useEffect(() => {
    const loadExtra = async () => {
      setWeeklyReviews(await storageService.getWeeklyReviews());
    };
    loadExtra();
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

    // Counts for Prep/Audit
    const prepCount = weekPreps.length;
    const auditCount = weekReviews.length;

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
        return { label: goal, count: passCount };
      }) || []
    };
  }, [trades, reviews, preps, currentWeekInfo, ironRules, weeklyFocusList, currentWeekFocus]);

  const navigateDate = (direction: 'prev' | 'next') => {
    const d = new Date(selectedDate);
    if (direction === 'prev') d.setDate(d.getDate() - 1);
    else d.setDate(d.getDate() + 1);
    const newDateStr = d.toLocaleDateString('en-CA');
    if (newDateStr <= today) { setSelectedDate(newDateStr); setView('timeline'); }
  };

  const currentReview = useMemo(() => reviews.find(r => r.date === selectedDate), [reviews, selectedDate]);

  useEffect(() => {
    // 1. Force save the PREVIOUS date's form if it changed
    if (lastPrepForm.current.date && lastPrepForm.current.date !== selectedDate) {
      onSavePrep(lastPrepForm.current);
    }

    // 2. Load the new date's form
    if (currentPrep) {
      if (prepForm.date !== selectedDate || (currentPrep.id && prepForm.id !== currentPrep.id)) {
        setPrepForm(currentPrep);
      }
    } else {
      setPrepForm({
        id: `prep_${selectedDate}`,
        date: selectedDate,
        scenarios: { bullish: '', bearish: '', scenarioImages: [], bullishImage: '', bearishImage: '' },
        goals: standardGoals.length > 0 ? [...standardGoals] : [''],
        checklist: { sleptWell: false, planReady: false, disciplineCommitted: false, newsChecked: false },
        ritualCompletions: rituals.map(r => ({ ruleId: r.id, status: 'Pending' })),
        mindsetState: '',
        confidence: 5
      });
    }
  }, [currentPrep, selectedDate]); // Omezení závislostí

  useEffect(() => {
    // 1. Force save the PREVIOUS date's review if it changed
    if (lastReviewForm.current.date && lastReviewForm.current.date !== selectedDate) {
      onSaveReview(lastReviewForm.current);
    }

    // 2. Load the new date's review
    if (currentReview) {
      if (reviewForm.date !== selectedDate || (currentReview.id && reviewForm.id !== currentReview.id)) {
        setReviewForm(currentReview);
      }
    } else {
      const initialPrep = currentPrep || (lastPrepForm.current.date === selectedDate ? lastPrepForm.current : undefined);
      const initialResults: GoalResult[] = initialPrep?.goals?.filter(g => g && g.trim() !== '').map(g => ({ text: g, achieved: true })) || [];
      setReviewForm({
        id: `review_${selectedDate}`,
        date: selectedDate,
        mainTakeaway: '',
        mistakes: autoMistakes.length > 0 ? autoMistakes : [''],
        lessons: '',
        rating: 0,
        goalResults: initialResults,
        scenarioResult: 'Range',
        ruleAdherence: tradeRules.map(r => ({ ruleId: r.id, status: 'Pending' })),
        psycho: { metrics: (psychoMetrics || []).reduce((acc, m) => ({ ...acc, [m.id]: 5 }), {}), stressors: '', gratitude: '', notes: '' }
      });
    }
  }, [currentReview, selectedDate]); // Omezení závislostí

  const handleToggleRitual = (ruleId: string) => {
    setPrepForm(prev => {
      const completions = prev.ritualCompletions || [];
      const index = completions.findIndex(c => c.ruleId === ruleId);
      const newCompletions = [...completions];
      if (index === -1) newCompletions.push({ ruleId, status: 'Pass' });
      else newCompletions[index] = { ...newCompletions[index], status: newCompletions[index].status === 'Pass' ? 'Pending' : 'Pass' };
      return { ...prev, ritualCompletions: newCompletions };
    });
  };

  const handleSetRuleStatus = (ruleId: string, status: 'Pass' | 'Fail') => {
    setReviewForm(prev => {
      const adherence = prev.ruleAdherence || [];
      const index = adherence.findIndex(a => a.ruleId === ruleId);
      const newAdherence = [...adherence];
      if (index === -1) newAdherence.push({ ruleId, status });
      else newAdherence[index] = { ...newAdherence[index], status };
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
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64 = reader.result as string;
              if (activeImageField === 'scenarios') {
                setPrepForm(prev => ({
                  ...prev,
                  scenarios: {
                    ...prev.scenarios,
                    scenarioImages: [...(prev.scenarios.scenarioImages || []), base64]
                  }
                }));
              } else {
                setPrepForm(prev => ({ ...prev, scenarios: { ...prev.scenarios, [activeImageField === 'bullish' ? 'bullishImage' : 'bearishImage']: base64 } }));
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
      <div className="flex justify-center">
        <div className="p-1 rounded-2xl border flex gap-1 theme-card theme-border shadow-sm">
          {[
            { id: 'daily', label: 'Daily', icon: Clock },
            { id: 'weekly', label: 'Weekly', icon: Calendar },
            { id: 'archives', label: 'Deník', icon: History }
          ].map(tab => (
            <button key={tab.id} onClick={() => { setActiveTab(tab.id as any); setView('timeline'); }} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase transition-all ${activeTab === tab.id ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20' : 'text-slate-500 hover:text-slate-300'}`}><tab.icon size={14} /> {tab.label}</button>
          ))}
        </div>
      </div>

      {activeTab === 'daily' && (
        <DisciplineDashboard theme={theme} preps={preps} reviews={reviews} trades={groupedTrades} ironRules={ironRules} />
      )}

      <div className={`flex flex-col md:flex-row justify-between items-start md:items-end gap-4 border-b pb-6 ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6">
            <h2 className="text-3xl md:text-5xl font-black tracking-tighter italic flex items-center gap-4">
              {activeTab === 'daily' ? 'DAILY HUB' : (activeTab === 'weekly' ? 'WEEKLY HUB' : 'DENÍK')}
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
                  <p className="text-[8px] font-black text-blue-500 uppercase tracking-[0.2em] mb-0.5">{activeTab === 'daily' ? 'Tactical Date' : `Week ${currentWeekInfo.weekNumber} `}</p>
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
        <div className="flex gap-2 w-full sm:w-auto">
          {view === 'timeline' && activeTab === 'daily' && (
            <><button onClick={() => setView('edit-prep')} className="flex-1 sm:flex-none px-4 py-3 bg-blue-600 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg active:scale-95 transition-all">Ranní</button><button onClick={() => setView('edit-review')} className="flex-1 sm:flex-none px-4 py-3 bg-indigo-600 text-white rounded-2xl font-black text-[10px] uppercase tracking-widest shadow-lg active:scale-95 transition-all">Večerní</button></>
          )}
          {view !== 'timeline' && (<button onClick={() => setView('timeline')} className={`w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl font-bold text-xs transition-all active:scale-95 ${theme !== 'light' ? 'bg-[var(--bg-card)] text-slate-300 border border-[var(--border-subtle)] hover:bg-[var(--bg-page)]' : 'bg-slate-800 text-white hover:bg-slate-700'}`}><LayoutGrid size={14} /> Feed</button>)}
        </div>
      </div>

      {activeTab === 'daily' && view === 'timeline' && (
        <TacticalTimeline
          date={selectedDate}
          prep={currentPrep}
          review={currentReview}
          trades={currentTrades}
          theme={theme}
          onEditPrep={() => setView('edit-prep')}
          onEditReview={() => setView('edit-review')}
          onDeletePrep={onDeletePrep}
          onDeleteReview={onDeleteReview}
        />
      )}

      {activeTab === 'weekly' && view === 'timeline' && (
        <div className="space-y-8 animate-in fade-in duration-500">
          {/* Mobile optimized weekly grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
            {currentWeekInfo.days.map((dateStr) => {
              const dayTrades = groupedTrades.filter(t => t.date.startsWith(dateStr));
              const dayPrep = preps.find(p => p.date === dateStr);
              const dayReview = reviews.find(r => r.date === dateStr);
              return (
                <div key={dateStr} className={`rounded-[28px] border overflow-hidden transition-all flex flex-col h-full ${theme !== 'light' ? 'bg-[var(--bg-card)]/60 border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <div className={`p-4 border-b flex justify-between items-center shrink-0 ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-50'}`}>
                    <div>
                      <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest">{new Date(dateStr).toLocaleString('cs-CZ', { weekday: 'long' })}</p>
                      <p className="text-[9px] font-bold text-slate-400">{dateStr}</p>
                    </div>
                    {dateStr === today && <span className="px-2 py-0.5 bg-blue-600 rounded-lg text-[7px] font-black uppercase text-white shadow-lg shadow-blue-500/20">Dnes</span>}
                  </div>
                  <div className="flex-1 overflow-y-auto custom-scrollbar no-scrollbar max-h-[400px]">
                    <TacticalTimeline
                      date={dateStr}
                      prep={dayPrep}
                      review={dayReview}
                      trades={dayTrades}
                      theme={theme}
                      onEditPrep={() => { setSelectedDate(dateStr); setView('edit-prep'); setActiveTab('daily'); }}
                      onEditReview={() => { setSelectedDate(dateStr); setView('edit-review'); setActiveTab('daily'); }}
                      onDeletePrep={onDeletePrep}
                      onDeleteReview={onDeleteReview}
                      isMini={true}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary Section */}
          <div className={`p-6 md:p-10 rounded-[40px] border relative overflow-hidden ${theme !== 'light' ? 'bg-[var(--bg-card)]/40 border-[var(--border-subtle)]' : 'bg-white border-slate-200 shadow-xl'}`}>
            <div className="relative z-10 grid grid-cols-1 lg:grid-cols-12 gap-8 md:gap-12">

              <div className="lg:col-span-6 space-y-8 md:space-y-12">
                <div className="space-y-6">
                  <p className="text-[10px] font-black uppercase text-blue-500 tracking-[0.2em] flex items-center gap-2"><Layers size={14} /> Weekly Alpha Metrics</p>
                  <div className="grid grid-cols-2 gap-y-6 md:gap-y-8 gap-x-6">
                    <div><p className="text-[9px] font-bold text-slate-500 uppercase mb-1">Skutečné PnL</p><p className={`text-2xl md:text-3xl font-black ${weeklyStats.pnl >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>${weeklyStats.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p></div>
                    <div><p className="text-[9px] font-bold text-slate-500 uppercase mb-1">Disciplinované</p><p className={`text-2xl md:text-3xl font-black text-blue-500`}>${weeklyStats.disciplinedPnL.toLocaleString(undefined, { maximumFractionDigits: 0 })}</p></div>
                    <div><p className="text-[9px] font-bold text-slate-500 uppercase mb-1">Exekuce</p><div className="flex items-center gap-2"><p className="text-xl font-black text-white">{weeklyStats.validCount}/{weeklyStats.count}</p></div></div>
                    <div><p className="text-[9px] font-bold text-slate-500 uppercase mb-1">Win Rate</p><p className="text-xl font-black text-white">{weeklyStats.wr.toFixed(1)}%</p></div>

                    <div className="col-span-2 grid grid-cols-2 gap-3">
                      <div className="p-3 rounded-2xl bg-blue-600/5 border border-blue-500/10"><p className="text-[8px] font-black text-slate-500 uppercase mb-1 flex items-center gap-1"><Sun size={10} /> Ranní Hub</p><p className="text-lg font-black text-blue-400">{weeklyStats.prepCount}/5</p></div>
                      <div className={`p-3 rounded-2xl ${weeklyStats.auditCount === 5 ? 'bg-emerald-600/5 border-emerald-500/10' : 'bg-indigo-600/5 border-indigo-500/10'}`}><p className="text-[8px] font-black text-slate-500 uppercase mb-1 flex items-center gap-1"><Moon size={10} /> Večerní Hub</p><p className="text-lg font-black text-indigo-400">{weeklyStats.auditCount}/5</p></div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-6 space-y-6 md:space-y-8">
                <p className="text-[10px] font-black uppercase text-amber-500 tracking-[0.2em] flex items-center gap-2"><Target size={14} /> Iron Rule Progress</p>
                <div className="space-y-5">
                  {weeklyStats.ritualCompliance.map((ritual, idx) => (
                    <div key={idx} className="space-y-2">
                      <div className="flex justify-between text-[10px] font-black uppercase tracking-tighter">
                        <span className="text-slate-400 truncate pr-2">{ritual.label}</span>
                        <span className={ritual.count >= 4 ? 'text-emerald-500' : 'text-blue-500'}>{ritual.count}/5</span>
                      </div>
                      <div className={`h-1.5 w-full rounded-full overflow-hidden flex gap-0.5 p-0.5 ${theme !== 'light' ? 'bg-[var(--bg-page)]/50' : 'bg-slate-100'}`}>
                        {[...Array(5)].map((_, i) => (
                          <div key={i} className={`flex-1 rounded-full ${i < ritual.count ? 'bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,0.4)]' : (theme !== 'light' ? 'bg-[var(--border-subtle)]' : 'bg-slate-200')}`} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Weekly Focus Adherence List */}
                {weeklyStats.weeklyGoalStats && weeklyStats.weeklyGoalStats.length > 0 && (
                  <div className="space-y-6">
                    <p className="text-[10px] font-black uppercase text-emerald-500 tracking-[0.2em] flex items-center gap-2"><ClipboardCheck size={14} /> Weekly Focus Adherence</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {weeklyStats.weeklyGoalStats.map((goal: any, idx: number) => (
                        <div key={idx} className={`p-4 rounded-[24px] border transition-all ${theme !== 'light' ? 'bg-[var(--bg-input)]/20 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                          <div className="flex justify-between items-center mb-3">
                            <span className="text-[10px] font-black uppercase tracking-tight text-slate-400 truncate pr-4">{goal.label}</span>
                            <span className={`text-[10px] font-bold ${goal.count >= 4 ? 'text-emerald-500' : 'text-blue-500'}`}>{goal.count}/5</span>
                          </div>
                          <div className={`h-1.5 w-full rounded-full overflow-hidden flex gap-0.5 p-0.5 ${theme !== 'light' ? 'bg-[var(--bg-page)]/50' : 'bg-slate-200/50'}`}>
                            {[...Array(5)].map((_, i) => (
                              <div key={i} className={`flex-1 rounded-full ${i < goal.count ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : (theme !== 'light' ? 'bg-[var(--border-subtle)]' : 'bg-slate-300')}`} />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className={`pt-6 border-t grid grid-cols-2 gap-4 ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
                  <div>
                    <p className="text-[9px] font-black uppercase text-rose-500 mb-1">Errors</p>
                    <p className="text-3xl font-black text-rose-500">{weeklyStats.totalMistakes}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] font-black uppercase text-emerald-500 mb-1">Goals</p>
                    <p className="text-3xl font-black text-emerald-500">{weeklyStats.goalsAchieved}</p>
                  </div>
                </div>
              </div>


            </div>
          </div>
        </div>
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
                              <p className="text-[8px] font-black uppercase text-slate-500 mb-1">{metric.label}</p>
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
                      onClick={() => { setSelectedDate(review.date); setActiveTab('daily'); setView('edit-review'); window.scrollTo(0, 0); }}
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

      {/* EDIT FORMS */}
      {(view === 'edit-prep' || view === 'edit-review') && (
        <div className="max-w-4xl mx-auto animate-in slide-in-from-right-4 duration-500">
          {view === 'edit-prep' && (
            <div className="space-y-6 lg:space-y-8">
              <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border ${theme !== 'light' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'}`}>
                <div className="flex items-center justify-between mb-6 md:mb-8">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-2xl bg-blue-500/10 text-blue-500"><Zap size={20} /></div>
                    <div><h3 className="text-xl md:text-2xl font-black italic uppercase">PREATTACK</h3><p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Ranní aktivace</p></div>
                  </div>
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
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{rituals.map(ritual => { const comp = prepForm.ritualCompletions?.find(c => c.ruleId === ritual.id); const isDone = comp?.status === 'Pass'; return (<button key={ritual.id} onClick={() => handleToggleRitual(ritual.id)} className={`p-4 rounded-xl border flex items-center justify-between transition-all active:scale-95 ${isDone ? 'bg-emerald-600 border-emerald-500 text-white shadow-lg shadow-emerald-600/20' : (theme !== 'light' ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-600')} `}><span className="text-[10px] font-black uppercase tracking-tight text-left pr-2">{ritual.label}</span>{isDone ? <Check size={16} /> : <div className={`w-4 h-4 rounded-full border shrink-0 ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-200'} `} />}</button>); })}</div>
              </section>
              <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border ${theme !== 'light' ? 'bg-[var(--bg-card)]/50 border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                <div className="flex items-center gap-4 mb-6 md:mb-8"><div className="p-3 rounded-2xl bg-blue-500/10 text-blue-500"><Sparkles size={20} /></div><div><h3 className="text-xl md:text-2xl font-black italic uppercase">SCENARIOS</h3><p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Vizualizace & Mapping</p></div></div>
                <div className="space-y-6">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="space-y-4"><label className={`${labelClass} text-emerald-500`}>Bullish Scénář</label><textarea value={prepForm.scenarios.bullish} onChange={e => setPrepForm({ ...prepForm, scenarios: { ...prepForm.scenarios, bullish: e.target.value } })} className={`${inputClass} h-32 resize-none`} /></div>
                    <div className="space-y-4"><label className={`${labelClass} text-rose-500`}>Bearish Scénář</label><textarea value={prepForm.scenarios.bearish} onChange={e => setPrepForm({ ...prepForm, scenarios: { ...prepForm.scenarios, bearish: e.target.value } })} className={`${inputClass} h-32 resize-none`} /></div>
                  </div>

                  <div className="space-y-4">
                    <label className={labelClass}>Screenshoty scénářů</label>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {prepForm.scenarios.scenarioImages?.map((img, idx) => (
                        <div key={idx} className="relative aspect-video rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-page)]/20 overflow-hidden group">
                          <img src={img} className="w-full h-full object-cover" />
                          <button
                            onClick={() => setPrepForm(prev => ({
                              ...prev,
                              scenarios: {
                                ...prev.scenarios,
                                scenarioImages: prev.scenarios.scenarioImages?.filter((_, i) => i !== idx)
                              }
                            }))}
                            className="absolute top-2 right-2 p-1.5 bg-rose-500 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                      <div
                        onClick={() => setActiveImageField('scenarios')}
                        className={`relative aspect-video rounded-2xl border-2 border-dashed transition-all flex flex-col items-center justify-center cursor-pointer ${activeImageField === 'scenarios' ? 'border-blue-500 bg-blue-500/5' : `border-[var(--border-subtle)] bg-[var(--bg-page)]/20`}`}
                      >
                        <ImageIcon size={20} className="mx-auto mb-2 text-slate-700" />
                        <p className="text-[8px] font-black uppercase text-slate-600">Vložit (CTRL+V)</p>
                        {prepForm.scenarios.scenarioImages && prepForm.scenarios.scenarioImages.length > 0 && (
                          <div className="absolute top-2 right-2 p-1.5 bg-blue-500/20 text-blue-500 rounded-lg">
                            <Plus size={14} />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <button onClick={() => { onSavePrep(prepForm); setView('timeline'); window.scrollTo(0, 0); }} className="w-full mt-8 py-4 bg-blue-600 rounded-2xl font-black text-[10px] uppercase tracking-widest text-white shadow-xl active:scale-95 transition-all">ULOŽIT PLÁN</button>
              </section>
            </div>
          )}
          {view === 'edit-review' && (
            <div className="space-y-6 lg:space-y-8">
              <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border ${theme !== 'light' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200'}`}>
                <div className="flex items-center justify-between mb-6 md:mb-8">
                  <div className="flex items-center gap-4"><div className="p-3 rounded-2xl bg-amber-500/10 text-amber-500"><ShieldAlert size={20} /></div><div><h3 className="text-xl md:text-2xl font-black italic uppercase">EXECUTION AUDIT</h3><p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Dodržení pravidel</p></div></div>
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
                </div>
                <div className="space-y-3 md:space-y-4">{tradeRules.map(rule => { const comp = reviewForm.ruleAdherence?.find(a => a.ruleId === rule.id); const status = comp?.status || 'Pending'; return (<div key={rule.id} className={`p-4 md:p-5 rounded-2xl border flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${theme !== 'light' ? 'bg-[var(--bg-page)]/50 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-200'} `}><div className="flex-1"><h4 className="text-[11px] font-black uppercase tracking-widest">{rule.label}</h4></div><div className="flex gap-2"><button onClick={() => handleSetRuleStatus(rule.id, 'Pass')} className={`flex-1 sm:flex-none px-6 py-2 rounded-xl font-black text-[9px] uppercase tracking-widest transition-all ${status === 'Pass' ? 'bg-emerald-600 text-white' : (theme !== 'light' ? 'bg-[var(--bg-card)] text-slate-500' : 'bg-slate-900 text-slate-600')} `}>Pass</button><button onClick={() => handleSetRuleStatus(rule.id, 'Fail')} className={`flex-1 sm:flex-none px-6 py-2 rounded-xl font-black text-[9px] uppercase tracking-widest transition-all ${status === 'Fail' ? 'bg-rose-600 text-white' : (theme !== 'light' ? 'bg-[var(--bg-card)] text-slate-500' : 'bg-slate-900 text-slate-600')} `}>Fail</button></div></div>); })}</div>

                {/* Weekly Focus Adherence Checklist */}
                {
                  currentWeekFocus && (
                    <div className={`mt-8 p-6 rounded-[32px] border ${theme !== 'light' ? 'bg-emerald-500/5 border-emerald-500/10' : 'bg-emerald-50 border-emerald-100'}`}>
                      <div className="flex items-center gap-3 mb-6">
                        <div className="p-2.5 rounded-xl bg-emerald-500 text-white"><ClipboardCheck size={18} /></div>
                        <div>
                          <h4 className="text-sm font-black uppercase tracking-widest text-emerald-500">Weekly Focus Adherence</h4>
                          <p className="text-[8px] font-bold uppercase tracking-widest opacity-60">Dodržování týdenních cílů</p>
                        </div>
                      </div>
                      <div className="space-y-2">
                        {currentWeekFocus.goals.map((goal, idx) => {
                          const adherence = reviewForm.weeklyGoalAdherence?.[idx]?.status === 'Pass';
                          return (
                            <button
                              key={idx}
                              onClick={() => {
                                setReviewForm(prev => {
                                  const newList = [...(prev.weeklyGoalAdherence || [])];
                                  while (newList.length <= idx) newList.push({ ruleId: `wf_${idx}`, status: 'Pending' });
                                  newList[idx] = { ruleId: `wf_${idx}`, status: adherence ? 'Pending' : 'Pass' };
                                  return { ...prev, weeklyGoalAdherence: newList };
                                });
                              }}
                              className={`w-full p-4 rounded-2xl border flex items-center justify-between transition-all group ${adherence
                                ? 'bg-emerald-500 text-white border-emerald-400 shadow-lg shadow-emerald-500/20'
                                : (theme !== 'light' ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] hover:border-emerald-500/30' : 'bg-white border-slate-100 hover:border-emerald-500/30 shadow-sm')
                                }`}
                            >
                              <div className="flex items-center gap-4">
                                <div className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${adherence ? 'bg-white border-white text-emerald-600' : 'border-slate-700 text-transparent group-hover:border-emerald-500'}`}>
                                  <Check size={14} strokeWidth={4} />
                                </div>
                                <span className={`text-xs font-black uppercase tracking-tight text-left ${adherence ? 'text-white' : 'text-slate-400'}`}>{goal}</span>
                              </div>
                              {adherence && <Sparkles size={14} className="animate-pulse" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
              </section>

              <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border relative overflow-hidden ${theme !== 'light' ? 'bg-indigo-950/10 border-indigo-500/20' : 'bg-indigo-50 border-indigo-200 shadow-sm'}`}>
                <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none" />
                <div className="flex items-center gap-4 mb-6 md:mb-8 relative z-10">
                  <div className="p-3 rounded-2xl bg-indigo-500/10 text-indigo-500"><Brain size={20} /></div>
                  <div>
                    <h3 className="text-xl md:text-2xl font-black italic uppercase">PSYCHO-CYBERNETICS</h3>
                    <p className="text-[9px] font-black uppercase text-indigo-500 tracking-widest">Mindset & Emoční Audit</p>
                  </div>
                </div>

                <div className="space-y-8 relative z-10">
                  {/* Mood & Energy Sliders */}
                  {/* Dynamic Metrics Sliders */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    {psychoMetrics?.map(metric => {
                      const value = reviewForm.psycho?.metrics?.[metric.id] || 5;
                      return (
                        <div key={metric.id} className={`p-5 rounded-[24px] border ${theme !== 'light' ? 'bg-[var(--bg-page)]/50 border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                          <div className="flex justify-between items-center mb-4">
                            <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: metric.color }} />
                              {metric.label}
                            </label>
                            <span className="text-sm font-black text-blue-500">{value}/10</span>
                          </div>
                          <input
                            type="range" min="1" max="10" step="1"
                            value={value}
                            onChange={(e) => {
                              const newMetrics = { ...reviewForm.psycho?.metrics, [metric.id]: Number(e.target.value) };
                              setReviewForm({ ...reviewForm, psycho: { ...reviewForm.psycho!, metrics: newMetrics } });
                            }}
                            className={`w-full h-2 rounded-lg appearance-none cursor-pointer ${theme !== 'light' ? 'bg-[var(--bg-card)]' : 'bg-slate-200'}`}
                            style={{ accentColor: metric.color }}
                          />
                        </div>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className={`${labelClass} text-rose-500`}>Stresory & Spouštěče (Kdo/Co mě rozhodilo?)</label>
                      <textarea
                        value={reviewForm.psycho?.stressors || ''}
                        onChange={(e) => setReviewForm({ ...reviewForm, psycho: { ...reviewForm.psycho!, stressors: e.target.value } })}
                        className={`${inputClass} h-24 resize-none`}
                        placeholder="Např. Hádka s partnerkou, zácpa cestou do práce..."
                      />
                    </div>
                    <div className="space-y-2">
                      <label className={`${labelClass} text-emerald-500`}>Vděčnost & Radost (Co se povedlo?)</label>
                      <textarea
                        value={reviewForm.psycho?.gratitude || ''}
                        onChange={(e) => setReviewForm({ ...reviewForm, psycho: { ...reviewForm.psycho!, gratitude: e.target.value } })}
                        className={`${inputClass} h-24 resize-none`}
                        placeholder="Např. Dobrý oběd, klidné ráno..."
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className={labelClass}>Osobní Deník (Volné myšlenky)</label>
                    <div className="flex gap-2 mb-2">
                      <input
                        type="text"
                        value={quickNote}
                        onChange={(e) => setQuickNote(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addQuickNote()}
                        placeholder="Rychlá poznámka s časem..."
                        className={`${inputClass} flex-1 h-10`}
                      />
                      <button
                        onClick={addQuickNote}
                        className="px-4 bg-blue-600 text-white rounded-xl hover:bg-blue-500 transition-all font-black uppercase text-[10px]"
                      >
                        Zapsat
                      </button>
                    </div>
                    <textarea
                      value={reviewForm.psycho?.notes || ''}
                      onChange={(e) => setReviewForm({ ...reviewForm, psycho: { ...reviewForm.psycho!, notes: e.target.value } })}
                      className={`${inputClass} h-32 resize-none font-mono text-xs leading-relaxed`}
                      placeholder="Nebo volný proud myšlenek..."
                    />
                  </div>

                </div>
              </section>
              <section className={`p-6 md:p-8 rounded-[32px] md:rounded-[40px] border ${theme !== 'light' ? 'bg-slate-900/50 border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
                <div className="flex items-center gap-4 mb-6 md:mb-8"><div className="p-3 rounded-2xl bg-indigo-500/10 text-indigo-500"><ShieldCheck size={20} /></div><div><h3 className="text-xl md:text-2xl font-black italic uppercase">AUDIT HUB</h3><p className="text-[9px] font-black uppercase text-slate-500 tracking-widest">Reflexe dne</p></div></div>
                <div className="space-y-6">
                  <div className={`p-5 md:p-6 rounded-[28px] border ${theme !== 'light' ? 'bg-rose-500/5 border-rose-500/10' : 'bg-rose-50 border-rose-100'}`}><p className="text-[10px] font-black uppercase text-rose-500 mb-4 flex items-center gap-2"><AlertOctagon size={14} /> Chyby dne</p><div className="flex flex-wrap gap-2">{reviewForm.mistakes.map((m, i) => (<div key={i} className={`flex items-center gap-2 px-3 py-1.5 border rounded-xl ${theme !== 'light' ? 'bg-[var(--bg-page)]/50 border-[var(--border-subtle)]' : 'bg-white border-slate-200'} `}><span className="text-[10px] font-black uppercase text-slate-300">{m}</span><button onClick={() => setReviewForm({ ...reviewForm, mistakes: reviewForm.mistakes.filter((_, idx) => idx !== i) })} className="text-slate-600 hover:text-rose-500"><X size={12} /></button></div>))}<button onClick={() => setReviewForm({ ...reviewForm, mistakes: [...reviewForm.mistakes, ''] })} className={`p-2 border border-dashed rounded-xl text-slate-500 hover:text-blue-500 active:scale-95 transition-all ${theme !== 'light' ? 'border-[var(--border-subtle)]' : 'border-slate-300'} `}><Plus size={14} /></button></div></div>
                  <button onClick={() => { onSaveReview(reviewForm); setView('timeline'); window.scrollTo(0, 0); }} className="w-full py-4 bg-indigo-600 text-white rounded-2xl font-black uppercase text-[10px] tracking-widest shadow-xl active:scale-95 transition-all">UZAVŘÍT AUDIT</button></div>
              </section>
            </div>
          )}
        </div>
      )}
      {/* Export Modal */}
      {
        isExportModalOpen && (
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
                        className={`px-4 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${exportRange === r.id
                          ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20 scale-[1.02]'
                          : `${theme !== 'light' ? 'bg-white/5 text-slate-400 hover:bg-white/10' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`
                          }`}
                      >
                        {r.label}
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
        )
      }
    </div >
  );
};

export default DailyJournal;
