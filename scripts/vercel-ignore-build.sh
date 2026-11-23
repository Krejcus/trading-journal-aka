#!/bin/sh
# Vercel „Ignored Build Step“: exit 0 = build PŘESKOČIT, exit 1 = buildit.
# Šetří build minuty (23. 11. 2026: buildy byly druhá největší položka účtu).
# 1) Náhledy vedlejších větví se nebuildí — produkce je jen `main`.
# 2) Commity, které nemění nic z webu ani API (dokumentace, testy, iOS, Pine, skripty, migrace), se nebuildí.
# Když git porovnání selže (mělký klon, neznámý předchozí commit), builduje se — raději build navíc než chybějící deploy.

if [ "$VERCEL_GIT_COMMIT_REF" != "main" ]; then
  echo "Přeskakuji: větev $VERCEL_GIT_COMMIT_REF není main."
  exit 0
fi

BASE="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
git cat-file -e "$BASE^{commit}" 2>/dev/null || { echo "Předchozí commit $BASE není v klonu, builduji."; exit 1; }

if git diff --quiet "$BASE" HEAD -- . \
  ':(exclude)docs' ':(exclude)tests' ':(exclude)mockups' ':(exclude)analyzy' ':(exclude)branding' \
  ':(exclude)capacitor-ios' ':(exclude)ios' ':(exclude)tradingview' ':(exclude)supabase' \
  ':(exclude)migrations' ':(exclude)scripts' ':(exclude).claude' ':(exclude)*.md'; then
  echo "Přeskakuji: od $BASE se nezměnilo nic, co jde do webu nebo API."
  exit 0
fi
echo "Builduji: změna kódu webu nebo API."
exit 1
