# 🎯 Dashboard Customization - Roadmap

## 📊 Současný Stav (Co už máš)

### ✅ Implementováno:
- **16 různých widgetů** (KPIs, Charts, Calendar, atd.)
- **Armory Sidebar** pro přidávání/odebírání widgetů
- **3 velikosti** widgetů: small (1 col), large (2 cols), full (4 cols)
- **4 výšky** (rowSpan): 1-4 řádky
- **Kategorizace** widgetů (KPIs, Psychologie, Analýza, Chování)
- **Search** v Armory
- **Šipky** pro změnu pořadí (prev/next)
- **Widget-specific features**: např. "Zlatá křivka" pro Equity widget
- **Persist** layout do UserPreferences

---

## 🚀 Návrhy Vylepšení (Prioritizováno)

### 🔥 **TIER 1: Quick Wins** (1-2 dny práce)

#### 1. **Drag & Drop Widget Reordering**
**Proč:** Šipky jsou pomalé, DnD je intuitivní a rychlé.

**Implementace:**
```bash
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

**Změny:**
- Wrap grid v `<DndContext>`
- Každý widget v `<SortableContext>`
- Visual feedback při dragging (opacity, shadow)
- Ghost preview při přetahování

**Benefit:** 10x rychlejší reorganizace layoutu

---

#### 2. **Widget Presets/Templates**
**Proč:** Uživatelé mají různé potřeby v různých situacích.

**Presets:**
```typescript
interface DashboardPreset {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  layout: DashboardWidgetConfig[];
  targetMode?: DashboardMode;
}

const PRESETS: DashboardPreset[] = [
  {
    id: 'day_trader',
    name: 'Day Trader',
    description: 'Focus na session performance a hodinový výkon',
    icon: <Zap />,
    layout: [
      { id: 'kpi_pnl', visible: true, size: 'small', order: 0 },
      { id: 'session_performance', visible: true, size: 'large', order: 1 },
      { id: 'hourly_edge', visible: true, size: 'full', order: 2 },
      { id: 'equity', visible: true, size: 'full', order: 3 },
    ]
  },
  {
    id: 'challenge_hunter',
    name: 'Challenge Hunter',
    description: 'Sledování challenge progress a disciplíny',
    icon: <Target />,
    layout: [
      { id: 'challenge_target', visible: true, size: 'large', order: 0 },
      { id: 'kpi_pnl', visible: true, size: 'small', order: 1 },
      { id: 'discipline', visible: true, size: 'full', order: 2 },
      { id: 'calendar', visible: true, size: 'full', order: 3 },
    ]
  },
  {
    id: 'analyst',
    name: 'Analytik',
    description: 'Deep dive do statistik a patterns',
    icon: <Brain />,
    layout: [
      { id: 'kpi_profit_factor', visible: true, size: 'small', order: 0 },
      { id: 'kpi_winrate', visible: true, size: 'small', order: 1 },
      { id: 'winners_losers', visible: true, size: 'full', order: 2 },
      { id: 'monthly_performance', visible: true, size: 'full', order: 3 },
      { id: 'daily_edge', visible: true, size: 'large', order: 4 },
      { id: 'hourly_edge', visible: true, size: 'large', order: 5 },
    ]
  },
  {
    id: 'minimalist',
    name: 'Minimalist',
    description: 'Jen essential KPIs a equity curve',
    icon: <Minimize2 />,
    layout: [
      { id: 'kpi_pnl', visible: true, size: 'small', order: 0 },
      { id: 'kpi_winrate', visible: true, size: 'small', order: 1 },
      { id: 'equity', visible: true, size: 'full', order: 2 },
    ]
  },
  {
    id: 'complete',
    name: 'Complete Overview',
    description: 'Všechny důležité widgety na jednom místě',
    icon: <LayoutGrid />,
    layout: MASTER_WIDGET_LIST.map((w, i) => ({
      id: w.id,
      label: w.label,
      visible: true,
      size: w.id.startsWith('kpi_') ? 'small' : 'large',
      rowSpan: w.defaultRowSpan || 1,
      order: i
    }))
  }
];
```

**UI Changes:**
- Přidat "Presets" button vedle edit mode
- Modal s preview obrázky každého presetu
- One-click apply preset
- Option to "Save current as preset"

**User Flow:**
```
Klikni "Presets" → Vyber "Day Trader" → Apply → Layout se změní
```

---

#### 3. **Widget Quick Actions Menu**
**Proč:** Rychlejší práce s widgety bez edit mode.

**Features:**
- Right-click na widget → context menu
- Actions:
  - 📌 Pin to top
  - 🔄 Refresh data
  - ⚙️ Widget settings
  - 📤 Export widget data
  - 🗑️ Remove
  - 📏 Change size
  - 🔒 Lock position

**Implementation:**
```tsx
const WidgetContextMenu = ({ widget, onAction }) => {
  return (
    <div className="widget-context-menu">
      <button onClick={() => onAction('refresh')}>
        <RefreshCw size={14} /> Refresh
      </button>
      <button onClick={() => onAction('settings')}>
        <Settings size={14} /> Settings
      </button>
      {/* ... */}
    </div>
  );
};
```

---

### ⭐ **TIER 2: Major Features** (3-5 dní práce)

#### 4. **Per-Widget Settings Panel**
**Proč:** Každý widget potřebuje vlastní konfiguraci.

**Příklady nastavení:**

**Equity Curve:**
- ☑️ Show disciplined curve (golden path)
- ☑️ Show drawdown overlay
- ☑️ Show trade markers
- 🎨 Line color
- 📊 Chart type (Line, Area, Candlestick)
- 📅 Time range (1M, 3M, 6M, 1Y, All)

**Calendar Widget:**
- 🌈 Heat map color scheme (Green/Red, Blue/Orange, Custom)
- 📊 Display mode (PnL, Win/Loss, Streak, Days traded)
- ☑️ Show prep/review dots
- ☑️ Show weekend

**Session Performance:**
- ☑️ Auto-hide inactive sessions
- 🔔 Alert when session starts
- 📊 Chart type (Bars, Pie, Table)

**KPI Cards:**
- 📊 Visualization (Text, Donut, Gauge, Mini-chart)
- 🎨 Color theme
- ☑️ Show comparison (vs last week/month)
- ☑️ Show trend arrow

**Implementation:**
```typescript
interface WidgetSettings {
  widgetId: string;
  settings: Record<string, any>;
}

