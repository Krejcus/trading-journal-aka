import React, { useState, useEffect } from 'react';
import { X, Plus } from 'lucide-react';
import { Account, BusinessPayout, User } from '../types';

interface PayoutModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (payout: BusinessPayout) => void;
    accounts: Account[];
    payout?: BusinessPayout | null;
    initialAccountId?: string;
    theme: 'dark' | 'light' | 'oled';
    user: User;
}

const PayoutModal: React.FC<PayoutModalProps> = ({
    isOpen,
    onClose,
    onSave,
    accounts,
    payout,
    initialAccountId,
    theme,
    user
}) => {
    const isDark = theme !== 'light';
    const [formData, setFormData] = useState<Partial<BusinessPayout>>({
        amount: 0,
        grossAmount: 0,
        profitSplitUsed: 90,
        date: new Date().toISOString().split('T')[0],
        accountId: initialAccountId || '',
        notes: '',
        image: ''
    });

    useEffect(() => {
        if (payout) {
            setFormData({
                ...payout,
                grossAmount: payout.grossAmount || payout.amount,
                profitSplitUsed: payout.profitSplitUsed || 90
            });
        } else if (initialAccountId) {
            const acc = accounts.find(a => a.id === initialAccountId);
            setFormData(prev => ({
                ...prev,
                accountId: initialAccountId,
                profitSplitUsed: acc?.profitSplit || 90,
                amount: 0,
                grossAmount: 0,
                date: new Date().toISOString().split('T')[0],
                notes: '',
                image: ''
            }));
        } else {
            setFormData({
                amount: 0,
                grossAmount: 0,
                profitSplitUsed: 90,
                date: new Date().toISOString().split('T')[0],
                accountId: '',
                notes: '',
                image: ''
            });
        }
    }, [payout, initialAccountId, accounts, isOpen]);

    if (!isOpen) return null;

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                setFormData(prev => ({ ...prev, image: reader.result as string }));
            };
            reader.readAsDataURL(file);
        }
    };

    const handleSave = () => {
        if (!formData.amount || !formData.accountId) return;
        onSave({
            ...(formData as BusinessPayout),
            id: formData.id || `payout_${Date.now()}`,
            status: 'Received',
            date: formData.date || new Date().toISOString().split('T')[0]
        });
        onClose();
    };

    const inputClass = `w-full px-4 py-2.5 rounded-xl border focus:ring-2 focus:ring-blue-500/40 outline-none transition-all ${isDark ? 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-white placeholder-slate-700' : 'bg-slate-50 border-slate-200 text-slate-900 placeholder-slate-400'
        }`;

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-300">
            <div className={`w-full max-w-lg p-8 rounded-[32px] border shadow-2xl ${isDark ? 'bg-[var(--bg-card)] border-[var(--border-subtle)]' : 'bg-white border-slate-200'}`}>
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-xl font-black italic tracking-tight uppercase">{payout ? 'Upravit výplatu' : 'Nová výplata'}</h3>
                    <button onClick={onClose} className="p-2 text-slate-500 hover:text-white transition-all"><X size={20} /></button>
                </div>

                <div className="space-y-6">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Účet</label>
                            <select
                                value={formData.accountId}
                                onChange={(e) => {
                                    const accId = e.target.value;
                                    const acc = accounts.find(a => a.id === accId);
                                    const split = acc?.profitSplit || 90;
                                    const gross = Number(formData.grossAmount) || 0;
                                    setFormData({
                                        ...formData,
                                        accountId: accId,
                                        profitSplitUsed: split,
                                        amount: gross * (split / 100)
                                    });
                                }}
                                className={inputClass}
                            >
                                <option value="">Vyberte účet...</option>
                                {accounts.filter(a => a.status === 'Active').map(acc => (
                                    <option key={acc.id} value={acc.id}>{acc.name}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Datum</label>
                            <input
                                type="date" value={formData.date}
                                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                                className={inputClass}
                            />
                        </div>
                    </div>

                    <div className={`p-4 rounded-2xl border ${isDark ? 'bg-blue-600/5 border-blue-500/20' : 'bg-blue-50 border-blue-200'}`}>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase text-blue-500 tracking-widest pl-1">Hrubý Zisk (Gross)</label>
                                <div className="relative">
                                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 font-bold">$</span>
                                    <input
                                        type="number"
                                        value={formData.grossAmount || ''}
                                        onChange={(e) => {
                                            const gross = Number(e.target.value);
                                            const split = Number(formData.profitSplitUsed) || 90;
                                            setFormData({
                                                ...formData,
                                                grossAmount: gross,
                                                amount: gross * (split / 100)
                                            });
                                        }}
                                        className={`w-full pl-8 pr-4 py-3 rounded-xl border outline-none font-mono font-black ${isDark ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-white' : 'bg-white border-slate-200 text-slate-900'}`}
                                        placeholder="0"
                                    />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase text-blue-500 tracking-widest pl-1">Profit Split (%)</label>
                                <div className="relative">
                                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 font-bold">%</span>
                                    <input
                                        type="number"
                                        value={formData.profitSplitUsed || ''}
                                        onChange={(e) => {
                                            const split = Number(e.target.value);
                                            const gross = Number(formData.grossAmount) || 0;
                                            setFormData({
                                                ...formData,
                                                profitSplitUsed: split,
                                                amount: gross * (split / 100)
                                            });
                                        }}
                                        className={`w-full pl-4 pr-8 py-3 rounded-xl border outline-none font-mono font-black ${isDark ? 'bg-[var(--bg-page)] border-[var(--border-subtle)] text-white' : 'bg-white border-slate-200 text-slate-900'}`}
                                        placeholder="90"
                                    />
                                </div>
                            </div>
                        </div>

                        <div className="mt-4 pt-4 border-t border-blue-500/20 flex justify-between items-center">
                            <span className="text-[10px] font-black uppercase text-emerald-500 tracking-widest">Čistá Výplata (Net)</span>
                            <span className="text-2xl font-black font-mono text-emerald-500">
                                ${formData.amount?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Foto / Důkaz výplaty</label>
                        <div className="flex gap-4 items-start">
                            {formData.image ? (
                                <div className="relative w-32 h-32 rounded-xl border border-white/10 overflow-hidden group">
                                    <img src={formData.image} className="w-full h-full object-cover" alt="Payout proof" />
                                    <button
                                        onClick={() => setFormData(prev => ({ ...prev, image: '' }))}
                                        className="absolute top-2 right-2 p-1.5 bg-rose-500 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                                    >
                                        <X size={12} />
                                    </button>
                                </div>
                            ) : (
                                <label className={`w-32 h-32 rounded-xl border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition-all hover:border-blue-500/50 hover:bg-white/5 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
                                    <Plus size={24} className="text-slate-500" />
                                    <span className="text-[9px] font-black text-slate-500 uppercase mt-2">Nahrát foto</span>
                                    <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
                                </label>
                            )}
                            <div className="flex-1">
                                <p className="text-[9px] font-bold text-slate-500 uppercase leading-relaxed text-slate-500">
                                    Přiložte potvrzení o výplatě (screenshot z banky nebo prop firmy) jako důkaz do obchodního deníku.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase text-slate-500 tracking-widest">Poznámky</label>
                        <textarea
                            value={formData.notes}
                            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                            className={inputClass + " h-20 resize-none"}
                            placeholder="Napiš cokoli k této výplatě..."
                        />
                    </div>

                    <button
                        onClick={handleSave}
                        className={`w-full py-4 rounded-2xl font-black uppercase text-xs tracking-widest transition-all shadow-lg active:scale-[0.98] ${payout ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20' : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/20'}`}
                    >
                        {payout ? 'Uložit změny' : 'Potvrdit výplatu'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PayoutModal;
