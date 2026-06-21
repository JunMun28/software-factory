// @ts-check
// This source-shared library (ADR 0017) is linted with its own sf-prefixed
// selector rules layered on top of the repo-root flat config. eslint/config and
// its plugins resolve from the single root node_modules.
const path = require('node:path');
const { defineConfig } = require(
  require.resolve('eslint/config', { paths: [path.join(__dirname, '../..')] }),
);
const rootConfig = require('../../eslint.config.js');

module.exports = defineConfig([
  ...rootConfig,
  {
    files: ['**/*.ts'],
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'sf',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'sf',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    rules: {},
  },
]);
