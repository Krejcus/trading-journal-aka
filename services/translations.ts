
export const translations = {
    cs: {
        // Sidebar & Navigation
        dashboard: "Dashboard",
        journal: "Deník",
        accounts: "Účty",
        business: "Byznys",
        network: "Síť",
        settings: "Nastavení",
        logout: "Odhlásit se",
        online_profile: "Online • Profil",
        configuration: "Konfigurace",
        history: "Historie",
        analytics: "Analytika",

        // General Labels
        profit: "Zisk",
        loss: "Ztráta",
        win_rate: "Win Rate",
        trades: "Obchody",
        balance: "Zůstatek",
        equity: "Equity",
        pnl: "PnL",

        // Business Hub
        business_hub: "BUSINESS HUB",
        hq_desc: "SPRÁVA TRADINGOVÉHO BYZNYSU • HQ",
        finance: "FINANCE",
        goals: "CÍLE",
        net_cash: "Čistá firemní hotovost",
        tax_reserve: "Daňová rezerva",
        realized_income: "Realizované příjmy",
        operating_expenses: "Provozní náklady",
        payout_history: "Historie výplat",
        add_expense: "Přidat náklad",
        add_payout: "Přidat výplatu",
        monthly_burn: "Měsíční burn",
        yearly_projection: "Roční projekce",

        // Dashboards
        total_pnl: "Celkové PnL",
        avg_trade: "Průměrný obchod",
        profit_factor: "Profit Factor",
        max_drawdown: "Max Drawdown",
        calendar: "Kalendář",
        equity_curve: "Křivka kapitálu",
        recent_trades: "Poslední obchody",

        // Identity Modal
        trader_identity: "Identita Tradera",
        display_name: "Zobrazované jméno",
        main_currency: "Hlavní měna",
        timezone: "Časové pásmo",
        language: "Jazyk",
        change_password: "Změna hesla",
        current_password: "Současné heslo",
        new_password: "Nové heslo",
        save_settings: "Uložit nastavení",

        // Success/Error
        saved_successfully: "Uloženo úspěšně",
        error_saving: "Chyba při ukládání",
    },
    en: {
        // Sidebar & Navigation
        dashboard: "Dashboard",
        journal: "Journal",
        accounts: "Accounts",
        business: "Business Hub",
        network: "Network",
        settings: "Settings",
        logout: "Logout",
        online_profile: "Online • Profile",
        configuration: "Configuration",
        history: "History",
        analytics: "Analytics",

        // General Labels
        profit: "Profit",
        loss: "Loss",
        win_rate: "Win Rate",
        trades: "Trades",
        balance: "Balance",
        equity: "Equity",
        pnl: "PnL",

        // Business Hub
        business_hub: "BUSINESS HUB",
        hq_desc: "TRADING BUSINESS MANAGEMENT • HQ",
        finance: "FINANCIALS",
        goals: "GOALS",
        net_cash: "Net Business Cash",
        tax_reserve: "Tax Reserve",
        realized_income: "Realized Income",
        operating_expenses: "Operating Expenses",
        payout_history: "Payout History",
        add_expense: "Add Expense",
        add_payout: "Add Payout",
        monthly_burn: "Monthly Burn",
        yearly_projection: "Yearly Projection",

        // Dashboards
        total_pnl: "Total PnL",
        avg_trade: "Avg Trade",
        profit_factor: "Profit Factor",
        max_drawdown: "Max Drawdown",
        calendar: "Calendar",
        equity_curve: "Equity Curve",
        recent_trades: "Recent Trades",

        // Identity Modal
        trader_identity: "Trader Identity",
        display_name: "Display Name",
        main_currency: "Base Currency",
        timezone: "Timezone",
        language: "Language",
        change_password: "Change Password",
        current_password: "Current Password",
        new_password: "New Password",
        save_settings: "Save Settings",

        // Success/Error
        saved_successfully: "Saved successfully",
        error_saving: "Error saving",
    }
};

export type TranslationKey = keyof typeof translations.en;

export const t = (key: TranslationKey, lang: 'cs' | 'en' = 'cs') => {
    return translations[lang][key] || translations['en'][key] || key;
};
