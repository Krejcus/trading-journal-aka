#!/bin/bash
# Quick restore script for QuantumLoader
# Usage: bash restore-quantum-loader.sh

set -e

echo "🔄 Restoring QuantumLoader with Chart Animation..."
echo ""

# Step 1: Copy component
echo "[1/3] Copying component file..."
cp .archive/quantum-loader/QuantumLoader.tsx components/QuantumLoader.tsx
echo "      ✅ Component restored to components/QuantumLoader.tsx"

# Step 2: Add CSS (check if not already exists)
echo "[2/3] Checking CSS animations..."
if grep -q "generating-loader-letter" index.css; then
  echo "      ⚠️  CSS animations already exist in index.css, skipping"
else
  echo "      Adding CSS animations to index.css..."
  echo "" >> index.css
  echo "/* ===== QUANTUM LOADER (Restored) ===== */" >> index.css
  cat .archive/quantum-loader/quantum-loader.css >> index.css
  echo "      ✅ CSS animations added"
fi

# Step 3: Verify framer-motion
echo "[3/3] Verifying dependencies..."
if npm list framer-motion > /dev/null 2>&1; then
  echo "      ✅ framer-motion is installed"
else
  echo "      ⚠️  framer-motion not found. Installing..."
  npm install framer-motion
  echo "      ✅ framer-motion installed"
fi

echo ""
echo "🎉 QuantumLoader successfully restored!"
echo ""
echo "📋 What changed:"
echo "   • components/QuantumLoader.tsx → Chart animation version"
echo "   • index.css → Added CSS animations (if missing)"
echo "   • framer-motion → Verified installed"
echo ""
echo "✨ Next steps:"
echo "   1. Reload your app (npm run dev)"
echo "   2. You should see animated chart on loading screen"
echo "   3. Check RESTORATION_GUIDE.md for customization options"
echo ""
echo "🔙 To revert to simple AT logo:"
echo "   • See RESTORATION_GUIDE.md section 'REVERTING TO SIMPLE LOADER'"
echo ""