// V UserPreferences:
widgetSettings?: WidgetSettings[];

// UI: Gear icon na každém widgetu → Modal s nastavením
```

---

#### 5. **Multi-Dashboard Support**
**Proč:** Různé dashboardy pro různé účely.

**Concept:**
```typescript
interface Dashboard {
  id: string;
  name: string;
  icon: string;
  layout: DashboardWidgetConfig[];
  mode?: DashboardMode;
  isDefault?: boolean;
}

// User má array dashboardů:
dashboards: Dashboard[];
activeDashboardId: string;
```

**Use Cases:**
- **Morning Dashboard**: Prep + Challenge Target + Session Performance
- **Trading Dashboard**: Live stats + Equity + Session
- **Review Dashboard**: Calendar + Discipline + Winners/Losers
- **Weekly Review**: Monthly Performance + Streak + Goals

**UI:**
- Tabs v headeru pro rychlé přepínání
- "➕ New Dashboard" button
- Duplicate/Delete dashboard

---

#### 6. **Responsive Layouts**
**Proč:** Desktop/Tablet/Mobile mají jiné potřeby.

**Breakpoints:**
```typescript
interface ResponsiveLayout {
  desktop: DashboardWidgetConfig[];   // cols: 4
  tablet: DashboardWidgetConfig[];    // cols: 2
  mobile: DashboardWidgetConfig[];    // cols: 1
}
```

**Smart Defaults:**
- Mobile: Stack všechny widgety vertically, KPIs first
- Tablet: 2 columns, prioritize KPIs and Equity
- Desktop: Full custom layout

**Implementation:**
```tsx
const getLayoutForDevice = () => {
  if (window.innerWidth < 768) return layout.mobile;
  if (window.innerWidth < 1024) return layout.tablet;
  return layout.desktop;
};
```

---

#### 7. **Widget Resize Handles**
**Proč:** Vizuální resize je přirozenější než buttony.

**Library:**
```bash
npm install react-resizable
```

**Features:**
- Resize handles v rozích widgetu
- Snap to grid (1/4, 2/4, 3/4, 4/4 columns)
- Min/max constraints
- Live preview při resize

**Visual:**
```
┌─────────────────┐
│                 ┼  ← Resize handle (bottom-right)
│     Widget      │
│                 │
└─────────────────┘
```

---

### 💎 **TIER 3: Advanced** (5-10 dní práce)

#### 8. **Widget Groups & Tabs**
**Proč:** Organizace velkého množství widgetů.

**Concept:**
```typescript
interface WidgetGroup {
  id: string;
  name: string;
  icon: React.ReactNode;
  widgets: string[]; // Widget IDs
  collapsed?: boolean;
}

