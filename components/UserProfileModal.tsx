
import React, { useState, useRef, useEffect } from 'react';
import { downscaleAvatar } from '../lib/avatarImage';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Camera, Lock, Check, Copy, Loader2, Eye, EyeOff, LogOut } from 'lucide-react';
import { SettingsSegment, btn, btnGhost, btnPrimary, field } from './SettingsUi';
import { User } from '../types';
import { supabase } from '../services/supabase';

interface UserProfileModalProps {
   user: User;
   isOpen: boolean;
   onClose: () => void;
   onUpdate: (updatedUser: User) => void | Promise<void>;
   theme: 'dark' | 'light' | 'oled';
   /** Odhlášení (dřív ikona na kartě v bočním panelu). */
   onLogout?: () => void;
}

const UserProfileModal: React.FC<UserProfileModalProps> = ({ user, isOpen, onClose, onUpdate, onLogout }) => {
   const [formData, setFormData] = useState({
      name: user.name || '',
      email: user.email || '',
      avatar: user.avatar || '',
      language: user.language || 'cs',
      currency: user.currency || 'USD',
      timezone: user.timezone || 'Europe/Prague'
   });

   // Sync formData když přijdou čerstvé user data z DB (BG-Refresh dorazí pozdě po mountu)
   // Bez tohoto by formData zůstal s DEFAULT_USER hodnotami pokud se modal otevřel před načtením.
   useEffect(() => {
      setFormData(prev => ({
         ...prev,
         name: user.name || prev.name,
         email: user.email || prev.email,
         avatar: user.avatar || prev.avatar,
         language: user.language || prev.language,
         currency: user.currency || prev.currency,
         timezone: user.timezone || prev.timezone,
      }));
   }, [user.id, user.name, user.email, user.avatar, user.language, user.currency, user.timezone]);

   const [passwords, setPasswords] = useState({
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
   });

   const [copied, setCopied] = useState(false);
   const [msg, setMsg] = useState<{ text: string, type: 'error' | 'success' } | null>(null);

   const fileInputRef = useRef<HTMLInputElement>(null);
   // Změna hesla je schovaná za tlačítkem; zavřením se pole vyčistí.
   const [passwordOpen, setPasswordOpen] = useState(false);
   const [isSaving, setIsSaving] = useState(false);
   const [showCurrentPassword, setShowCurrentPassword] = useState(false);
   const [showNewPassword, setShowNewPassword] = useState(false);
   const [showConfirmPassword, setShowConfirmPassword] = useState(false);

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

         // Profile update logic — počkat na zápis do DB; modal dřív hlásil úspěch i při selhání.
         await onUpdate({ ...user, ...formData });

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
         const detail = err instanceof Error && err.message ? `: ${err.message.slice(0, 120)}` : '';
         setMsg({ text: `Profil se nepodařilo uložit${detail}`, type: 'error' });
      } finally {
         setIsSaving(false);
      }
   };

   const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
         // Zmenšit na 256 px: avatar cestuje s každým načtením deníku.
         downscaleAvatar(file).then(avatar => {
            console.info('[Profile] avatar ready', { originalBytes: file.size, dataUrlChars: avatar.length });
            setFormData(prev => ({ ...prev, avatar }));
         }).catch(err => {
            console.error('[Profile] avatar read failed', err);
            setMsg({ text: 'Obrázek se nepodařilo načíst', type: 'error' });
         });
      }
   };

   const copyToClipboard = (text: string) => {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
   };

   const lab = 'text-[12.5px] font-semibold text-[var(--text-primary)]';
   const row = 'flex min-h-[46px] flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--border-subtle)] px-4 py-2 last:border-b-0';
   const groupTitle = 'px-4 pb-1.5 pt-3 text-[11.5px] font-semibold text-[var(--text-muted)]';
   const passwordInput = (value: string, onChange: (v: string) => void, shown: boolean, toggle: () => void, placeholder: string) => (
      <div className="relative">
         <input type={shown ? 'text' : 'password'} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} className={`${field} w-full pr-9`} autoComplete="new-password" />
         <button type="button" onClick={toggle} aria-label={shown ? 'Skrýt heslo' : 'Zobrazit heslo'} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
         </button>
      </div>
   );

   return (
      <AnimatePresence>
         {isOpen && (
            <div className="fixed inset-0 z-[200] flex items-start justify-center overflow-y-auto p-4 pt-[8vh]">
               {/* Ztmavení: lehké a rozmazané (sklo), ne černé. */}
               <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={onClose}
                  className="fixed inset-0 bg-slate-900/20 backdrop-blur-md"
               />
               <motion.div
                  role="dialog" aria-modal="true" aria-label="Profil"
                  initial={{ opacity: 0, scale: 0.97, y: 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.97, y: 8 }}
                  className="glass-modal relative w-full max-w-[480px] overflow-hidden"
               >
                  <form onSubmit={handleSubmit}>
                     <div className="flex items-center gap-3.5 border-b border-[var(--border-subtle)] px-4 py-4">
                        <button type="button" onClick={() => fileInputRef.current?.click()} title="Změnit fotku" aria-label="Změnit fotku"
                           className="group/avatar relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-gradient-to-br from-slate-700 to-slate-900 text-lg font-extrabold text-slate-100 shadow-[0_0_0_2px_var(--glass-border,var(--border-subtle)),0_4px_12px_rgba(0,0,0,0.18)]">
                           {formData.avatar
                              ? <img src={formData.avatar} alt="" className="h-full w-full object-cover" />
                              : <span className="grid h-full w-full place-items-center">{(formData.name || '?').slice(0, 1).toUpperCase()}</span>}
                           <span className="absolute inset-0 grid place-items-center bg-slate-950/50 text-white opacity-0 transition-opacity group-hover/avatar:opacity-100"><Camera size={18} /></span>
                        </button>
                        <div className="min-w-0">
                           <h2 className="truncate text-base font-bold text-[var(--text-primary)]">{formData.name || 'Bez jména'}</h2>
                           <p className="truncate text-xs text-[var(--text-secondary)]">{formData.email}</p>
                           <span className="mt-0.5 inline-flex items-center gap-1.5 font-mono text-[11.5px] font-semibold text-[var(--text-secondary)]">
                              ID {user.id.slice(0, 16).toUpperCase()}
                              <button type="button" onClick={() => copyToClipboard(user.id)} title="Kopírovat Trader ID" aria-label="Kopírovat Trader ID"
                                 className={`grid h-6 w-6 place-items-center rounded ${copied ? 'text-emerald-500' : 'text-[var(--text-muted)] hover:bg-[var(--bg-page)] hover:text-[var(--text-primary)]'}`}>
                                 {copied ? <Check size={13} /> : <Copy size={13} />}
                              </button>
                           </span>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Zavřít" className={`${btnGhost} ml-auto w-[30px] self-start px-0`}><X size={16} /></button>
                     </div>

                     {msg && (
                        <p role={msg.type === 'error' ? 'alert' : 'status'} className={`border-b border-[var(--border-subtle)] px-4 py-2.5 text-xs font-semibold ${msg.type === 'success' ? 'text-emerald-500' : 'text-rose-500'}`}>{msg.text}</p>
                     )}

                     <p className={groupTitle}>Profil</p>
                     <div className={row}>
                        <label htmlFor="profile-name" className={`${lab} flex-1`}>Jméno</label>
                        <input id="profile-name" type="text" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="Tvoje jméno" className={`${field} w-full sm:w-[200px]`} />
                     </div>
                     <div className={row}>
                        <span className={`${lab} flex-1`}>Jazyk</span>
                        <SettingsSegment label="Jazyk" value={formData.language as 'cs' | 'en'} onChange={v => setFormData({ ...formData, language: v })}
                           options={[{ value: 'cs', label: 'Čeština' }, { value: 'en', label: 'English' }]} />
                     </div>
                     <div className={row}>
                        <span className="flex-1"><span className={`${lab} block`}>Měna</span><span className="text-[11.5px] text-[var(--text-secondary)]">Jak se zobrazují částky v appce</span></span>
                        <SettingsSegment label="Měna" value={formData.currency as 'USD' | 'CZK' | 'EUR'} onChange={v => setFormData({ ...formData, currency: v })}
                           options={[{ value: 'USD', label: 'USD' }, { value: 'CZK', label: 'CZK' }, { value: 'EUR', label: 'EUR' }]} />
                     </div>
                     <div className={row}>
                        <label htmlFor="profile-tz" className={`${lab} flex-1`}>Časové pásmo</label>
                        <select id="profile-tz" value={formData.timezone} onChange={e => setFormData({ ...formData, timezone: e.target.value })} className={`${field} w-full sm:w-[200px]`}>
                           <option value="Europe/Prague">Praha (GMT+1)</option>
                           <option value="Europe/London">Londýn (GMT+0)</option>
                           <option value="America/New_York">New York (EST)</option>
                           <option value="UTC">UTC</option>
                        </select>
                     </div>

                     <p className={groupTitle}>Přihlášení</p>
                     <div className={row}>
                        <span className={`${lab} flex-1`}>E-mail</span>
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] text-[var(--text-secondary)]"><Lock size={13} className="shrink-0 text-[var(--text-muted)]" /><span className="truncate">{formData.email}</span></span>
                     </div>
                     <div className={row}>
                        <span className={`${lab} flex-1`}>Heslo</span>
                        <button type="button" className={btn} onClick={() => {
                           if (passwordOpen) setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
                           setPasswordOpen(open => !open);
                        }}>{passwordOpen ? 'Zrušit změnu' : 'Změnit heslo'}</button>
                     </div>
                     {passwordOpen && (
                        <div className="grid gap-2 border-b border-[var(--border-subtle)] px-4 pb-3 pt-1">
                           {passwordInput(passwords.currentPassword, v => setPasswords({ ...passwords, currentPassword: v }), showCurrentPassword, () => setShowCurrentPassword(x => !x), 'Současné heslo')}
                           {passwordInput(passwords.newPassword, v => setPasswords({ ...passwords, newPassword: v }), showNewPassword, () => setShowNewPassword(x => !x), 'Nové heslo')}
                           {passwordInput(passwords.confirmPassword, v => setPasswords({ ...passwords, confirmPassword: v }), showConfirmPassword, () => setShowConfirmPassword(x => !x), 'Nové heslo znovu')}
                           <span className="text-[11.5px] text-[var(--text-muted)]">Aspoň 6 znaků. Současné heslo se ověří před změnou.</span>
                        </div>
                     )}

                     <div className="flex items-center gap-1.5 border-t border-[var(--border-subtle)] bg-[var(--bg-page)]/40 px-4 py-3">
                        {onLogout && (
                           <button type="button" onClick={() => { onClose(); onLogout(); }} className={`${btnGhost} text-rose-500 hover:bg-rose-500/10 hover:text-rose-500`}><LogOut size={14} /> Odhlásit se</button>
                        )}
                        <span className="flex-1" />
                        <button type="button" onClick={onClose} className={btnGhost}>Zrušit</button>
                        <button type="submit" disabled={isSaving} className={btnPrimary}>
                           {isSaving ? <><Loader2 size={14} className="animate-spin" /> Ukládám…</> : 'Uložit'}
                        </button>
                     </div>
                  </form>

                  <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleImageUpload} />
               </motion.div>
            </div>
         )}
      </AnimatePresence>
   );
};

export default UserProfileModal;
