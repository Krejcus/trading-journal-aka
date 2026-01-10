
import React, { useState, useMemo, useRef } from 'react';
import { User, Trade } from '../types';
import {
   X, User as UserIcon, Camera, Mail, Hash,
   TrendingUp, Target, Briefcase,
   Upload, Lock, Trash2
} from 'lucide-react';

interface UserProfileModalProps {
   user: User;
   trades: Trade[];
   isOpen: boolean;
   onClose: () => void;
   onUpdate: (updatedUser: User) => void;
   theme: 'dark' | 'light' | 'oled';
}

const UserProfileModal: React.FC<UserProfileModalProps> = ({ user, trades, isOpen, onClose, onUpdate, theme }) => {
   const [formData, setFormData] = useState({
      name: user.name,
      email: user.email,
      avatar: user.avatar || ''
   });

   const fileInputRef = useRef<HTMLInputElement>(null);
   const isDark = theme !== 'light';

   // --- LIFETIME STATS CALCULATION ---
   const stats = useMemo(() => {
      const totalTrades = trades.length;
      const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
      const winRate = totalTrades > 0
         ? (trades.filter(t => t.pnl > 0).length / totalTrades) * 100
         : 0;

      // Member since calculation based on ID timestamp or current date fallback
      const timestamp = parseInt(user.id.split('_')[1]);
      const memberSince = !isNaN(timestamp) ? new Date(timestamp) : new Date();

      return { totalTrades, totalPnL, winRate, memberSince };
   }, [trades, user.id]);

   if (!isOpen) return null;

   const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      onUpdate({ ...user, ...formData });
      onClose();
   };

   const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
         const reader = new FileReader();
         reader.onloadend = () => {
            setFormData(prev => ({ ...prev, avatar: reader.result as string }));
         };
         reader.readAsDataURL(file);
      }
   };

   const removeAvatar = () => {
      setFormData(prev => ({ ...prev, avatar: '' }));
      if (fileInputRef.current) fileInputRef.current.value = '';
   };

   const inputClass = `w-full px-4 py-3 rounded-xl border outline-none transition-all focus:ring-2 focus:ring-blue-500/40 ${isDark ? 'bg-slate-950/50 border-slate-800 text-white placeholder-slate-600' : 'bg-slate-50 border-slate-200 text-slate-900'
      }`;

   const disabledInputClass = `w-full px-4 py-3 rounded-xl border outline-none cursor-not-allowed opacity-60 ${isDark ? 'bg-slate-900 border-slate-800 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-500'
      }`;

   return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xl animate-in fade-in duration-300">
         <div className={`w-full max-w-4xl rounded-[40px] overflow-hidden shadow-2xl flex flex-col md:flex-row border ${isDark ? 'bg-[#0a0f1d] border-white/10' : 'bg-white border-slate-200'}`}>

            {/* LEFT: Identity Column */}
            <div className={`w-full md:w-[40%] p-8 border-r flex flex-col ${isDark ? 'bg-[#0F172A]/50 border-white/5' : 'bg-slate-50 border-slate-200'}`}>
               <div className="text-center mb-8">
                  <div className="relative inline-block group">
                     <div
                        onClick={() => fileInputRef.current?.click()}
                        className={`w-32 h-32 rounded-full border-4 overflow-hidden mb-4 mx-auto cursor-pointer transition-all hover:scale-105 hover:border-blue-500 relative group/avatar ${isDark ? 'border-slate-800 bg-slate-900' : 'border-white bg-white shadow-xl'}`}
                     >
                        {formData.avatar ? (
                           <img src={formData.avatar} alt="Profile" className="w-full h-full object-cover" />
                        ) : (
                           <div className="w-full h-full flex items-center justify-center text-slate-600"><UserIcon size={48} /></div>
                        )}

                        {/* Hover Overlay */}
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover/avatar:opacity-100 flex items-center justify-center transition-opacity">
                           <Camera size={24} className="text-white" />
                        </div>
                     </div>

                     {/* ID Badge */}
                     <div className={`absolute -bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border shadow-xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-400' : 'bg-white border-slate-200 text-slate-500'}`}>
                        ID: {user.id.slice(0, 8)}
                     </div>

                     {/* Remove Avatar Button (only if avatar exists) */}
                     {formData.avatar && (
                        <button
                           onClick={removeAvatar}
                           className="absolute top-0 right-0 p-1.5 bg-rose-500 text-white rounded-full shadow-lg hover:bg-rose-600 transition-colors"
                           title="Odstranit fotku"
                        >
                           <Trash2 size={12} />
                        </button>
                     )}
                  </div>

                  {/* Hidden File Input */}
                  <input
                     type="file"
                     ref={fileInputRef}
                     className="hidden"
                     accept="image/*"
                     onChange={handleImageUpload}
                  />

                  <h2 className={`text-2xl font-black italic tracking-tight mt-6 ${isDark ? 'text-white' : 'text-slate-900'}`}>{formData.name || 'Trader'}</h2>
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">Professional Account</p>
               </div>

               <form onSubmit={handleSubmit} className="space-y-6 flex-1">
                  <div className="space-y-1">
                     <label className="text-[9px] font-black uppercase text-slate-500 ml-2">Jméno</label>
                     <div className="relative">
                        <UserIcon size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                        <input type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} className={`${inputClass} pl-10`} />
                     </div>
                  </div>

                  <div className="space-y-1">
                     <div className="flex justify-between ml-2">
                        <label className="text-[9px] font-black uppercase text-slate-500">Email (Login)</label>
                        <span className="text-[9px] font-bold text-slate-600 flex items-center gap-1"><Lock size={10} /> Neměnné</span>
                     </div>
                     <div className="relative">
                        <Mail size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                        <input
                           type="email"
                           value={formData.email}
                           readOnly
                           disabled
                           className={`${disabledInputClass} pl-10`}
                        />
                        <Lock size={14} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-600" />
                     </div>
                  </div>

                  {/* Upload Button Helper (Mobile friendly) */}
                  <div className="pt-2">
                     <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className={`w-full py-3 rounded-xl border border-dashed flex items-center justify-center gap-2 text-xs font-bold transition-all ${isDark ? 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white' : 'border-slate-300 text-slate-500 hover:bg-slate-50'}`}
                     >
                        <Upload size={14} /> {formData.avatar ? 'Změnit fotku' : 'Nahrát fotku'}
                     </button>
                  </div>

                  <button type="submit" className="w-full mt-auto py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-black uppercase text-xs tracking-widest shadow-lg shadow-blue-600/20 active:scale-95 transition-all">
                     Uložit Profil
                  </button>
               </form>
            </div>

            {/* RIGHT: Career Stats */}
            <div className="flex-1 p-8 flex flex-col overflow-y-auto">
               <div className="flex justify-between items-center mb-8">
                  <div>
                     <h3 className={`text-xl font-black italic uppercase ${isDark ? 'text-white' : 'text-slate-900'}`}>Kariérní Přehled</h3>
                     <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Agregovaná data ze všech portfolií</p>
                  </div>
                  <button onClick={onClose} className="p-2 rounded-full hover:bg-slate-800 text-slate-500 transition-all"><X size={24} /></button>
               </div>

               {/* Grid Stats */}
               <div className="grid grid-cols-2 gap-4 mb-8">
                  <div className={`p-6 rounded-2xl border ${isDark ? 'bg-white/5 border-white/5' : 'bg-white border-slate-100'}`}>
                     <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest mb-2 flex items-center gap-2"><TrendingUp size={14} /> Lifetime PnL</p>
                     <p className={`text-3xl font-black font-mono tracking-tighter ${stats.totalPnL >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toLocaleString()}
                     </p>
                  </div>
                  <div className={`p-6 rounded-2xl border ${isDark ? 'bg-white/5 border-white/5' : 'bg-white border-slate-100'}`}>
                     <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest mb-2 flex items-center gap-2"><Target size={14} /> Global Win Rate</p>
                     <p className="text-3xl font-black text-blue-500">
                        {stats.winRate.toFixed(1)}%
                     </p>
                  </div>
                  <div className={`p-6 rounded-2xl border ${isDark ? 'bg-white/5 border-white/5' : 'bg-white border-slate-100'}`}>
                     <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest mb-2 flex items-center gap-2"><Hash size={14} /> Total Trades</p>
                     <p className="text-3xl font-black text-white">
                        {stats.totalTrades}
                     </p>
                  </div>
                  <div className={`p-6 rounded-2xl border ${isDark ? 'bg-white/5 border-white/5' : 'bg-white border-slate-100'}`}>
                     <p className="text-[9px] font-black uppercase text-slate-500 tracking-widest mb-2 flex items-center gap-2"><Briefcase size={14} /> Active Accounts</p>
                     <p className="text-3xl font-black text-white">
                        {new Set(trades.map(t => t.accountId)).size}
                     </p>
                  </div>
               </div>

            </div>
         </div>
      </div>
   );
};

export default UserProfileModal;