// Příklad:
groups: [
  {
    id: 'performance',
    name: 'Performance',
    icon: <TrendingUp />,
    widgets: ['kpi_pnl', 'kpi_winrate', 'equity', 'calendar']
  },
  {
    id: 'psychology',
    name: 'Psychology',
    icon: <Brain />,
    widgets: ['discipline', 'streak', 'winners_losers']
  }
]
```

**UI:**
- Collapsible sections
- Tab navigation mezi groups
- Drag widget mezi groups

---

#### 9. **Widget Data Export**
**Proč:** Power users chtějí data ven.

**Features:**
- Export widget data to CSV/JSON
- Screenshot widgetu
- Share widget jako odkaz
- Export celého dashboardu jako PDF

**Implementation:**
```tsx
const exportWidget = (widgetId: string, format: 'csv' | 'json' | 'png') => {
  const data = getWidgetData(widgetId);
  if (format === 'csv') return downloadCSV(data);
  if (format === 'json') return downloadJSON(data);
  if (format === 'png') return html2canvas(widgetRef);
};
```

---

#### 10. **Widget Notifications & Alerts**
**Proč:** Proaktivní upozornění na důležité změny.

**Examples:**
- 🔔 "Max Drawdown překročil 10%"
- 🔔 "Streak: 5 výher v řadě!"
- 🔔 "Challenge target: Zbývá 5%"
- 🔔 "Nový personal best PnL!"

**Implementation:**
```typescript
interface WidgetAlert {
  widgetId: string;
  condition: (stats: TradeStats) => boolean;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  enabled: boolean;
}

// Příklad:
alerts: [
  {
    widgetId: 'kpi_max_drawdown',
    condition: (stats) => stats.maxDrawdown > stats.initialBalance * 0.10,
    message: 'Drawdown překročil 10%!',
    severity: 'warning',
    enabled: true
  }
]
```

---

#### 11. **Widget Themes & Color Schemes**
**Proč:** Personalizace a branding.

**Features:**
- Global theme (už máš: dark/light/oled)
- Per-widget color overrides
- Color palettes (Professional, Vibrant, Minimal, Neon)
- Custom gradient backgrounds

**Implementation:**
```typescript
interface WidgetTheme {
  widgetId: string;
  backgroundColor?: string;
  borderColor?: string;
  textColor?: string;
  accentColor?: string;
  gradient?: { from: string; to: string };
}
```

---

#### 12. **Layout Sharing & Import**
**Proč:** Community sharing, onboarding nových uživatelů.

**Features:**
- Export layout jako JSON file
- Import layout ze souboru
- Gallery of community layouts
- One-click "Clone this layout"

**Implementation:**
```typescript
const exportLayout = () => {
  const layoutData = {
    name: 'My Custom Layout',
    author: user.name,
    version: '1.0',
    layout: currentLayout,
    widgetSettings: widgetSettings
  };
  downloadJSON(layoutData, 'dashboard-layout.json');
};

const importLayout = (file: File) => {
  const data = await parseJSON(file);
  onUpdateLayout(data.layout);
  // Apply widget settings
};
```

---

## 📋 Implementation Priority

### Phase 1 (Týden 1):
1. ✅ Drag & Drop reordering
2. ✅ Widget Presets
3. ✅ Quick Actions Menu

### Phase 2 (Týden 2):
4. ✅ Per-Widget Settings
5. ✅ Multi-Dashboard Support

### Phase 3 (Týden 3-4):
6. ✅ Responsive Layouts
7. ✅ Resize Handles
8. ✅ Widget Groups

### Phase 4 (Měsíc 2):
9. ✅ Data Export
10. ✅ Widget Alerts
11. ✅ Custom Themes
12. ✅ Layout Sharing

---

## 🎨 UX Improvements

### A) **Visual Widget Preview in Armory**
Místo jen textu ukázat live preview každého widgetu jako miniatura.

### B) **Widget Heatmap**
Zobrazit které widgety jsou "hot" (často používané) vs "cold" (málo otevřené).

### C) **Guided Setup Wizard**
Pro nové uživatele: "Vyber si svůj trading styl" → Auto-configure optimal layout.

### D) **Compact Mode Toggle**
Zmenšit padding/margins pro více info na obrazovce.

### E) **Fullscreen Widget Mode**
Double-click na widget → expand to fullscreen s detaily.

### F) **Widget Lock**
🔒 Zamknout layout aby se náhodou nezměnil při scrolling/touch.

---

## 🔧 Technical Architecture

### New Types:
```typescript
// types.ts rozšíření:

