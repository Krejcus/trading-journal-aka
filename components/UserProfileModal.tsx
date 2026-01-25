
import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
   X, User as UserIcon, Camera, Mail, Hash,
   Lock, Upload, Trash2, Check, Copy, Globe, DollarSign, Loader2
} from 'lucide-react';
import { User } from '../types';
import { supabase } from '../services/supabase';

interface UserProfileModalProps {
   user: User;
   isOpen: boolean;
   onClose: () => void;
   onUpdate: (updatedUser: User) => void;
   theme: 'dark' | 'light' | 'oled';
}

const UserProfileModal: React.FC<UserProfileModalProps> = ({ user, isOpen, onClose, onUpdate, theme }) => {
   const [formData, setFormData] = useState({
      name: user.name || '',
      email: user.email || '',
      avatar: user.avatar || '',
      language: user.language || 'cs',
      currency: user.currency || 'USD',
      timezone: user.timezone || 'Europe/Prague'
   });

   const [passwords, setPasswords] = useState({
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
   });

   const [copied, setCopied] = useState(false);
   const [msg, setMsg] = useState<{ text: string, type: 'error' | 'success' } | null>(null);

   const fileInputRef = useRef<HTMLInputElement>(null);
   const isDark = theme !== 'light';
   const [isSaving, setIsSaving] = useState(false);

   if (!isOpen) return null;

   const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      setMsg(null);
      setIsSaving(true);

      try {
         // Password change logic with real verification
         if (passwords.newPassword) {
            if (!passwords.currentPassword) {
               setMsg({ text: 'Pro změnu hesla zadejte současné heslo', type: 'error' });
               setIsSaving(false);
               return;
            }
            if (passwords.newPassword !== passwords.confirmPassword) {
               setMsg({ text: 'Nová hesla se neshodují', type: 'error' });
               setIsSaving(false);
               return;
            }
            if (passwords.newPassword.length < 6) {
               setMsg({ text: 'Heslo musí mít alespoň 6 znaků', type: 'error' });
               setIsSaving(false);
               return;
            }

            // 1. Verify current password by re-authenticating
            const { error: authError } = await supabase.auth.signInWithPassword({
               email: formData.email,
               password: passwords.currentPassword
            });

            if (authError) {
               setMsg({ text: 'Současné heslo není správné', type: 'error' });
               setIsSaving(false);
               return;
            }

            // 2. Update to new password
            const { error: updateError } = await supabase.auth.updateUser({
               password: passwords.newPassword
            });

            if (updateError) {
               setMsg({ text: `Chyba při změně hesla: ${updateError.message}`, type: 'error' });
               setIsSaving(false);
               return;
            }
         }

         // Profile update logic
         onUpdate({ ...user, ...formData });

         if (passwords.newPassword) {
            setMsg({ text: 'Heslo a profil byly úspěšně změněny', type: 'success' });
            setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
         } else {
            setMsg({ text: 'Profil byl úspěšně aktualizován', type: 'success' });
         }

         setTimeout(() => {
            onClose();
            setMsg(null);
         }, 1500);
      } catch (err: any) {
         setMsg({ text: 'Došlo k neočekávané chybě při ukládání', type: 'error' });
      } finally {
         setIsSaving(false);
      }
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

   const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
   };

   const glassBg = isDark
      ? 'bg-slate-900/60 backdrop-blur-3xl border-white/10'
      : 'bg-white/80 backdrop-blur-3xl border-slate-200 shadow-2xl';

   const inputBg = isDark
      ? 'bg-white/5 border-white/5 focus:border-blue-500/50 text-white'
      : 'bg-slate-900/5 border-slate-900/5 focus:border-blue-500/50 text-slate-900';

   return (
      <AnimatePresence>
         {isOpen && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
               {/* Backdrop */}
               <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={onClose}
                  className="absolute inset-0 bg-black/60 backdrop-blur-sm"
               />

               {/* Modal Content */}
               <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: 20 }}
                  className={`relative w-full max-w-xl overflow-hidden rounded-[40px] border ${glassBg}`}
               >
                  {/* Closing Button */}
                  <button
                     onClick={onClose}
                     className="absolute top-6 right-6 p-2 rounded-full hover:bg-white/10 transition-colors z-20 text-slate-500 hover:text-white"
                  >
                     <X size={20} />
                  </button>

                  <div className="p-8 md:p-10 max-h-[90vh] overflow-y-auto custom-scrollbar">
                     <div className="text-center mb-8">
                        <div className="relative inline-block group">
                           <div
                              onClick={() => fileInputRef.current?.click()}
                              className="w-24 h-24 rounded-[32px] border-2 border-blue-500/30 overflow-hidden mx-auto cursor-pointer relative group/avatar transition-transform active:scale-95 shadow-2xl"
                           >
                              {formData.avatar ? (
                                 <img src={formData.avatar} alt="Profile" className="w-full h-full object-cover" />
                              ) : (
                                 <div className="w-full h-full bg-gradient-to-br from-blue-500/10 to-cyan-500/10 flex items-center justify-center text-blue-500">
                                    <UserIcon size={32} />
                                 </div>
                              )}

                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/avatar:opacity-100 flex items-center justify-center transition-opacity">
                                 <Camera size={20} className="text-white" />
                              </div>
                           </div>
                           <button
                              type="button"
                              onClick={() => fileInputRef.current?.click()}
                              className="absolute -bottom-1 -right-1 p-2 bg-blue-600 text-white rounded-2xl shadow-lg hover:bg-blue-500 transition-colors"
                           >
                              <Upload size={12} />
                           </button>
                        </div>
                     </div>

                     <form onSubmit={handleSubmit} className="space-y-6">
                        {/* Status Message */}
                        {msg && (
                           <motion.div
                              initial={{ opacity: 0, y: -10 }}
                              animate={{ opacity: 1, y: 0 }}
                              className={`p-4 rounded-2xl text-center text-[10px] font-black uppercase tracking-[0.2em] ${msg.type === 'success' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}
                           >
                              {msg.text}
                           </motion.div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                           <div className="space-y-2">
                              <label className="text-[9px] font-black uppercase text-slate-500 ml-4 tracking-widest flex items-center gap-2">
                                 <UserIcon size={12} /> Jméno
                              </label>
                              <input
                                 type="text"
                                 value={formData.name}
                                 onChange={e => setFormData({ ...formData, name: e.target.value })}
                                 className={`w-full px-6 py-4 rounded-[22px] border text-xs font-bold outline-none transition-all ${inputBg}`}
                                 placeholder="Trader Name"
                              />
                           </div>

                           <div className="space-y-2">
                              <label className="text-[9px] font-black uppercase text-slate-500 ml-4 tracking-widest flex items-center gap-2">
                                 <Globe size={12} /> Jazyk
                              </label>
                              <select
                                 value={formData.language}
                                 onChange={e => setFormData({ ...formData, language: e.target.value as any })}
                                 className={`w-full px-6 py-4 rounded-[22px] border text-xs font-bold outline-none transition-all appearance-none cursor-pointer ${inputBg}`}
                              >
                                 <option value="cs">Čeština (CS)</option>
                                 <option value="en">English (EN)</option>
                              </select>
                           </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                           <div className="space-y-2">
                              <label className="text-[9px] font-black uppercase text-slate-500 ml-4 tracking-widest flex items-center gap-2">
                                 <DollarSign size={12} /> Hlavní měna
                              </label>
                              <select
                                 value={formData.currency}
                                 onChange={e => setFormData({ ...formData, currency: e.target.value as any })}
                                 className={`w-full px-6 py-4 rounded-[22px] border text-xs font-bold outline-none transition-all appearance-none cursor-pointer ${inputBg}`}
                              >
                                 <option value="USD">Americký Dolar (USD)</option>
                                 <option value="CZK">Česká Koruna (CZK)</option>
                                 <option value="EUR">Euro (EUR)</option>
                              </select>
                           </div>
                           <div className="space-y-2">
                              <label className="text-[9px] font-black uppercase text-slate-500 ml-4 tracking-widest flex items-center gap-2">
                                 <Globe size={12} /> Časové pásmo
                              </label>
                              <select
                                 value={formData.timezone}
                                 onChange={e => setFormData({ ...formData, timezone: e.target.value })}
                                 className={`w-full px-6 py-4 rounded-[22px] border text-xs font-bold outline-none transition-all appearance-none cursor-pointer ${inputBg}`}
                              >
                                 <option value="Europe/Prague">Praha (GMT+1)</option>
                                 <option value="Europe/London">Londýn (GMT+0)</option>
                                 <option value="America/New_York">New York (EST)</option>
                                 <option value="UTC">UTC</option>
                              </select>
                           </div>
                        </div>

                        <div className="space-y-2 opacity-60">
                           <label className="text-[9px] font-black uppercase text-slate-500 ml-4 tracking-widest flex items-center gap-2">
                              <Mail size={12} /> Emailový Login
                           </label>
                           <div className="relative">
                              <input
                                 type="email"
                                 value={formData.email}
                                 readOnly
                                 disabled
                                 className={`w-full pl-6 pr-12 py-4 rounded-[22px] border text-xs font-bold cursor-not-allowed ${inputBg}`}
                              />
                              <Lock size={14} className="absolute right-5 top-1/2 -translate-y-1/2 text-slate-600" />
                           </div>
                        </div>

                        {/* ID & Copy */}
                        <div className={`p-5 rounded-[26px] border ${isDark ? 'bg-white/5 border-white/5' : 'bg-slate-900/5 border-slate-900/5'} flex justify-between items-center group`}>
                           <div className="flex items-center gap-4">
                              <div className="p-3 bg-blue-500/10 text-blue-500 rounded-2xl">
                                 <Hash size={16} />
                              </div>
                              <div>
                                 <p className="text-[8px] font-black uppercase text-slate-500 tracking-widest mb-0.5">Trader ID</p>
                                 <p className={`text-xs font-mono font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                                    {user.id.slice(0, 16).toUpperCase()}
                                 </p>
                              </div>
                           </div>
                           <button
                              type="button"
                              onClick={() => copyToClipboard(user.id)}
                              className={`p-3 rounded-2xl transition-all ${copied ? 'bg-emerald-500/20 text-emerald-500' : 'hover:bg-blue-500/10 text-slate-500 hover:text-blue-500'}`}
                           >
                              {copied ? <Check size={18} /> : <Copy size={18} />}
                           </button>
                        </div>

                        {/* Security Section */}
                        <div className="pt-6 border-t border-white/5">
                           <h4 className="text-[10px] font-black uppercase text-slate-500 mb-4 px-4 tracking-widest flex items-center gap-2">
                              <Lock size={12} /> Změna hesla
                           </h4>
                           <div className="space-y-4">
                              <input
                                 type="password"
                                 placeholder="Současné heslo"
                                 value={passwords.currentPassword}
                                 onChange={e => setPasswords({ ...passwords, currentPassword: e.target.value })}
                                 className={`w-full px-6 py-4 rounded-[22px] border text-xs font-bold outline-none transition-all ${inputBg}`}
                              />
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                 <input
                                    type="password"
                                    placeholder="Nové heslo"
                                    value={passwords.newPassword}
                                    onChange={e => setPasswords({ ...passwords, newPassword: e.target.value })}
                                    className={`w-full px-6 py-4 rounded-[22px] border text-xs font-bold outline-none transition-all ${inputBg}`}
                                 />
                                 <input
                                    type="password"
                                    placeholder="Potvrzení hesla"
                                    value={passwords.confirmPassword}
                                    onChange={e => setPasswords({ ...passwords, confirmPassword: e.target.value })}
                                    className={`w-full px-6 py-4 rounded-[22px] border text-xs font-bold outline-none transition-all ${inputBg}`}
                                 />
                              </div>
                           </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4 pt-6">
                           <button
                              type="button"
                              onClick={onClose}
                              className={`py-4 rounded-[22px] border text-[10px] font-black uppercase tracking-widest transition-all ${isDark ? 'border-white/5 hover:bg-white/5 text-slate-400' : 'border-slate-200 hover:bg-slate-50 text-slate-500'}`}
                           >
                              Zrušit
                           </button>
                           <button
                              type="submit"
                              disabled={isSaving}
                              className={`py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-[22px] text-[10px] font-black uppercase tracking-widest shadow-xl shadow-blue-500/20 transition-all active:scale-95 flex items-center justify-center gap-2 ${isSaving ? 'opacity-50 cursor-not-allowed' : ''}`}
                           >
                              {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                              {isSaving ? 'Ukládám...' : 'Uložit nastavení'}
                           </button>
                        </div>
                     </form>
                  </div>

                  {/* Hidden File Input */}
                  <input
                     type="file"
                     ref={fileInputRef}
                     className="hidden"
                     accept="image/*"
                     onChange={handleImageUpload}
                  />
               </motion.div>
            </div>
         )}
      </AnimatePresence>
   );
};

export default UserProfileModal;
