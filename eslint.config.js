import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Pragmatická konfigurace: cílem je CHYTAT BUGY (hlavně react-hooks — chybějící deps,
// pravidla hooků, leaky), ne reformátovat celý codebase. Šumivé/stylové rules jsou jen
// `warn` (lint kvůli nim nespadne), reálné bug-rules jsou `error` (lint na nich spadne).
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'extension/dist/**',
      'extension/*.js',    // volné test/debug skripty (get_roles.js, test_*.js)
      '**/*.mjs',          // volné Node skripty (migrate-screenshots.mjs, test_*.mjs)
      'node_modules/**',
      'backups/**',
      '.archive/**',
      '.agent/**',
      '.agents/**',
      'scripts/**',        // debug utility, ne součást buildu
      'scratch/**',
      'mockups/**',
      'public/**',
      'supabase/functions/**', // Deno edge funkce, jiný runtime
      '**/*.config.{js,ts}',
      'vite-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // ── Vysoká hodnota — chytá reálné bugy (přesně to, co jsme řešili ručně) ──
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // ── Ztlumené na warn/off, ať lint dává signál, ne šum (velký starší codebase) ──
      'no-undef': 'off', // TS to hlídá sám (console/process/window…); jinak falešné no-undef
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-case-declarations': 'off',
      'no-useless-escape': 'warn',
      'no-useless-assignment': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn', // codebase používá `cond && fn()` / ternár se side-effectem
      'no-control-regex': 'off',
      'prefer-const': 'warn',
    },
  },
);