interface DashboardPreset {
  id: string;
  name: string;
  description: string;
  icon: string;
  layout: DashboardWidgetConfig[];
  mode?: DashboardMode;
}

interface WidgetSettings {
  widgetId: string;
  chartType?: 'line' | 'area' | 'bar';
  colorScheme?: string;
  timeRange?: string;
  showLegend?: boolean;
  customColors?: {
    primary?: string;
    secondary?: string;
    background?: string;
  };
  [key: string]: any; // Widget-specific settings
}

interface Dashboard {
  id: string;
  name: string;
  icon: string;
  layout: DashboardWidgetConfig[];
  widgetSettings: WidgetSettings[];
  mode?: DashboardMode;
  isDefault?: boolean;
  createdAt: number;
  updatedAt: number;
}

// V UserPreferences přidat:
interface UserPreferences {
  // ... existing fields
  dashboards?: Dashboard[];
  activeDashboardId?: string;
  widgetSettings?: WidgetSettings[];
  dashboardPresets?: DashboardPreset[];
  layoutLocked?: boolean;
}
```

### New Components:
```
components/
├── Dashboard/
│   ├── Dashboard.tsx (main)
│   ├── DashboardTabs.tsx (multi-dashboard tabs)
│   ├── WidgetContextMenu.tsx (right-click menu)
│   ├── WidgetSettingsModal.tsx (per-widget settings)
│   ├── PresetGallery.tsx (preset selector)
│   ├── LayoutExporter.tsx (export/import)
│   └── widgets/
│       ├── WidgetWrapper.tsx (common wrapper)
│       ├── WidgetHeader.tsx (title, actions)
│       └── ... (individual widgets)
```

---

## 📊 Success Metrics

Po implementaci měř:
- ⏱️ **Time to customize dashboard**: Mělo by být < 30s změnit layout
- 📈 **Widget usage**: Které widgety jsou nejpoužívanější?
- 🔄 **Layout changes per user**: Jak často uživatelé upravují layout?
- 😊 **User satisfaction**: Survey po použití nové customizace
- 🐛 **Bug reports**: Měly by klesnout díky lepšímu UX

---

## 🎯 Final Vision

**Ultimate Goal:** Dashboard, který se adaptuje na potřeby každého tradera:
- Začátečník: Simple preset s KPIs a Calendar
- Day Trader: Session focus, live updates
- Challenge Hunter: Progress tracking, discipline
- Analyst: Deep stats, všechny metriky

**One Dashboard, Infinite Possibilities** 🚀

---

## 💡 Bonus Ideas

1. **AI Layout Suggestions**: "Based on your trading style, we recommend..."
2. **Widget Marketplace**: Community může vytvářet vlastní widgety
3. **Widget Animations**: Smooth transitions při změně dat
4. **Voice Commands**: "Show me my equity curve"
5. **Widget Shortcuts**: Cmd+1 = KPI PnL, Cmd+2 = Equity, atd.
6. **Collaborative Dashboards**: Sdílený dashboard s trading partnerem
7. **Historical Layouts**: "Restore dashboard from 2 weeks ago"
8. **Widget A/B Testing**: Porovnat 2 layouty a vidět který funguje lépe
9. **Smart Defaults by Account Type**: Challenge → auto-show Challenge widget
10. **Widget Tooltips**: Hover na widget → quick stats bez klikání

---

## 📝 Next Steps

1. **Review tento dokument** a prioritizuj features podle potřeby
2. **Vytvoř GitHub issues** pro každou feature
3. **Design mockups** v Figma/Excalidraw pro UI
4. **Implementuj Phase 1** (Quick Wins) během příštího týdne
5. **Gather feedback** od beta uživatelů
6. **Iterate** based on real usage

**Ready to make the best trading dashboard ever?** 🎯🚀
