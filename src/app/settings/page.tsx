"use client";

import DashboardLayout from "@/components/DashboardLayout";
import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { Trash2, Plus, Moon, Sun, Monitor } from "lucide-react";
import { Account } from "@/db/schema";

export default function SettingsPage() {
    const { theme, setTheme } = useTheme();
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [newAccountName, setNewAccountName] = useState("");
    const [newAccountBalance, setNewAccountBalance] = useState("");
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        fetchAccounts();
    }, []);

    const fetchAccounts = async () => {
        try {
            const res = await fetch('/api/accounts');
            if (res.ok) {
                const data = await res.json();
                setAccounts(data);
            }
        } catch (e) {
            console.error("Failed to fetch accounts", e);
        }
    };

    const handleAddAccount = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newAccountName) return;

        setLoading(true);
        try {
            const res = await fetch('/api/accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newAccountName,
                    initialBalance: parseFloat(newAccountBalance) || 0,
                    currency: 'USD'
                })
            });

            if (res.ok) {
                setNewAccountName("");
                setNewAccountBalance("");
                fetchAccounts();
            }
        } catch (e) {
            console.error("Failed to add account", e);
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteAccount = async (id: number) => {
        if (!confirm("Opravdu chcete smazat tento účet?")) return;

        try {
            const res = await fetch(`/api/accounts/${id}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                fetchAccounts();
            } else {
                alert("Nelze smazat účet (možná obsahuje obchody).");
            }
        } catch (e) {
            console.error("Failed to delete account", e);
        }
    };

    return (
        <DashboardLayout>
            <div className="p-8 max-w-4xl mx-auto">
                <h1 className="text-3xl font-bold text-white mb-8">Nastavení</h1>

                {/* Appearance Section */}
                <section className="mb-12">
                    <h2 className="text-xl font-semibold text-white mb-4 border-b border-slate-800 pb-2">Vzhled Aplikace</h2>
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-slate-300 font-medium">Barevný Režim</p>
                                <p className="text-slate-500 text-sm">Vyberte si mezi světlým a tmavým režimem.</p>
                            </div>
                            <div className="flex bg-slate-800 p-1 rounded-lg">
                                <button
                                    onClick={() => setTheme("light")}
                                    className={`p-2 rounded-md transition-all ${theme === "light" ? "bg-white text-slate-900 shadow" : "text-slate-400 hover:text-white"}`}
                                    title="Světlý"
                                >
                                    <Sun className="w-5 h-5" />
                                </button>
                                <button
                                    onClick={() => setTheme("system")}
                                    className={`p-2 rounded-md transition-all ${theme === "system" ? "bg-slate-700 text-white shadow" : "text-slate-400 hover:text-white"}`}
                                    title="Systémový"
                                >
                                    <Monitor className="w-5 h-5" />
                                </button>
                                <button
                                    onClick={() => setTheme("dark")}
                                    className={`p-2 rounded-md transition-all ${theme === "dark" ? "bg-slate-950 text-white shadow" : "text-slate-400 hover:text-white"}`}
                                    title="Tmavý"
                                >
                                    <Moon className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Accounts Section */}
                <section>
                    <h2 className="text-xl font-semibold text-white mb-4 border-b border-slate-800 pb-2">Správa Účtů</h2>
                    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                        {/* Add Account Form */}
                        <div className="p-6 border-b border-slate-800 bg-slate-800/30">
                            <form onSubmit={handleAddAccount} className="flex gap-4 items-end">
                                <div className="flex-1">
                                    <label className="block text-xs text-slate-400 mb-1">Název Účtu</label>
                                    <input
                                        type="text"
                                        value={newAccountName}
                                        onChange={(e) => setNewAccountName(e.target.value)}
                                        placeholder="např. Live 2024"
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                                    />
                                </div>
                                <div className="w-40">
                                    <label className="block text-xs text-slate-400 mb-1">Počáteční Zůstatek</label>
                                    <input
                                        type="number"
                                        value={newAccountBalance}
                                        onChange={(e) => setNewAccountBalance(e.target.value)}
                                        placeholder="USD"
                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500"
                                    />
                                </div>
                                <button
                                    type="submit"
                                    disabled={loading || !newAccountName}
                                    className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Plus className="w-4 h-4" />
                                    Přidat
                                </button>
                            </form>
                        </div>

                        {/* Accounts List */}
                        <div className="divide-y divide-slate-800">
                            {accounts.length === 0 ? (
                                <div className="p-8 text-center text-slate-500">
                                    Zatím nemáte žádné účty. Přidejte první!
                                </div>
                            ) : (
                                accounts.map((account) => (
                                    <div key={account.id} className="p-4 flex items-center justify-between hover:bg-slate-800/50 transition-colors">
                                        <div>
                                            <div className="font-semibold text-white">{account.name}</div>
                                            <div className="text-sm text-slate-400">
                                                Počáteční stav: <span className="font-mono text-slate-300">${account.initialBalance?.toLocaleString()}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            {/* Future: Edit button */}
                                            <button
                                                onClick={() => handleDeleteAccount(account.id)}
                                                className="p-2 text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                                                title="Smazat účet"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </section>
            </div>
        </DashboardLayout>
    );
}
