import React, { useState, useMemo, useEffect } from 'react';
import {
   Search, UserPlus, Users, Share2, Shield, Activity,
   CheckCircle2, AlertTriangle, Loader2, Calendar,
   Layout, Eye, User as UserIcon, LogOut, ChevronLeft,
   ChevronRight, MessageSquare, Target, Brain, ArrowUpRight, ArrowDownRight,
   TrendingUp, TrendingDown, Clock, ShieldCheck, Zap, X, Trash2, Terminal,
   Globe, Lock, EyeOff, Copy, Check, Plus, AlertCircle, Hourglass, Hash, Tag as TagIcon,
   Eraser, BarChart2, FileText, Sun, Moon, Send, Monitor, Skull, Star,
   Briefcase, DollarSign, Trophy, Settings
} from 'lucide-react';
import {
   AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { storageService, getUserId } from '../services/storageService';
import { User, SocialConnection, UserSearch, Trade, DailyPrep, DailyReview, Account, CustomEmotion, UserPreferences } from '../types';
import DashboardCalendar from './DashboardCalendar';
import { formatPnL, calculateTotalRR } from '../utils/formatPnL';

interface NetworkHubProps {
   theme: 'dark' | 'light' | 'oled';
   accounts: Account[];
   emotions: CustomEmotion[];
   user: User;
   exchangeRates: ExchangeRates | null;
}

const NetworkHub: React.FC<NetworkHubProps> = ({ theme, accounts, emotions, user, exchangeRates }) => {
   const isDark = theme !== 'light';
   const [activeTab, setActiveTab] = useState<'share' | 'following' | 'followers' | 'requests' | 'leaderboard'>('following');
   const [isAirlockOpen, setIsAirlockOpen] = useState(false);

   const [connections, setConnections] = useState<SocialConnection[]>([]);
   const [currentUserId, setCurrentUserId] = useState<string | null>(null);
   const [searchQuery, setSearchQuery] = useState('');
   const [searchResults, setSearchResults] = useState<UserSearch[]>([]);
   const [isSearching, setIsSearching] = useState(false);
   const [loading, setLoading] = useState(true);

   // Spectator State
   const [spectatingUser, setSpectatingUser] = useState<User | null>(null);
   const [spectatorData, setSpectatorData] = useState<{
      trades: Trade[];
      accounts: Account[];
      preps: DailyPrep[];
      reviews: DailyReview[];
      preferences: UserPreferences | null;
      meta?: { pnlFormat?: 'usd' | 'rr' | 'hidden' } | null;
   } | null>(null);
   const [isSpectating, setIsSpectating] = useState(false);
   const [spectatorTab, setSpectatorTab] = useState<'overview' | 'calendar' | 'stats'>('overview');
   const [spectatorDate, setSpectatorDate] = useState(new Date().toISOString().split('T')[0]);
   const [activeSpectatorAccountId, setActiveSpectatorAccountId] = useState<string | null>(null);

   const [leaderboardStats, setLeaderboardStats] = useState<any[]>([]);
   const [loadingLeaderboard, setLoadingLeaderboard] = useState(false);

   // Detail View State
   const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
   const [selectedPrep, setSelectedPrep] = useState<DailyPrep | null>(null);
   const [selectedReview, setSelectedReview] = useState<DailyReview | null>(null);
   const [zoomedImage, setZoomedImage] = useState<string | null>(null);
   const [editingPermissions, setEditingPermissions] = useState<{ connectionId: string, permissions: { canSeePnl: boolean; pnlFormat?: 'usd' | 'rr' | 'hidden'; canSeePrep?: boolean; canSeeReviewStats?: boolean; canSeeReviewNotes?: boolean; canSeeNotes: boolean; canSeeScreenshots: boolean }, name: string } | null>(null);
   const [modalPnlFormat, setModalPnlFormat] = useState<'usd' | 'rr' | 'hidden' | undefined>(undefined);

   const loadConnections = async () => {
      try {
         const [data, uid] = await Promise.all([
            storageService.getConnections(),
            getUserId()
         ]);
         setConnections(data);
         if (uid) {
            const followingIds = [
               uid,
               ...data
                  .filter(c => c.status === 'accepted')
                  .map(c => c.sender_id === uid ? c.receiver_id : c.sender_id)
            ];

            setLoadingLeaderboard(true);

            const stats = await storageService.getLeaderboardStats(followingIds);

            setLeaderboardStats(stats);
            setLoadingLeaderboard(false);
         }
         if (uid) setCurrentUserId(uid);
      } catch (err) {
         console.error("Failed to load network data", err);
      } finally {
         setLoading(false);
      }
   };

   useEffect(() => {
      loadConnections();
   }, []);

   const handleSearch = async (val: string) => {
      setSearchQuery(val);
      if (val.length < 3) {
         setSearchResults([]);
         return;
      }
      setIsSearching(true);
      try {
         const results = await storageService.searchUsers(val);
         // Filter out current user AND users with existing connection (pending or accepted)
         const connectedIds = new Set(connections.map(c => c.sender_id === currentUserId ? c.receiver_id : c.sender_id));
         setSearchResults(results.filter(u => u.id !== currentUserId && !connectedIds.has(u.id)));
      } finally {
         setIsSearching(false);
      }
   };

   const sendRequest = async (userId: string) => {
      try {
         await storageService.sendFollowRequest(userId);
         setSearchQuery('');
         setSearchResults([]);
         loadConnections();
         alert("Žádost o sledování byla odeslána.");
      } catch (err: any) {
         alert(err.message || "Chyba při odesílání žádosti.");
      }
   };

   const handleRequestAction = async (connId: string, action: 'accepted' | 'rejected') => {
      try {
         await storageService.updateConnectionStatus(connId, action);
         loadConnections();
      } catch (err) {
         console.error("Action failed", err);
      }
   };

   const enterSpectatorMode = async (userId: string) => {
      setIsSpectating(true);
      setLoading(true);
      try {
         const secureData = await storageService.getSpectatorData(userId);

         if (!secureData) {
            throw new Error("Nepodařilo se načíst data nebo nemáte oprávnění.");
         }

         const { trades, accounts: remoteAccounts, preps, reviews, preferences: remotePrefs } = secureData;

         // Profile is public, so we fetch it separately to get the name/avatar
         const profile = await storageService.getProfile(userId);


         const activeAccounts = remoteAccounts.filter(a => a.status === 'Active');

         setSpectatingUser(profile);
         setSpectatorData({
            trades,
            accounts: activeAccounts,
            preps,
            reviews,
            preferences: remotePrefs,
            meta: secureData.meta
         });
         if (activeAccounts.length > 0) {
            setActiveSpectatorAccountId(activeAccounts[0].id);
         } else {
            setActiveSpectatorAccountId(null);
         }
         setSpectatorTab('overview');
         setSpectatorDate(new Date().toISOString().split('T')[0]);
      } catch (err) {
         console.error("Failed to enter spectator mode:", err);
         alert("Nepodařilo se načíst data tradera.\n\nMožné příčiny:\n• Protistrana ještě nepřijala vaši žádost o sledování\n• Spojení bylo zrušeno\n• Zkuste obnovit stránku");
         setIsSpectating(false);
      } finally {
         setLoading(false);
      }
   };

   // Derived Lists
   const incomingRequests = connections.filter(c => c.receiver_id === currentUserId && c.status === 'pending');
   const outgoingRequests = connections.filter(c => c.sender_id === currentUserId && c.status === 'pending');
   const following = connections.filter(c => c.sender_id === currentUserId && c.status === 'accepted');
   const followers = connections.filter(c => c.receiver_id === currentUserId && c.status === 'accepted');

   const filteredRemoteTrades = useMemo(() => {
      if (!spectatorData) return [];
      return spectatorData.trades
         .filter(t => {
            // Handle both YYYY-MM-DD and ISO strings
            const tDate = t.date.split(' ')[0].split('T')[0];
            const matchDate = tDate === spectatorDate;
            const matchAccount = activeSpectatorAccountId ? t.accountId === activeSpectatorAccountId : true;
            return matchDate && matchAccount;
         })
         .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
   }, [spectatorData, spectatorDate, activeSpectatorAccountId]);

   const dayPrep = useMemo(() =>
      spectatorData?.preps.find(p => p.date === spectatorDate),
      [spectatorData, spectatorDate]);

   const dayReview = useMemo(() =>
      spectatorData?.reviews.find(r => r.date === spectatorDate),
      [spectatorData, spectatorDate]);

   const globalCareerStats = useMemo(() => {
      if (!spectatorData) return null;
      const { trades, accounts } = spectatorData;

      const totalPnL = trades.reduce((sum, t) => sum + Number(t.pnl), 0);
      const totalPayouts = accounts.reduce((sum, a) => sum + (a.totalWithdrawals || 0) + (a.totalGrossWithdrawals || 0), 0);

      const winners = trades.filter(t => t.pnl > 0);
      const losers = trades.filter(t => t.pnl < 0);
      const winRate = trades.length > 0 ? (winners.length / trades.length) * 100 : 0;

      const grossProfit = winners.reduce((sum, t) => sum + t.pnl, 0);
      const grossLoss = Math.abs(losers.reduce((sum, t) => sum + t.pnl, 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 9.99 : 0);

      const riskyTrades = trades.filter(t => t.riskAmount && t.riskAmount > 0);
      const avgRR = riskyTrades.length > 0 ?
         (riskyTrades.reduce((sum, t) => sum + (Math.abs(t.pnl) / (t.riskAmount || 1)), 0) / riskyTrades.length)
         : 0;

      // Day Winrate & Best/Worst
      const dayMap: Record<string, number> = {};
      trades.forEach(t => {
         const d = t.date.split(' ')[0].split('T')[0];
         dayMap[d] = (dayMap[d] || 0) + Number(t.pnl);
      });
      const days = Object.values(dayMap);
      const winDays = days.filter(d => d > 0);
      const dayWinRate = days.length > 0 ? (winDays.length / days.length) * 100 : 0;

      const sortedDays = Object.entries(dayMap).sort((a, b) => b[1] - a[1]);
      const bestDay = sortedDays[0] || [null, 0];
      const worstDay = sortedDays[sortedDays.length - 1] || [null, 0];

      // Accounts Pass Rate
      const totalChallenges = accounts.filter(a => a.phase === 'Challenge' || a.type === 'Funded').length;
      const passedChallenges = accounts.filter(a => a.type === 'Funded').length;
      const passRate = totalChallenges > 0 ? (passedChallenges / totalChallenges) * 100 : 0;

      return {
         totalPnL,
         totalPayouts,
         winRate,
         profitFactor,
         avgRR,
         dayWinRate,
         bestDay: { date: bestDay[0], pnl: Number(bestDay[1]) },
         worstDay: { date: worstDay[0], pnl: Number(worstDay[1]) },
         passRate,
         totalTrades: trades.length,
         accountCount: accounts.length
      };
   }, [spectatorData]);

   const globalEquityCurve = useMemo(() => {
      if (!spectatorData || spectatorData.trades.length === 0) return [];
      const sortedTrades = [...spectatorData.trades]
         .reverse()
         .sort((a, b) => {
            const timeA = a.timestamp || new Date(a.date).getTime();
            const timeB = b.timestamp || new Date(b.date).getTime();
            return timeA - timeB;
         });

      let runningPnL = 0;
      return sortedTrades.map(t => {
         runningPnL += Number(t.pnl);
         // Use full date time for granularity, but formatted for display if needed
         // However, Recharts XAxis might need a numeric or string value. 
         // Let's use the full date string to preserve uniqueness for same-day trades.
         return {
            timestamp: t.date,
            pnl: runningPnL
         };
      });
   }, [spectatorData]);

   const dayPnL = useMemo(() =>
      filteredRemoteTrades.reduce((sum, t) => sum + Number(t.pnl), 0),
      [filteredRemoteTrades]);

   const copyToClipboard = (url: string) => {
      navigator.clipboard.writeText(url);
      alert("Odkaz zkopírován do schránky!");
   };

   // Detail Modal Component
   const DetailModal = ({ title, icon: Icon, onClose, children }: { title: string, icon: any, onClose: () => void, children: React.ReactNode }) => (
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 animate-in fade-in duration-300">
         <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />
         <div className={`relative w-full max-w-2xl max-h-[90vh] overflow-y-auto p-8 rounded-[32px] border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'} animate-in zoom-in-95 duration-300`}>
            <div className={`flex justify-between items-center mb-8 border-b pb-6 ${isDark ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
               <div className="flex items-center gap-4">
                  <div className="p-3 rounded-2xl bg-blue-600/10 text-blue-500"><Icon size={24} /></div>
                  <h3 className={`text-xl font-black italic tracking-tighter ${isDark ? 'text-white' : 'text-slate-900'}`}>{title}</h3>
               </div>
               <button onClick={onClose} className={`p-2 rounded-xl text-slate-500 hover:text-[var(--text-primary)] transition-all ${isDark ? 'hover:bg-[var(--text-primary)]/5' : 'hover:bg-slate-50'}`}><X size={24} /></button>
            </div>
            {children}
         </div>
      </div>
   );

   return (
      <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20">

         {/* Detail Modals */}
         {selectedTrade && (() => {
            const isWin = selectedTrade.pnl >= 0;
            const pnlColor = isWin ? 'text-emerald-500' : 'text-rose-500';
            const directionColor = selectedTrade.direction === 'Long' ? 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' : 'text-rose-500 bg-rose-500/10 border-rose-500/20';
            const riskAmount = parseFloat(String(selectedTrade.riskAmount || 0));
            const realRRR = (riskAmount !== 0 && riskAmount !== undefined) ? (Math.abs(selectedTrade.pnl) / riskAmount).toFixed(2) : 'N/A';
            const holdTime = selectedTrade.duration || (Math.round(selectedTrade.durationMinutes || 0) + 'm');
            const format = modalPnlFormat || 'usd'; // Default to USD if not set

            return (
               <DetailModal title="SNAPSHOT OBCHODU" icon={ShieldCheck} onClose={() => setSelectedTrade(null)}>
                  <div className="space-y-6">
                     {/* Premium Header like Shared View */}
                     <div className={`flex items-center justify-between p-6 rounded-3xl border ${isDark ? 'bg-[var(--bg-page)]/50 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                        <div className="flex items-center gap-6">
                           <div className={`px-3 py-1.5 rounded-xl border flex items-center gap-2 ${directionColor}`}>
                              {selectedTrade.direction === 'Long' ? <ArrowUpRight size={16} strokeWidth={3} /> : <ArrowDownRight size={16} strokeWidth={3} />}
                              <span className="text-[10px] font-black uppercase tracking-widest">{selectedTrade.direction}</span>
                           </div>
                           <div>
                              <h2 className="text-xl font-black tracking-tighter uppercase text-white leading-none">{selectedTrade.instrument}</h2>
                              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">{new Date(selectedTrade.date).toLocaleString('cs-CZ')}</p>
                           </div>
                        </div>
                        <div className="text-right">
                           <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest mb-1">Výsledek</p>
                           <div className={`text-2xl font-black font-mono tracking-tighter leading-none ${pnlColor}`}>
                              {formatPnL(
                                 selectedTrade.pnl,
                                 format === 'hidden' ? 'usd' : format as any,
                                 undefined,
                                 format === 'rr' ? (selectedTrade.pnl / (selectedTrade.riskAmount || 1)) : undefined
                              )}
                           </div>
                        </div>
                     </div>

                     {/* Stats Grid */}
                     <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className={`p-4 rounded-2xl border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                           <p className="text-[9px] font-black text-slate-500 uppercase mb-1">Vstupní cena</p>
                           <p className={`text-lg font-black font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>{selectedTrade.entryPrice || '-'}</p>
                        </div>
                        <div className={`p-4 rounded-2xl border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                           <p className="text-[9px] font-black text-slate-500 uppercase mb-1">Výstupní cena</p>
                           <p className={`text-lg font-black font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>{selectedTrade.exitPrice || '-'}</p>
                        </div>
                        <div className={`p-4 rounded-2xl border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                           <p className="text-[9px] font-black text-slate-500 uppercase mb-1">Realizované RRR</p>
                           <p className={`text-lg font-black font-mono ${parseFloat(realRRR) > 1 ? 'text-emerald-500' : 'text-slate-400'}`}>{realRRR}R</p>
                        </div>
                        <div className={`p-4 rounded-2xl border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                           <p className="text-[9px] font-black text-slate-500 uppercase mb-1">Doba držení</p>
                           <p className="text-lg font-black text-blue-400 font-mono">{holdTime}</p>
                        </div>
                     </div>

                     <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-6">
                           <div className="space-y-3">
                              <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Zap size={14} /> Kontext a Signál</p>
                              <p className="text-sm text-white font-bold">{selectedTrade.signal || 'Bez signálu'}</p>
                              <div className="flex flex-wrap gap-2">
                                 {selectedTrade.htfConfluence?.map(t => <span key={t} className="px-2 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[8px] font-black uppercase">{t}</span>)}
                                 {selectedTrade.ltfConfluence?.map(t => <span key={t} className="px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[8px] font-black uppercase">{t}</span>)}
                              </div>
                           </div>
                           <div className="space-y-3">
                              <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><FileText size={14} /> Poznámky Tradera</p>
                              <div className={`p-4 rounded-xl border text-xs italic leading-relaxed ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-page)] text-slate-300' : 'bg-slate-50 border-slate-100 text-slate-600'}`}>
                                 {selectedTrade.notes || "Bez poznámek."}
                              </div>
                           </div>
                        </div>

                        <div className="space-y-3">
                           <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest flex items-center gap-2"><Monitor size={14} /> Vizuální důkazy</p>
                           {(selectedTrade.screenshots?.length || selectedTrade.screenshot) ? (
                              <div className="space-y-2">
                                 {(selectedTrade.screenshots || [selectedTrade.screenshot]).map((src, i) => src && (
                                    <div key={i} className={`rounded-xl border overflow-hidden cursor-zoom-in group relative ${isDark ? 'border-[var(--border-subtle)]' : 'border-slate-200'}`} onClick={() => setZoomedImage(src)}>
                                       <img src={src} alt="Chart" className="w-full h-auto" />
                                       <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                          <Search size={20} className="text-white" />
                                       </div>
                                    </div>
                                 ))}
                              </div>
                           ) : (
                              <div className={`p-8 rounded-2xl border border-dashed text-center flex flex-col items-center justify-center gap-2 ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-page)]/20' : 'border-slate-200 bg-slate-50'}`}>
                                 <BarChart2 size={32} className={isDark ? 'text-slate-800' : 'text-slate-300'} />
                                 <p className={`text-[9px] font-black uppercase ${isDark ? 'text-slate-700' : 'text-slate-400'}`}>Chybí vizuály</p>
                              </div>
                           )}
                        </div>
                     </div>
                  </div>
               </DetailModal>
            );
         })()}

         {selectedPrep && (
            <DetailModal title="RANNÍ ANALÝZA" icon={Sun} onClose={() => setSelectedPrep(null)}>
               <div className="space-y-6">
                  {/* Bullish Section */}
                  <div className="space-y-3">
                     <div className="p-6 rounded-2xl bg-emerald-500/5 border border-emerald-500/10">
                        <p className="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-2 flex items-center gap-2"><ArrowUpRight size={14} /> Bullish Scénář</p>
                        <p className="text-sm text-slate-200 leading-relaxed">{selectedPrep.scenarios.bullish || 'Trader nedefinoval bullish scénář.'}</p>
                     </div>
                     {selectedPrep.scenarios.bullishImage && (
                        <div className={`rounded-2xl border overflow-hidden cursor-zoom-in group relative ${isDark ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
                           <img src={selectedPrep.scenarios.bullishImage} alt="Bullish Chart" className="w-full h-auto" />
                           <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <Search size={24} className="text-white" />
                           </div>
                        </div>
                     )}
                  </div>

                  {/* Bearish Section */}
                  <div className="space-y-3">
                     <div className="p-6 rounded-2xl bg-rose-500/5 border border-rose-500/10">
                        <p className="text-[10px] font-black text-rose-500 uppercase tracking-widest mb-2 flex items-center gap-2"><ArrowDownRight size={14} /> Bearish Scénář</p>
                        <p className="text-sm text-slate-200 leading-relaxed">{selectedPrep.scenarios.bearish || 'Trader nedefinoval bearish scénář.'}</p>
                     </div>
                     {selectedPrep.scenarios.bearishImage && (
                        <div className={`rounded-2xl border overflow-hidden cursor-zoom-in group relative ${isDark ? 'border-[var(--border-subtle)]' : 'border-slate-100'}`}>
                           <img src={selectedPrep.scenarios.bearishImage} alt="Bearish Chart" className="w-full h-auto" />
                           <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                              <Search size={24} className="text-white" />
                           </div>
                        </div>
                     )}
                  </div>

                  <div className={`p-6 rounded-2xl border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                     <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-2"><Clock size={14} /> Myšlenkové nastavení</p>
                     <p className={`text-sm leading-relaxed italic ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{selectedPrep.mindsetState || 'Žádné doplňující poznámky k přípravě.'}</p>
                  </div>
               </div>
            </DetailModal>
         )}

         {selectedReview && (
            <DetailModal title="VEČERNÍ REVIEW" icon={Moon} onClose={() => setSelectedReview(null)}>
               <div className="space-y-6">
                  {/* Discipline Rating Header */}
                  <div className={`p-8 rounded-[32px] border text-center ${isDark ? 'bg-blue-600/10 border-blue-500/20' : 'bg-blue-50 border-blue-100'}`}>
                     <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-3">Rating Disciplíny</p>
                     <div className="flex justify-center gap-1.5">
                        {[1, 2, 3, 4, 5].map(s => (
                           <Star key={s} size={28} className={s <= (selectedReview.rating || 0) ? 'text-yellow-500 fill-yellow-500' : (isDark ? 'text-slate-700' : 'text-slate-200')} />
                        ))}
                     </div>
                  </div>

                  {/* Rules and Mistakes Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                     {/* Rule Adherence */}
                     <div className={`p-6 rounded-2xl border space-y-4 ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><ShieldCheck size={14} /> Dodržení pravidel</p>
                        <div className="space-y-2">
                           {selectedReview.ruleAdherence && selectedReview.ruleAdherence.length > 0 ? (
                              selectedReview.ruleAdherence.map((rule, idx) => {
                                 const ruleLabel = spectatorData?.preferences?.ironRules?.find(r => r.id === rule.ruleId)?.label || 'Neznámé pravidlo';
                                 return (
                                    <div key={idx} className={`flex items-center justify-between p-2 rounded-lg ${isDark ? 'bg-black/20' : 'bg-white/50'}`}>
                                       <span className="text-[10px] font-bold text-slate-400 truncate pr-2">{ruleLabel}</span>
                                       <span className={`text-[8px] font-black uppercase px-2 py-0.5 rounded ${rule.status === 'Pass' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                                          {rule.status}
                                       </span>
                                    </div>
                                 );
                              })
                           ) : (
                              <p className="text-[10px] text-slate-600 italic">Nebyla definována žádná pravidla.</p>
                           )}
                        </div>
                     </div>

                     {/* Mistakes */}
                     <div className={`p-6 rounded-2xl border space-y-4 ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-2"><AlertTriangle size={14} /> Chyby dne</p>
                        <div className="flex flex-wrap gap-2">
                           {selectedReview.mistakes && selectedReview.mistakes.length > 0 ? (
                              selectedReview.mistakes.filter(m => m.trim() !== '').map((m, idx) => (
                                 <span key={idx} className="px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[10px] font-black uppercase">
                                    {m}
                                 </span>
                              ))
                           ) : (
                              <p className="text-[10px] text-slate-600 italic">Žádné chyby nebyly zaznamenány.</p>
                           )}
                           {(!selectedReview.mistakes || selectedReview.mistakes.filter(m => m.trim() !== '').length === 0) && (
                              <div className="flex items-center gap-2 text-emerald-500/50">
                                 <Check size={14} />
                                 <span className="text-[10px] font-black uppercase">Bez chyb</span>
                              </div>
                           )}
                        </div>
                     </div>
                  </div>

                  {/* Personal Reflections */}
                  <div className={`p-6 rounded-2xl border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                     <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-2"><FileText size={14} /> Reflexe & Poznámky</p>
                     {selectedReview.mainTakeaway === null ? (
                        <div className="flex flex-col items-center justify-center py-8 opacity-40 select-none">
                           <Lock size={24} className="mb-2" />
                           <p className="text-xs font-black uppercase tracking-widest">Tento obsah je soukromý</p>
                        </div>
                     ) : (
                        <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap italic">
                           {selectedReview.psycho?.notes || selectedReview.mainTakeaway || 'Žádné poznámky k tomuto dni.'}
                        </p>
                     )}
                  </div>
               </div>
            </DetailModal>
         )}


         {/* Permission Modal */}
         {editingPermissions && (
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
               <div className={`w-full max-w-sm p-6 rounded-[24px] border shadow-2xl animate-in zoom-in-95 duration-200 ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                  <div className="flex items-start justify-between mb-6">
                     <div>
                        <h3 className={`text-lg font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>Nastavení soukromí</h3>
                        <p className="text-xs text-slate-500 font-bold uppercase tracking-widest mt-1">pro: {editingPermissions.name}</p>
                     </div>
                     <button onClick={() => setEditingPermissions(null)} className="p-2 rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-all dark:hover:bg-white/10 dark:hover:text-white"><X size={20} /></button>
                  </div>

                  <div className="space-y-6">
                     {/* Section: TRADES */}
                     <div className="space-y-3">
                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest pl-1">Obchody</p>

                        {/* PnL Format Selector */}
                        <div className={`p-4 rounded-xl border flex flex-col gap-3 ${isDark ? 'bg-[var(--bg-input)]/30 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-200'}`}>
                           <div className="flex items-center gap-3">
                              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500"><DollarSign size={16} /></div>
                              <div>
                                 <p className={`text-sm font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>Zobrazení Zisku (PnL)</p>
                                 <p className="text-[10px] text-slate-500">Jak uvidí tento uživatel vaše výsledky?</p>
                              </div>
                           </div>
                           <div className="grid grid-cols-3 gap-2">
                              {[
                                 { id: 'hidden', label: 'Skryté', icon: EyeOff },
                                 { id: 'usd', label: 'Částka ($)', icon: DollarSign }
                              ].map(mode => (
                                 <button
                                    key={mode.id}
                                    onClick={() => {
                                       const newPerms = {
                                          ...editingPermissions.permissions,
                                          pnlFormat: mode.id as any,
                                          // Ensure legacy fields are present
                                          canSeeNotes: editingPermissions.permissions.canSeeReviewNotes ?? false
                                       };
                                       setEditingPermissions({ ...editingPermissions, permissions: newPerms });
                                       storageService.updateConnectionPermissions(editingPermissions.connectionId, newPerms);
                                       setConnections(prev => prev.map(c => c.id === editingPermissions.connectionId ? { ...c, permissions: newPerms } : c));
                                    }}
                                    className={`py-2 rounded-lg text-[10px] font-black uppercase flex flex-col items-center gap-1 transition-all border ${editingPermissions.permissions.pnlFormat === mode.id ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-600/20' : 'bg-transparent border-transparent text-slate-500 hover:bg-slate-200 dark:hover:bg-white/5'}`}
                                 >
                                    <mode.icon size={14} /> {mode.label}
                                 </button>
                              ))}
                           </div>
                        </div>

                        {/* Screenshots Toggle */}
                        <div className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${editingPermissions.permissions.canSeeScreenshots ? 'bg-blue-600/10 border-blue-500/30' : 'bg-transparent border-transparent hover:bg-slate-50 dark:hover:bg-white/5'}`}
                           onClick={() => {
                              const newPerms = {
                                 ...editingPermissions.permissions,
                                 canSeeScreenshots: !editingPermissions.permissions.canSeeScreenshots,
                                 canSeeNotes: editingPermissions.permissions.canSeeReviewNotes ?? false
                              };
                              setEditingPermissions({ ...editingPermissions, permissions: newPerms });
                              storageService.updateConnectionPermissions(editingPermissions.connectionId, newPerms);
                              setConnections(prev => prev.map(c => c.id === editingPermissions.connectionId ? { ...c, permissions: newPerms } : c));
                           }}
                        >
                           <div className="flex items-center gap-3">
                              <div className={`p-1.5 rounded-lg ${editingPermissions.permissions.canSeeScreenshots ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500 dark:bg-white/10'}`}><Eye size={14} /></div>
                              <span className={`text-xs font-bold ${editingPermissions.permissions.canSeeScreenshots ? 'text-blue-500' : 'text-slate-500'}`}>Zobrazit Screenshoty</span>
                           </div>
                           <div className={`w-8 h-4 rounded-full relative transition-colors ${editingPermissions.permissions.canSeeScreenshots ? 'bg-blue-600' : 'bg-slate-300 dark:bg-white/10'}`}>
                              <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all shadow-sm ${editingPermissions.permissions.canSeeScreenshots ? 'left-4.5 translate-x-full' : 'left-0.5'}`} style={{ left: editingPermissions.permissions.canSeeScreenshots ? 'calc(100% - 14px)' : '2px' }} />
                           </div>
                        </div>
                     </div>

                     {/* Section: PREP */}
                     <div className="space-y-3">
                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest pl-1">Ranní Příprava</p>
                        <div className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition-all ${editingPermissions.permissions.canSeePrep ? 'bg-amber-500/10 border-amber-500/30' : 'bg-transparent border-transparent hover:bg-slate-50 dark:hover:bg-white/5'}`}
                           onClick={() => {
                              const newPerms = {
                                 ...editingPermissions.permissions,
                                 canSeePrep: !editingPermissions.permissions.canSeePrep,
                                 canSeeNotes: editingPermissions.permissions.canSeeReviewNotes ?? false
                              };
                              setEditingPermissions({ ...editingPermissions, permissions: newPerms });
                              storageService.updateConnectionPermissions(editingPermissions.connectionId, newPerms);
                              setConnections(prev => prev.map(c => c.id === editingPermissions.connectionId ? { ...c, permissions: newPerms } : c));
                           }}
                        >
                           <div className="flex items-center gap-3">
                              <div className={`p-1.5 rounded-lg ${editingPermissions.permissions.canSeePrep ? 'bg-amber-500 text-white' : 'bg-slate-200 text-slate-500 dark:bg-white/10'}`}><Sun size={14} /></div>
                              <span className={`text-xs font-bold ${editingPermissions.permissions.canSeePrep ? 'text-amber-500' : 'text-slate-500'}`}>Povolit zobrazení analýzy</span>
                           </div>
                           <div className={`w-8 h-4 rounded-full relative transition-colors ${editingPermissions.permissions.canSeePrep ? 'bg-amber-500' : 'bg-slate-300 dark:bg-white/10'}`}>
                              <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all shadow-sm`} style={{ left: editingPermissions.permissions.canSeePrep ? 'calc(100% - 14px)' : '2px' }} />
                           </div>
                        </div>
                     </div>

                     {/* Section: REVIEW */}
                     <div className="space-y-3">
                        <p className="text-[10px] font-black uppercase text-slate-500 tracking-widest pl-1">Večerní Review</p>
                        <div className="grid grid-cols-2 gap-3">
                           {/* Rating & Stats */}
                           <div className={`p-3 rounded-xl border flex flex-col gap-2 cursor-pointer transition-all ${editingPermissions.permissions.canSeeReviewStats ? 'bg-indigo-500/10 border-indigo-500/30' : 'bg-transparent border-transparent hover:bg-slate-50 dark:hover:bg-white/5'}`}
                              onClick={() => {
                                 const newPerms = {
                                    ...editingPermissions.permissions,
                                    canSeeReviewStats: !editingPermissions.permissions.canSeeReviewStats,
                                    canSeeNotes: editingPermissions.permissions.canSeeReviewNotes ?? false
                                 };
                                 setEditingPermissions({ ...editingPermissions, permissions: newPerms });
                                 storageService.updateConnectionPermissions(editingPermissions.connectionId, newPerms);
                                 setConnections(prev => prev.map(c => c.id === editingPermissions.connectionId ? { ...c, permissions: newPerms } : c));
                              }}
                           >
                              <div className={`self-start p-1.5 rounded-lg ${editingPermissions.permissions.canSeeReviewStats ? 'bg-indigo-500 text-white' : 'bg-slate-200 text-slate-500 dark:bg-white/10'}`}><Star size={14} /></div>
                              <p className={`text-[10px] font-black uppercase ${editingPermissions.permissions.canSeeReviewStats ? 'text-indigo-400' : 'text-slate-500'}`}>Rating & Chyby</p>
                           </div>

                           {/* Notes & Psycho */}
                           <div className={`p-3 rounded-xl border flex flex-col gap-2 cursor-pointer transition-all ${editingPermissions.permissions.canSeeReviewNotes ? 'bg-rose-500/10 border-rose-500/30' : 'bg-transparent border-transparent hover:bg-slate-50 dark:hover:bg-white/5'}`}
                              onClick={() => {
                                 const newPerms = {
                                    ...editingPermissions.permissions,
                                    canSeeReviewNotes: !editingPermissions.permissions.canSeeReviewNotes,
                                    canSeeNotes: !editingPermissions.permissions.canSeeReviewNotes // Sync legacy
                                 };
                                 setEditingPermissions({ ...editingPermissions, permissions: newPerms });
                                 storageService.updateConnectionPermissions(editingPermissions.connectionId, newPerms);
                                 setConnections(prev => prev.map(c => c.id === editingPermissions.connectionId ? { ...c, permissions: newPerms } : c));
                              }}
                           >
                              <div className={`self-start p-1.5 rounded-lg ${editingPermissions.permissions.canSeeReviewNotes ? 'bg-rose-500 text-white' : 'bg-slate-200 text-slate-500 dark:bg-white/10'}`}><Brain size={14} /></div>
                              <p className={`text-[10px] font-black uppercase ${editingPermissions.permissions.canSeeReviewNotes ? 'text-rose-400' : 'text-slate-500'}`}>Poznámky & Psycho</p>
                           </div>
                        </div>
                     </div>
                  </div>

                  <div className="mt-6 pt-6 border-t border-slate-100 dark:border-white/5">
                     <button onClick={() => setEditingPermissions(null)} className="w-full py-3 rounded-xl bg-slate-900 text-white font-black text-xs uppercase tracking-widest hover:bg-slate-800 transition-all dark:bg-white dark:text-slate-900 hover:scale-[1.02]">
                        Uložit nastavení
                     </button>
                  </div>
               </div>
            </div>
         )}

         {/* Layout and Tabs */}
         <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
            <div>
               <h2 className="text-4xl font-black tracking-tighter italic">NETWORK HUB</h2>
               <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-500">Secure Trader Networking</p>
            </div>
            <div className="p-1.5 rounded-2xl flex gap-1 theme-card theme-border shadow-sm">
               {[
                  { id: 'leaderboard', label: 'Žebříček', icon: Trophy },
                  { id: 'following', label: 'Sledovaní', icon: Users },
                  { id: 'followers', label: 'Sledující', icon: UserIcon },
                  { id: 'requests', label: 'Žádosti', icon: MessageSquare, badge: incomingRequests.length }
               ].map(tab => (
                  <button
                     key={tab.id}
                     onClick={() => setActiveTab(tab.id as any)}
                     className={`px-4 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 relative ${activeTab === tab.id ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-500 hover:text-slate-300'}`}
                  >
                     <tab.icon size={12} /> {tab.label}
                     {tab.badge ? <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-rose-500 text-[8px] flex items-center justify-center text-white border-2 border-[#0B1120] animate-pulse">{tab.badge}</span> : null}
                  </button>
               ))}
            </div>
         </div>

         {/* Search Interface */}
         <div className="relative group">
            <div className="absolute inset-y-0 left-6 flex items-center text-slate-500 group-focus-within:text-blue-500 transition-colors"><Users size={18} /></div>
            <input
               type="text"
               value={searchQuery}
               onChange={(e) => handleSearch(e.target.value)}
               placeholder="Vyhledat tradera podle e-mailu nebo jména..."
               className="w-full pl-14 pr-6 py-5 rounded-[24px] border outline-none font-bold text-sm transition-all shadow-xl theme-input focus:border-blue-500/50"
            />
            {isSearching && <div className="absolute inset-y-0 right-6 flex items-center"><div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div></div>}

            {searchResults.length > 0 && (
               <div className="absolute top-full left-0 right-0 mt-2 z-50 rounded-[24px] border p-2 shadow-2xl animate-in fade-in slide-in-from-top-2 duration-300 theme-card theme-border">
                  {searchResults.map(user => (
                     <div key={user.id} className={`flex items-center justify-between p-4 rounded-xl transition-all ${isDark ? 'hover:bg-[var(--text-primary)]/5' : 'hover:bg-slate-50'}`}>
                        <div className="flex items-center gap-3">
                           <div className="w-10 h-10 rounded-xl bg-blue-500/20 text-blue-500 flex items-center justify-center font-black text-xs uppercase">{user.full_name?.substring(0, 2) || 'UT'}</div>
                           <div>
                              <p className={`text-sm font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{user.full_name || 'Uživatel'}</p>
                              <p className="text-[10px] text-slate-500 font-bold">{user.email}</p>
                           </div>
                        </div>
                        <button
                           onClick={() => sendRequest(user.id)}
                           className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2"
                        >
                           <UserPlus size={14} /> Sledovat
                        </button>
                     </div>
                  ))}
               </div>
            )}
         </div>

         {/* PULSE CONTENT */}
         {/* LEADERBOARD CONTENT */}
         {activeTab === 'leaderboard' && (
            <div className="space-y-6">
               <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-2"><Trophy size={14} className="text-yellow-500" /> Elitní Žebříček</h3>

               {loadingLeaderboard ? (
                  <div className="py-20 flex flex-col items-center justify-center opacity-50">
                     <Loader2 size={40} className="animate-spin text-blue-500 mb-4" />
                     <p className="text-xs font-black uppercase tracking-widest">Počítám statistiky...</p>
                  </div>
               ) : leaderboardStats.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-center space-y-6 opacity-60">
                     <div className={`p-6 rounded-full border ${isDark ? 'bg-[var(--bg-input)] text-slate-600 border-[var(--border-subtle)]' : 'bg-slate-100 text-slate-400 border-slate-200'}`}>
                        <Trophy size={48} />
                     </div>
                     <div>
                        <h3 className="text-xl font-black uppercase tracking-widest text-slate-500">Žádná data</h3>
                        <p className="text-xs text-slate-600 mt-2 max-w-sm mx-auto">Sledujte tradery pro porovnání výsledků.</p>
                     </div>
                  </div>
               ) : (
                  <div className={`overflow-hidden rounded-[24px] border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                     <table className="w-full">
                        <thead>
                           <tr className={`border-b ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-page)]/50' : 'border-slate-100 bg-slate-50'}`}>
                              <th className="px-6 py-4 text-left text-[9px] font-black uppercase tracking-widest text-slate-500">Rank</th>
                              <th className="px-6 py-4 text-left text-[9px] font-black uppercase tracking-widest text-slate-500">Trader</th>
                              <th className="px-6 py-4 text-right text-[9px] font-black uppercase tracking-widest text-slate-500">Win Rate</th>
                              <th className="px-6 py-4 text-right text-[9px] font-black uppercase tracking-widest text-slate-500">Disciplína</th>
                              <th className="px-6 py-4 text-right text-[9px] font-black uppercase tracking-widest text-slate-500">Obchody</th>
                           </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-white/5">
                           {leaderboardStats.sort((a, b) => b.winRate - a.winRate).map((user, idx) => (
                              <tr key={user.id} className={`group cursor-pointer hover:bg-blue-500/5 transition-colors`}>
                                 <td className="px-6 py-4">
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-black text-xs border-2 ${idx === 0 ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500' :
                                       idx === 1 ? 'bg-slate-400/10 text-slate-400 border-slate-400' :
                                          idx === 2 ? 'bg-amber-700/10 text-amber-700 border-amber-700' :
                                             'bg-transparent text-slate-500 border-transparent'
                                       }`}>
                                       {idx + 1}
                                    </div>
                                 </td>
                                 <td className="px-6 py-4">
                                    <div className="flex items-center gap-3">
                                       <div className="w-8 h-8 rounded-lg bg-blue-600/20 text-blue-500 flex items-center justify-center text-xs font-black uppercase">{user.name?.substring(0, 2)}</div>
                                       <span className={`font-black text-sm ${isDark ? 'text-white' : 'text-slate-900'}`}>{user.name}</span>
                                    </div>
                                 </td>
                                 <td className="px-6 py-4 text-right">
                                    <span className={`font-black font-mono ${user.winRate >= 50 ? 'text-emerald-500' : 'text-rose-500'}`}>{user.winRate.toFixed(1)}%</span>
                                 </td>
                                 <td className="px-6 py-4 text-right">
                                    <div className="flex items-center justify-end gap-1">
                                       <Star size={14} className="text-yellow-500 fill-yellow-500" />
                                       <span className={`font-black font-mono ${isDark ? 'text-white' : 'text-slate-900'}`}>{user.discipline.toFixed(1)}</span>
                                    </div>
                                 </td>
                                 <td className="px-6 py-4 text-right">
                                    <span className="text-xs font-bold text-slate-500">{user.tradeCount}</span>
                                 </td>
                              </tr>
                           ))}
                        </tbody>
                     </table>
                  </div>
               )}
            </div>
         )}

         {/* PULSE CONTENT */}


         {/* Content Tabs */}
         {activeTab === 'requests' && (
            <div className="space-y-6">
               <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-2"><MessageSquare size={14} /> Žádosti o propojení</h3>
               {incomingRequests.length === 0 ? (
                  <div className={`p-12 text-center rounded-[32px] border border-dashed ${isDark ? 'border-[var(--border-subtle)] bg-[var(--bg-page)]/50 text-slate-600' : 'border-slate-200 bg-slate-50 text-slate-400'}`}>
                     <p className="text-sm font-black uppercase tracking-widest">Žádné nové žádosti</p>
                  </div>
               ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                     {incomingRequests.map(req => (
                        <div key={req.id} className={`p-6 rounded-[24px] border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'} flex items-center justify-between`}>
                           <div className="flex items-center gap-4">
                              <div className="w-12 h-12 rounded-2xl bg-blue-600/10 text-blue-500 flex items-center justify-center font-black uppercase">{req.sender?.name?.substring(0, 2) || 'UT'}</div>
                              <div>
                                 <p className="font-black text-white">{req.sender?.name || 'Trader'}</p>
                                 <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest">Vás chce sledovat</p>
                              </div>
                           </div>
                           <div className="flex gap-2">
                              <button onClick={() => handleRequestAction(req.id, 'accepted')} className="p-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-400 shadow-lg shadow-emerald-500/20 transition-all"><CheckCircle2 size={20} /></button>
                              <button onClick={() => handleRequestAction(req.id, 'rejected')} className="p-2 rounded-lg bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white transition-all"><X size={20} /></button>
                           </div>
                        </div>
                     ))}
                  </div>
               )}

               {outgoingRequests.length > 0 && (
                  <>
                     <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-2 mt-8"><Clock size={14} /> Odeslané žádosti</h3>
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {outgoingRequests.map(req => (
                           <div key={req.id} className={`p-6 rounded-[24px] border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'} flex items-center justify-between`}>
                              <div className="flex items-center gap-4">
                                 <div className="w-12 h-12 rounded-2xl bg-amber-500/10 text-amber-500 flex items-center justify-center font-black uppercase">{req.receiver?.name?.substring(0, 2) || 'UT'}</div>
                                 <div>
                                    <p className={`font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{req.receiver?.name || 'Trader'}</p>
                                    <p className="text-[10px] text-amber-500 uppercase font-black tracking-widest">Čeká na schválení</p>
                                 </div>
                              </div>
                              <button onClick={() => handleRequestAction(req.id, 'rejected')} className="p-2 rounded-lg bg-rose-500/10 text-rose-500 hover:bg-rose-500 hover:text-white transition-all" title="Zrušit žádost"><X size={20} /></button>
                           </div>
                        ))}
                     </div>
                  </>
               )}
            </div>
         )}

         {activeTab === 'following' && (
            <div className="space-y-6">
               <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-2"><Shield size={14} /> Sledovaní Tradeři</h3>
               {following.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-center space-y-6 opacity-60">
                     <div className={`p-6 rounded-full border ${isDark ? 'bg-[var(--bg-input)] text-slate-600 border-[var(--border-subtle)]' : 'bg-slate-100 text-slate-400 border-slate-200'}`}>
                        <Terminal size={48} />
                     </div>
                     <div>
                        <h3 className="text-xl font-black uppercase tracking-widest text-slate-500">Nikdo k propojení</h3>
                        <p className="text-xs text-slate-600 mt-2 max-w-sm mx-auto">Zatím nesledujete žádné jiné tradery. Vyhledejte je e-mailem výše.</p>
                     </div>
                  </div>
               ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                     {following.map(conn => {
                        const target = conn.sender_id === currentUserId ? conn.receiver : conn.sender;
                        if (!target) return null;
                        return (
                           <div key={conn.id} className={`group p-6 rounded-[24px] border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                              <div className="flex justify-between items-start mb-6">
                                 <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 rounded-2xl bg-blue-600/10 text-blue-500 flex items-center justify-center font-black uppercase text-lg">{target.name?.substring(0, 2)}</div>
                                    <div>
                                       <h4 className={`text-lg font-black ${isDark ? 'text-white' : 'text-slate-900'}`}>{target.name}</h4>
                                       <span className="text-[9px] font-bold text-emerald-500 uppercase tracking-widest">Sleduji</span>
                                    </div>
                                 </div>
                              </div>
                              <div className="flex gap-2">
                                 <button
                                    className={`flex-1 py-3 border rounded-xl text-xs font-black uppercase transition-all flex items-center justify-center gap-2 ${isDark ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] hover:bg-blue-600 hover:text-white text-slate-400' : 'bg-slate-50 border-slate-200 hover:bg-blue-600 hover:text-white text-slate-600'}`}
                                    onClick={() => enterSpectatorMode(target.id)}
                                 >
                                    <Monitor size={14} /> Vstoupit
                                 </button>
                                 <button onClick={() => handleRequestAction(conn.id, 'rejected')} className={`px-3 rounded-xl border transition-all ${isDark ? 'border-[var(--border-subtle)] text-slate-600 hover:text-rose-500 hover:bg-rose-500/10' : 'border-slate-100 text-slate-400 hover:text-rose-500 hover:bg-rose-50'}`}><Trash2 size={16} /></button>
                              </div>
                           </div>
                        );
                     })}
                  </div>
               )}
            </div>
         )}

         {activeTab === 'followers' && (
            <div className="space-y-6">
               <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-2"><UserIcon size={14} /> Vaši Sledující</h3>
               {followers.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-center opacity-40">
                     <p className="text-xs font-black uppercase tracking-widest">Zatím vás nikdo nesleduje</p>
                  </div>
               ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                     {followers.map(conn => (
                        <div key={conn.id} className={`p-6 rounded-[24px] border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'} flex items-center justify-between`}>
                           <div className="flex items-center gap-4">
                              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black uppercase ${isDark ? 'bg-[var(--bg-input)] text-white' : 'bg-slate-100 text-slate-600'}`}>{conn.sender?.name?.substring(0, 2)}</div>
                              <div>
                                 <p className="font-black text-white">{conn.sender?.name}</p>
                                 <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Sleduje váš deník</p>
                              </div>
                           </div>
                           <div className="flex gap-2">
                              <button
                                 onClick={() => setEditingPermissions({
                                    connectionId: conn.id,
                                    permissions: conn.permissions || { canSeePnl: false, canSeeNotes: false, canSeeScreenshots: false },
                                    name: conn.sender?.name || 'Trader'
                                 })}
                                 className={`p-2 rounded-xl transition-all ${isDark ? 'bg-[var(--bg-input)] text-slate-400 hover:text-blue-400' : 'bg-slate-100 text-slate-600 hover:text-blue-600'}`}
                              >
                                 <Settings size={18} />
                              </button>
                              <button onClick={() => handleRequestAction(conn.id, 'rejected')} className={`p-2 rounded-xl text-slate-600 hover:text-rose-500 transition-all ${isDark ? 'bg-[var(--bg-input)] hover:bg-rose-500/10' : 'bg-slate-100 hover:bg-rose-50'}`}><Trash2 size={18} /></button>
                           </div>
                        </div>
                     ))}
                  </div>
               )}
            </div>
         )}



         {/* Spectator Mode Overlay */}
         {isSpectating && (
            <div className={`fixed inset-0 z-[100] animate-in fade-in duration-500 flex flex-col ${isDark ? 'bg-[var(--bg-page)]' : 'bg-slate-50'}`}>
               {/* Spectator Header */}
               <div className={`p-4 border-b flex items-center justify-between ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                  <div className="flex items-center gap-4">
                     <button
                        onClick={() => setIsSpectating(false)}
                        className={`p-2 rounded-xl transition-all ${isDark ? 'bg-[var(--bg-input)] text-slate-400 hover:text-white' : 'bg-slate-100 text-slate-600'}`}
                     >
                        <ChevronLeft size={20} />
                     </button>
                     <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-blue-600/20 text-blue-500 flex items-center justify-center text-xs font-black uppercase">{spectatingUser?.name?.substring(0, 2)}</div>
                        <div>
                           <div className="flex items-center gap-2">
                              <h4 className="text-xs font-black text-white uppercase tracking-widest">{spectatingUser?.name}</h4>
                              <div className="px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-500 text-[8px] font-black uppercase border border-emerald-500/20">LIVE SPECTATOR</div>
                           </div>
                           <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-0.5">Vzdálená relace zabezpečená protokolem AlphaNetwork</p>
                        </div>
                     </div>
                  </div>
                  <div className="flex items-center gap-4">
                     <div className={`hidden md:flex items-center gap-6 px-4 py-2 rounded-xl border ${isDark ? 'bg-[var(--bg-input)]/50 border-[var(--border-subtle)]' : 'bg-slate-50 border-slate-100'}`}>
                        <div className="text-center">
                           <p className="text-[8px] text-slate-500 font-black uppercase">Účet</p>
                           {spectatorData && spectatorData.accounts.length > 1 ? (
                              <select
                                 value={activeSpectatorAccountId || ''}
                                 onChange={(e) => setActiveSpectatorAccountId(e.target.value)}
                                 className="bg-transparent text-white font-black text-[10px] uppercase outline-none border-none py-1 px-2 cursor-pointer transition-all hover:text-blue-400"
                              >
                                 {spectatorData.accounts.map(acc => (
                                    <option key={acc.id} value={acc.id} className={isDark ? 'bg-[var(--bg-card)] text-white' : 'bg-white text-slate-900'}>
                                       {acc.name}
                                    </option>
                                 ))}
                              </select>
                           ) : (
                              <p className="text-[10px] text-white font-black uppercase">
                                 {spectatorData?.accounts.find(a => a.id === activeSpectatorAccountId)?.name || 'Neznámý'}
                              </p>
                           )}
                        </div>
                        <div className={`w-px h-6 ${isDark ? 'bg-[var(--border-subtle)]' : 'bg-slate-200'}`} />
                        <div className="text-center">
                           <p className="text-[8px] font-black text-slate-500 uppercase">Obchody</p>
                           <p className="text-[10px] text-emerald-500 font-black uppercase">
                              {spectatorData?.trades.filter(t => t.accountId === activeSpectatorAccountId).length || 0}
                           </p>
                        </div>
                     </div>
                     <button
                        onClick={() => setIsSpectating(false)}
                        className="px-4 py-2 bg-rose-500 hover:bg-rose-400 text-white rounded-lg text-[10px] font-black uppercase tracking-widest transition-all"
                     >
                        Odpojit relaci
                     </button>
                  </div>
               </div>

               {/* Spectator Content */}
               <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-8">
                  <div className="max-w-7xl mx-auto space-y-8">

                     {/* Internal Spectator Tabs */}
                     <div className="flex justify-center">
                        <div className={`p-1 rounded-2xl flex gap-1 border ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-slate-200 border-slate-300'}`}>
                           {[
                              { id: 'overview', label: 'Dnešní přehled', icon: Layout },
                              { id: 'stats', label: 'Statistiky', icon: Activity }
                           ].map(tab => (
                              <button
                                 key={tab.id}
                                 onClick={() => setSpectatorTab(tab.id as any)}
                                 className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2 ${spectatorTab === tab.id ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-slate-500 hover:text-slate-300'}`}
                              >
                                 <tab.icon size={12} /> {tab.label}
                              </button>
                           ))}
                        </div>
                     </div>


                     {spectatorTab === 'overview' && (
                        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                           {/* Date Navigation Bar */}
                           <div className={`p-4 rounded-[24px] border flex items-center justify-between ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                              <button
                                 onClick={() => {
                                    const d = new Date(spectatorDate);
                                    d.setDate(d.getDate() - 1);
                                    setSpectatorDate(d.toISOString().split('T')[0]);
                                 }}
                                 className={`p-2 rounded-xl transition-all ${isDark ? 'hover:bg-[var(--bg-input)] text-slate-400' : 'hover:bg-slate-100 text-slate-600'}`}
                              >
                                 <ChevronLeft size={20} />
                              </button>

                              <div className="flex items-center gap-4">
                                 <Calendar size={18} className="text-blue-500" />
                                 <input
                                    type="date"
                                    value={spectatorDate}
                                    onChange={(e) => setSpectatorDate(e.target.value)}
                                    className={`bg-transparent font-black text-sm outline-none border-b pb-1 ${isDark ? 'text-white border-[var(--border-subtle)]' : 'text-slate-900 border-slate-200'}`}
                                 />
                              </div>

                              <button
                                 onClick={() => {
                                    const d = new Date(spectatorDate);
                                    d.setDate(d.getDate() + 1);
                                    setSpectatorDate(d.toISOString().split('T')[0]);
                                 }}
                                 className={`p-2 rounded-xl transition-all ${isDark ? 'hover:bg-[var(--bg-input)] text-slate-400' : 'hover:bg-slate-100 text-slate-600'}`}
                              >
                                 <ChevronRight size={20} />
                              </button>
                           </div>

                           <div className="space-y-8">
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                 <div className={`p-6 rounded-[24px] border ${isDark ? 'bg-[var(--bg-card)]/40 border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                                    <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Dnešní PnL</p>
                                    <span className={`text-xl font-black font-mono tracking-tighter ${dayPnL >= 0 ? 'text-emerald-500' : 'text-rose-500'} ${dayPnL === null ? 'blur-sm select-none opacity-50' : ''}`}>
                                       {dayPnL !== null ? (
                                          spectatorData?.meta?.pnlFormat === 'rr'
                                             ? formatPnL(dayPnL, 'rr', undefined, calculateTotalRR(filteredRemoteTrades), true, user.currency, exchangeRates)
                                             : `${dayPnL >= 0 ? '+' : ''}$${dayPnL.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                                       ) : 'HIDDEN'}
                                    </span>
                                 </div>
                                 <div
                                    onClick={() => dayPrep && setSelectedPrep(dayPrep)}
                                    className={`p-6 rounded-[24px] border cursor-pointer hover:scale-[1.02] transition-all ${isDark ? 'bg-[var(--bg-card)]/40 border-[var(--border-subtle)] hover:bg-[var(--bg-page)]' : 'bg-white border-slate-200 hover:bg-slate-50'} flex items-center justify-between`}
                                 >
                                    <div>
                                       <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Ranní Příprava</p>
                                       <p className={`text-[10px] font-black uppercase ${dayPrep ? 'text-blue-500' : 'text-slate-600'}`}>
                                          {dayPrep ? 'DOKONČENA' : 'CHYBÍ'}
                                       </p>
                                    </div>
                                    {dayPrep && <ShieldCheck size={24} className="text-blue-500/40" />}
                                 </div>
                                 <div
                                    onClick={() => dayReview && setSelectedReview(dayReview)}
                                    className={`p-6 rounded-[24px] border cursor-pointer hover:scale-[1.02] transition-all ${isDark ? 'bg-[var(--bg-card)]/40 border-[var(--border-subtle)] hover:bg-[var(--bg-page)]' : 'bg-white border-slate-200 hover:bg-slate-50'} flex items-center justify-between`}
                                 >
                                    <div>
                                       <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Večerní Review</p>
                                       <p className={`text-[10px] font-black uppercase ${dayReview ? 'text-amber-500' : 'text-slate-600'}`}>
                                          {dayReview ? 'DOKONČENO' : 'CHYBÍ'}
                                       </p>
                                    </div>
                                    {dayReview && <Brain size={24} className="text-amber-500/40" />}
                                 </div>
                              </div>

                              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                                 {/* Daily Trades List */}
                                 <div className={`p-8 rounded-[32px] border ${isDark ? 'bg-[var(--bg-card)]/40 border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                                    <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 mb-6 flex items-center gap-2"><Activity size={14} /> Dnešní obchody</h3>
                                    <div className="space-y-3">
                                       {filteredRemoteTrades.length > 0 ? filteredRemoteTrades.map(trade => (
                                          <div
                                             key={trade.id}
                                             onClick={() => {
                                                setSelectedTrade(trade);
                                                setModalPnlFormat(spectatorData?.meta?.pnlFormat);
                                             }}
                                             className={`p-4 rounded-xl border flex items-center justify-between cursor-pointer hover:bg-blue-600/5 hover:border-blue-500/20 transition-all ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-50 border-slate-100'}`}
                                          >
                                             <div className="flex items-center gap-4">
                                                <div className={`w-10 h-10 rounded-lg flex items-center justify-center font-black text-xs ${trade.pnl >= 0 ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                                                   {spectatorData?.meta?.pnlFormat === 'rr'
                                                      ? `${trade.pnl >= 0 ? '+' : ''}${trade.pnl}R`
                                                      : `${trade.pnl >= 0 ? '+' : ''}$${trade.pnl}`}
                                                </div>
                                                <div>
                                                   <p className="text-xs font-black text-white">{trade.instrument}</p>
                                                   <p className="text-[9px] text-slate-500 font-bold uppercase">{trade.signal || 'Bez signálu'}</p>
                                                </div>
                                             </div>
                                             <div className={`px-3 py-1 rounded-md text-[8px] font-black uppercase border ${trade.direction === 'Long' ? 'bg-blue-500/10 text-blue-500 border-blue-500/20' : 'bg-amber-500/10 text-amber-500 border-amber-500/20'}`}>
                                                {trade.direction}
                                             </div>
                                          </div>
                                       )) : (
                                          <div className="py-12 text-center opacity-30">
                                             <Skull size={32} className="mx-auto mb-2" />
                                             <p className="text-[10px] font-black uppercase tracking-widest">Žádná aktivita v tento den</p>
                                          </div>
                                       )}
                                    </div>
                                 </div>

                                 {/* Calendar Integration */}
                                 <div className={`h-[750px] overflow-hidden rounded-[32px] border ${isDark ? 'bg-slate-900 border-white/5 shadow-2xl shadow-black/40' : 'bg-white border-slate-200 shadow-xl shadow-slate-200/50'} animate-in zoom-in-95 duration-500`}>
                                    <div className="h-full overflow-y-auto scrollbar-hide p-2">
                                       <DashboardCalendar
                                          trades={spectatorData?.trades.filter(t => t.accountId === activeSpectatorAccountId) || []}
                                          preps={spectatorData?.preps || []}
                                          reviews={spectatorData?.reviews || []}
                                          theme={theme}
                                          accounts={spectatorData?.accounts || []}
                                           initialBalance={spectatorData?.accounts.find(a => a.id === activeSpectatorAccountId)?.initialBalance || 0}
                                          emotions={emotions}
                                          onDayClick={(dateStr) => {
                                             setSpectatorDate(dateStr);
                                          }}
                                          pnlFormat={spectatorData?.meta?.pnlFormat}
                                           user={user}
                                           exchangeRates={exchangeRates}
                                       />
                                    </div>
                                 </div>
                              </div>
                           </div>
                        </div>
                     )}

                     {spectatorTab === 'stats' && globalCareerStats && (
                        <div className="space-y-8 animate-in slide-in-from-right-4 duration-500">
                           {/* Master Career Cards */}
                           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                              <div className={`p-8 rounded-[32px] border ${isDark ? 'bg-slate-900 border-white/5' : 'bg-white border-slate-200'} shadow-xl`}>
                                 <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 flex items-center gap-2"><Briefcase size={14} /> Career PnL</p>
                                 <h3 className={`text-3xl font-black italic tracking-tighter ${globalCareerStats.totalPnL >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {spectatorData?.meta?.pnlFormat === 'rr'
                                       ? formatPnL(globalCareerStats.totalPnL, (spectatorData?.meta?.pnlFormat === 'rr' ? 'rr' : 'usd'), undefined, spectatorData?.meta?.pnlFormat === 'rr' ? calculateTotalRR(spectatorData.trades) : undefined, true, user.currency, exchangeRates)
                                       : `$${globalCareerStats.totalPnL.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
                                 </h3>
                                 <p className="text-[9px] font-bold text-slate-600 mt-2 uppercase">Total from {globalCareerStats.accountCount} accounts</p>
                              </div>
                              <div className={`p-8 rounded-[32px] border ${isDark ? 'bg-slate-900 border-white/5' : 'bg-white border-slate-200'} shadow-xl border-emerald-500/10`}>
                                 <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 flex items-center gap-2"><DollarSign size={14} className="text-emerald-500" /> Total Payouts</p>
                                 <h3 className="text-3xl font-black italic tracking-tighter text-emerald-500">
                                    {spectatorData?.meta?.pnlFormat === 'rr'
                                       ? formatPnL(globalCareerStats.totalPayouts, (spectatorData?.meta?.pnlFormat === 'rr' ? 'rr' : 'usd'), undefined, undefined, true, user.currency, exchangeRates)
                                       : `$${globalCareerStats.totalPayouts.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
                                 </h3>
                                 <div className="flex items-center gap-2 mt-2">
                                    <div className="h-1 flex-1 bg-slate-800 rounded-full overflow-hidden">
                                       <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, (globalCareerStats.totalPayouts / (globalCareerStats.totalPnL || 1)) * 100)}%` }} />
                                    </div>
                                    <span className="text-[8px] font-black text-emerald-500 uppercase">Paid Out</span>
                                 </div>
                              </div>
                              <div className={`p-8 rounded-[32px] border ${isDark ? 'bg-slate-900 border-white/5' : 'bg-white border-slate-200'} shadow-xl`}>
                                 <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 flex items-center gap-2"><Trophy size={14} className="text-amber-500" /> Global Winrate</p>
                                 <h3 className="text-3xl font-black italic tracking-tighter text-white">
                                    {globalCareerStats.winRate.toFixed(1)}%
                                 </h3>
                                 <p className="text-[9px] font-bold text-slate-600 mt-2 uppercase">{globalCareerStats.totalTrades} Total Trades</p>
                              </div>
                              <div className={`p-8 rounded-[32px] border ${isDark ? 'bg-slate-900 border-white/5' : 'bg-white border-slate-200'} shadow-xl`}>
                                 <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1 flex items-center gap-2"><Activity size={14} className="text-blue-500" /> Profit Factor</p>
                                 <h3 className={`text-3xl font-black italic tracking-tighter ${globalCareerStats.profitFactor >= 1.5 ? 'text-emerald-500' : 'text-blue-500'}`}>
                                    {globalCareerStats.profitFactor.toFixed(2)}
                                 </h3>
                                 <p className="text-[9px] font-bold text-slate-600 mt-2 uppercase">Efficiency Score</p>
                              </div>
                           </div>

                           {/* Consistency & Detailed Metrics */}
                           <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                              <div className={`p-8 rounded-[32px] border ${isDark ? 'bg-slate-900/40 border-white/5' : 'bg-white border-slate-200'} space-y-6`}>
                                 <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-2"><Target size={14} /> Consistency Hub</h3>
                                 <div className="grid grid-cols-2 gap-4">
                                    <div className="p-4 rounded-2xl bg-white/5 border border-white/5">
                                       <p className="text-[9px] font-black text-slate-500 uppercase mb-1">Average RR</p>
                                       <p className="text-xl font-black text-white font-mono">{globalCareerStats.avgRR.toFixed(2)}R</p>
                                    </div>
                                    <div className="p-4 rounded-2xl bg-white/5 border border-white/5">
                                       <p className="text-[9px] font-black text-slate-500 uppercase mb-1">Day Winrate</p>
                                       <p className="text-xl font-black text-white font-mono">{globalCareerStats.dayWinRate.toFixed(1)}%</p>
                                    </div>
                                    <div className="p-4 rounded-2xl bg-emerald-500/5 border border-emerald-500/10">
                                       <p className="text-[9px] font-black text-emerald-500 uppercase mb-1">Best Trading Day</p>
                                       <p className="text-xl font-black text-emerald-500 font-mono">{spectatorData?.meta?.pnlFormat === 'rr' ? `+${globalCareerStats.bestDay.pnl}R` : `+$${globalCareerStats.bestDay.pnl.toLocaleString()}`}</p>
                                       <p className="text-[8px] font-bold text-slate-600 mt-1 uppercase">{globalCareerStats.bestDay.date || '-'}</p>
                                    </div>
                                    <div className="p-4 rounded-2xl bg-rose-500/5 border border-rose-500/10">
                                       <p className="text-[9px] font-black text-rose-500 uppercase mb-1">Worst Trading Day</p>
                                       <p className="text-xl font-black text-rose-500 font-mono">-{spectatorData?.meta?.pnlFormat === 'rr' ? `${Math.abs(globalCareerStats.worstDay.pnl)}R` : `$${Math.abs(globalCareerStats.worstDay.pnl).toLocaleString()}`}</p>
                                       <p className="text-[8px] font-bold text-slate-600 mt-1 uppercase">{globalCareerStats.worstDay.date || '-'}</p>
                                    </div>
                                 </div>
                              </div>

                              <div className={`p-8 rounded-[32px] border ${isDark ? 'bg-slate-900/40 border-white/5' : 'bg-white border-slate-200'} space-y-6`}>
                                 <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-2"><ShieldCheck size={14} /> Account Management</h3>
                                 <div className="p-6 rounded-[24px] bg-white/5 border border-white/5 flex items-center justify-between">
                                    <div className="space-y-1">
                                       <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Challenge Pass Rate</p>
                                       <h4 className="text-2xl font-black text-white italic">{globalCareerStats.passRate.toFixed(1)}%</h4>
                                    </div>
                                    <div className="text-right">
                                       <p className="text-[9px] font-black text-slate-500 uppercase mb-1">Pass / Fail</p>
                                       <div className="flex items-center gap-2">
                                          <div className={`px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 text-[10px] font-black`}>{spectatorData.accounts.filter(a => a.type === 'Funded').length}</div>
                                          <div className="w-2 h-0.5 bg-slate-700" />
                                          <div className={`px-2 py-1 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-500 text-[10px] font-black`}>{spectatorData.accounts.filter(a => a.phase === 'Challenge' && a.status === 'Inactive').length}</div>
                                       </div>
                                    </div>
                                 </div>

                                 <div className={`p-6 rounded-[24px] bg-blue-600/5 border border-blue-500/10 flex items-center justify-between`}>
                                    <div>
                                       <p className="text-[10px] font-black text-blue-500 uppercase tracking-widest mb-1">Active Portfolio Value</p>
                                       <p className="text-xl font-black text-white font-mono">
                                          {spectatorData?.meta?.pnlFormat === 'rr'
                                             ? `$${spectatorData.accounts.filter(a => a.status === 'Active').reduce((sum, a) => sum + (a.initialBalance || 0), 0).toLocaleString()}`
                                             : `$${spectatorData.accounts.filter(a => a.status === 'Active').reduce((sum, a) => sum + (a.initialBalance || 0), 0).toLocaleString()}`}
                                       </p>
                                    </div>
                                    <Globe size={32} className="text-blue-500/20" />
                                 </div>
                              </div>
                           </div>

                           {/* Global Equity Curve */}
                           <div className={`p-8 rounded-[32px] border ${isDark ? 'bg-slate-900 border-white/5' : 'bg-white border-slate-200'} shadow-xl`}>
                              <div className="flex justify-between items-center mb-8">
                                 <div>
                                    <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-2"><ArrowUpRight size={14} /> Global Equity Growth</h3>
                                    <p className="text-[10px] text-slate-500 font-bold uppercase mt-1">Aggregate Performance across all accounts</p>
                                 </div>
                                 <div className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 text-[10px] font-black uppercase">
                                    Career Path
                                 </div>
                              </div>
                              <div className="h-[300px] w-full">
                                 <ResponsiveContainer width="100%" height="100%">
                                    <AreaChart data={globalEquityCurve}>
                                       <defs>
                                          <linearGradient id="colorPnL" x1="0" y1="0" x2="0" y2="1">
                                             <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                                             <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                          </linearGradient>
                                       </defs>
                                       <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)"} />
                                       <XAxis
                                          dataKey="timestamp"
                                          hide
                                       />
                                       <YAxis
                                          hide
                                          domain={['auto', 'auto']}
                                       />
                                       <Tooltip
                                          content={({ active, payload }) => {
                                             if (active && payload && payload.length) {
                                                return (
                                                   <div className={`p-4 rounded-2xl border shadow-2xl ${isDark ? 'bg-slate-950 border-white/10' : 'bg-white border-slate-200'}`}>
                                                      <p className="text-[10px] font-black text-slate-500 uppercase mb-1">
                                                         {new Date(payload[0].payload.timestamp).toLocaleString('cs-CZ', {
                                                            day: 'numeric',
                                                            month: 'numeric',
                                                            year: 'numeric',
                                                            hour: '2-digit',
                                                            minute: '2-digit'
                                                         })}
                                                      </p>
                                                      <p className={`text-lg font-black italic ${Number(payload[0].value) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                                                         {spectatorData?.meta?.pnlFormat === 'rr'
                                                            ? formatPnL(Number(payload[0].value), (spectatorData?.meta?.pnlFormat === 'rr' ? 'rr' : 'usd'), undefined, spectatorData?.meta?.pnlFormat === 'rr' ? calculateTotalRR(spectatorData.trades) : undefined, true, user.currency, exchangeRates)
                                                            : `$${Number(payload[0].value).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
                                                      </p>
                                                   </div>
                                                );
                                             }
                                             return null;
                                          }}
                                       />
                                       <Area
                                          type="monotone"
                                          dataKey="pnl"
                                          stroke="#10b981"
                                          strokeWidth={4}
                                          fillOpacity={1}
                                          fill="url(#colorPnL)"
                                          animationDuration={1500}
                                       />
                                    </AreaChart>
                                 </ResponsiveContainer>
                              </div>
                           </div>

                           {/* Global Directional Bias */}
                           <div className={`p-8 rounded-[32px] border ${isDark ? 'bg-slate-900 border-white/5' : 'bg-white border-slate-200'}`}>
                              <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 mb-6 flex items-center gap-2 font-black uppercase"><TrendingUp size={14} /> Long vs Short (Global Archive)</h3>
                              <div className="space-y-6">
                                 {(() => {
                                    const longs = spectatorData.trades.filter(t => t.direction === 'Long');
                                    const shorts = spectatorData.trades.filter(t => t.direction === 'Short');
                                    const total = spectatorData.trades.length || 1;
                                    const longPnL = longs.reduce((sum, t) => sum + Number(t.pnl), 0);
                                    const shortPnL = shorts.reduce((sum, t) => sum + Number(t.pnl), 0);

                                    return (
                                       <>
                                          <div className="flex justify-between items-end">
                                             <div className="space-y-1">
                                                <p className="text-[8px] font-black text-slate-500 uppercase">Long Performance</p>
                                                <p className={`text-xl font-black ${longPnL >= 0 ? 'text-blue-500' : 'text-rose-500'}`}>{longs.length} trades (${longPnL.toLocaleString()})</p>
                                             </div>
                                             <div className="text-right space-y-1">
                                                <p className="text-[8px] font-black text-slate-500 uppercase">Short Performance</p>
                                                <p className={`text-xl font-black ${shortPnL >= 0 ? 'text-amber-500' : 'text-rose-500'}`}>{shorts.length} trades (${shortPnL.toLocaleString()})</p>
                                             </div>
                                          </div>
                                          <div className="h-3 rounded-full bg-slate-800 overflow-hidden flex shadow-inner">
                                             <div className="bg-gradient-to-r from-blue-600 to-blue-400 h-full border-r border-black/20" style={{ width: `${(longs.length / total) * 100}%` }} />
                                             <div className="bg-gradient-to-l from-amber-600 to-amber-400 h-full" style={{ width: `${(shorts.length / total) * 100}%` }} />
                                          </div>
                                          <div className="flex justify-between text-[8px] font-black uppercase tracking-widest text-slate-600">
                                             <span>{(longs.length / total * 100).toFixed(0)}% Buy Bias</span>
                                             <span>{(shorts.length / total * 100).toFixed(0)}% Sell Bias</span>
                                          </div>
                                       </>
                                    );
                                 })()}
                              </div>
                           </div>
                        </div>
                     )}
                  </div>
               </div>

            </div>
         )}

         {/* Zoom Modal at Root Level for Z-Index consistency */}
         {zoomedImage && (
            <div
               className="fixed inset-0 z-[1000] bg-black/95 backdrop-blur-2xl flex items-center justify-center p-4 md:p-12 animate-in fade-in duration-300"
               onClick={() => setZoomedImage(null)}
            >
               <button
                  className="absolute top-8 right-8 p-4 bg-white/10 hover:bg-white/20 rounded-full transition-all text-white border border-white/10"
                  onClick={() => setZoomedImage(null)}
               >
                  <X size={24} />
               </button>
               <img
                  src={zoomedImage}
                  alt="Zoomed Visual"
                  className="max-w-full max-h-full object-contain rounded-2xl shadow-2xl border border-white/10"
                  onClick={(e) => e.stopPropagation()}
               />
            </div>
         )}
      </div>
   );
};

export default NetworkHub;
