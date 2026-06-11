// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

module.exports = defineConfig([
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      // repo uses prefixes sf/sub and bare names — design system predates this gate
      '@angular-eslint/directive-selector': 'off',
      '@angular-eslint/component-selector': 'off',
      // TODO(lint-debt): enable after typing pass — all current `any` uses are HTTP response shapes
      '@typescript-eslint/no-explicit-any': 'off',
      // allow _-prefixed intentionally-unused variables (standard TS convention)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {
      // TODO(lint-debt): enable after a11y pass — all interactive divs need roles + keyboard handlers
      '@angular-eslint/template/click-events-have-key-events': 'off',
      // TODO(lint-debt): enable after a11y pass — interactive elements need focusable attribute
      '@angular-eslint/template/interactive-supports-focus': 'off',
      // TODO(lint-debt): enable after a11y pass — label elements need associated form controls
      '@angular-eslint/template/label-has-associated-control': 'off',
      // TODO(lint-debt): login.ts uses autofocus deliberately (focus-on-load UX, consistent with Autofocus directive); restore after a11y pass
      '@angular-eslint/template/no-autofocus': 'off',
    },
  },
]);
