# 📦 QuantumLoader Archive

**Archived Date:** 2026-02-04  
**Status:** ✅ Complete & Ready to Restore  
**Replaced By:** Simple AT Logo Loader

---

## 📋 **QUICK START**

### **TO RESTORE:**
```bash
cd .archive/quantum-loader
bash restore-quantum-loader.sh
```

**Or manually:**
```bash
cp .archive/quantum-loader/QuantumLoader.tsx components/
# Then add CSS from quantum-loader.css to index.css
```

---

## 📁 **ARCHIVE CONTENTS**

```
.archive/quantum-loader/
├── README.md                    # This file
├── QuantumLoader.tsx            # Full component code (199 lines)
├── quantum-loader.css           # Required CSS animations
├── RESTORATION_GUIDE.md         # Complete documentation
└── restore-quantum-loader.sh    # Automated restore script
```

---

## 🎯 **WHAT IS THIS?**

**QuantumLoader** je advanced loading animace s:
- 📊 Live candlestick chart (HTML canvas)
- 💫 3D animated text "Načítám..."
- 📈 Progress bar s gradient glow
- 🎨 Theme support (dark/light/OLED)

**Replaced by:** Simple pulsing/rotating AT logo (for consistency + performance)

---

## 📖 **FULL DOCUMENTATION**

**Read:** `RESTORATION_GUIDE.md` (150+ lines of detailed docs)

**Includes:**
- Step-by-step restore instructions
- Technical details & customization
- Performance notes & bundle size impact
- Troubleshooting guide
- When to use chart vs. simple logo

---

## ⚡ **ONE-LINE RESTORE**

```bash
bash .archive/quantum-loader/restore-quantum-loader.sh
```

**What it does:**
1. ✅ Copies `QuantumLoader.tsx` to `components/`
2. ✅ Adds CSS to `index.css` (if missing)
3. ✅ Verifies `framer-motion` installed
4. ✅ Shows success message with next steps

---

## 🎨 **VISUAL COMPARISON**

### **QuantumLoader (Archived)**
```
┌─────────────────────────────────┐
│  [ANIMATED CANDLESTICK CHART]   │
│                                 │
│       N a č í t á m . . .       │
│      [3D rotating letters]      │
│                                 │
│        ═════════█═════          │
│                                 │
└─────────────────────────────────┘
```

### **Current Simple Loader**
```
┌─────────────────────────────────┐
│                                 │
│                                 │
│           [AT LOGO]             │
│        (pulsing + spin)         │
│                                 │
│                                 │
│                                 │
└─────────────────────────────────┘
```

---

## 📊 **WHY ARCHIVED?**

| Reason | Explanation |
|--------|-------------|
| **Consistency** | AT logo loader used everywhere else |
| **Performance** | Simple loader = lighter (9 KB saved) |
| **Mobile** | Chart detail hard to see on small screens |
| **Frequency** | Chart too heavy for frequent lazy loads |

**But:** Chart looks cooler for initial app load! 🎨

---

## 🔄 **RESTORE CHECKLIST**

After running restore script:

- [ ] Run `npm run dev`
- [ ] Reload app
- [ ] See animated chart on loading screen ✨
- [ ] Test theme switching (dark/light/OLED)
- [ ] Verify no console errors
- [ ] Check mobile responsiveness

---

## 🛠️ **CUSTOMIZATION**

**After restore, you can:**
- Change candle count (default: 70)
- Change candle colors (green/red → blue/purple)
- Change animation speed (default: 40ms per candle)
- Change text (default: "Načítám")

**See:** `RESTORATION_GUIDE.md` → "CUSTOMIZATION OPTIONS"

---

## 🚀 **FUTURE USE CASES**

**Consider restoring when:**
- ✅ You want impressive initial load animation
- ✅ Building trading/finance specific app
- ✅ Desktop-first experience (chart detail matters)
- ✅ User sees loading screen infrequently

**Don't restore if:**
- ❌ Frequent loading screens (too heavy)
- ❌ Mobile-first app (simple better)
- ❌ Want consistent branding (AT logo everywhere)

---

## 📝 **VERSION INFO**

**Original Implementation:**
- Created: ~Jan 2026
- Last Used: 2026-02-04
- Git Commit: `418b97a`

**Archive Version:**
- Archived: 2026-02-04
- Files: 4 total
- Size: ~10 KB uncompressed

---

## 🎓 **LEARNING RESOURCE**

This archive is also a **great reference** for:
- HTML Canvas animations
- Framer Motion usage
- CSS keyframe animations
- React component lifecycle (useEffect cleanup)
- Theme-aware components

**Study the code even if you don't restore it!** 📚

---

## 💡 **QUICK TIPS**

1. **Don't delete this folder** - It's small and might be useful later
2. **Read RESTORATION_GUIDE.md** - Super detailed docs
3. **Test after restore** - Especially on mobile
4. **Can revert anytime** - Simple loader code is in guide

---

**Questions? Check:** `RESTORATION_GUIDE.md`  
**Problems? Debug section:** `RESTORATION_GUIDE.md` → "COMMON ISSUES & FIXES"

---

**Preserved with ❤️ for future Filip** 🚀✨
