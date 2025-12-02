"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";

interface AddTradeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onTradeAdded: () => void;
}

export default function AddTradeModal({ isOpen, onClose, onTradeAdded }: AddTradeModalProps) {
    const [formData, setFormData] = useState({
        symbol: "NQ",
        side: "LONG",
        entryPrice: "",
        exitPrice: "",
        slPrice: "",
        tpPrice: "",
        size: "1",
        entryTime: new Date().toISOString().slice(0, 16), // Current time for datetime-local
        exitTime: "",
        notes: "",
        accountId: "" // New field
    });
    const [loading, setLoading] = useState(false);
    const [accounts, setAccounts] = useState<any[]>([]);

    useEffect(() => {
        if (isOpen) {
            fetchAccounts();
        }
    }, [isOpen]);

    const fetchAccounts = async () => {
        try {
            const res = await fetch('/api/accounts');
            if (res.ok) {
                const data = await res.json();
                setAccounts(data);
                // Set default account if available and not set
                if (data.length > 0 && !formData.accountId) {
                    setFormData(prev => ({ ...prev, accountId: data[0].id.toString() }));
                }
            }
        } catch (e) {
            console.error("Failed to fetch accounts", e);
        }
    };

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            const res = await fetch('/api/trades', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...formData,
                    accountId: formData.accountId ? parseInt(formData.accountId) : null
                })
            });

            if (res.ok) {
                onTradeAdded();
                onClose();
                setFormData({
                    symbol: "NQ",
                    side: "LONG",
                    entryPrice: "",
                    exitPrice: "",
                    slPrice: "",
                    tpPrice: "",
                    size: "1",
                    entryTime: new Date().toISOString().slice(0, 16),
                    exitTime: "",
                    notes: "",
                    accountId: accounts.length > 0 ? accounts[0].id.toString() : ""
                });
            } else {
                alert("Failed to add trade");
            }
        } catch (error) {
            console.error(error);
            alert("Error adding trade");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-xl bg-slate-900 border border-slate-800 p-6 shadow-xl">
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-xl font-bold text-white">Přidat Obchod</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-white">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    {/* Account Selection */}
                    <div>
                        <label className="block text-sm font-medium text-slate-400 mb-1">Účet</label>
                        <select
                            value={formData.accountId}
                            onChange={(e) => setFormData({ ...formData, accountId: e.target.value })}
                            className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none"
                        >
                            <option value="">-- Vyberte účet --</option>
                            {accounts.map(acc => (
                                <option key={acc.id} value={acc.id}>{acc.name}</option>
                            ))}
                        </select>
                        {accounts.length === 0 && (
                            <p className="text-xs text-amber-500 mt-1">Nemáte žádné účty. Vytvořte je v Nastavení.</p>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-slate-400 mb-1">Symbol</label>
                            <input
                                type="text"
                                value={formData.symbol}
                                onChange={e => setFormData({ ...formData, symbol: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-white focus:border-emerald-500 outline-none uppercase"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-sm text-slate-400 mb-1">Směr</label>
                            <select
                                value={formData.side}
                                onChange={e => setFormData({ ...formData, side: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-white focus:border-emerald-500 outline-none"
                            >
                                <option value="LONG">LONG 🟢</option>
                                <option value="SHORT">SHORT 🔴</option>
                            </select>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-slate-400 mb-1">Vstupní Cena</label>
                            <input
                                type="number"
                                step="0.25"
                                value={formData.entryPrice}
                                onChange={e => setFormData({ ...formData, entryPrice: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-white focus:border-emerald-500 outline-none"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-sm text-slate-400 mb-1">Výstupní Cena (Volitelné)</label>
                            <input
                                type="number"
                                step="0.25"
                                value={formData.exitPrice}
                                onChange={e => setFormData({ ...formData, exitPrice: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-white focus:border-emerald-500 outline-none"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-slate-400 mb-1">Stop Loss (Volitelné)</label>
                            <input
                                type="number"
                                step="0.25"
                                value={formData.slPrice}
                                onChange={e => setFormData({ ...formData, slPrice: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-white focus:border-emerald-500 outline-none"
                            />
                        </div>
                        <div>
                            <label className="block text-sm text-slate-400 mb-1">Take Profit (Volitelné)</label>
                            <input
                                type="number"
                                step="0.25"
                                value={formData.tpPrice}
                                onChange={e => setFormData({ ...formData, tpPrice: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-white focus:border-emerald-500 outline-none"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm text-slate-400 mb-1">Velikost (Kontrakty)</label>
                            <input
                                type="number"
                                step="0.01"
                                value={formData.size}
                                onChange={e => setFormData({ ...formData, size: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-white focus:border-emerald-500 outline-none"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-sm text-slate-400 mb-1">Čas Vstupu</label>
                            <input
                                type="datetime-local"
                                value={formData.entryTime}
                                onChange={e => setFormData({ ...formData, entryTime: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-white focus:border-emerald-500 outline-none"
                                required
                            />
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm text-slate-400 mb-1">Poznámka</label>
                        <textarea
                            value={formData.notes}
                            onChange={e => setFormData({ ...formData, notes: e.target.value })}
                            className="w-full bg-slate-800 border border-slate-700 rounded p-2 text-white focus:border-emerald-500 outline-none h-20"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-lg transition-colors disabled:opacity-50"
                    >
                        {loading ? "Ukládám..." : "Uložit Obchod"}
                    </button>
                </form>
            </div>
        </div>
    );
}
