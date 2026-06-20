// @ts-check
// This source-shared library (ADR 0017) lives outside the web/ workspace, so
// its node_modules (eslint, plugins) resolve from web/. Resolve eslint/config
// from there rather than from this file's own directory.
const path = require('node:path');
const { defineConfig } = require(
  require.resolve('eslint/config', { paths: [path.join(__dirname, '../../web')] }),
);
const rootConfig = require('../../web/eslint.config.js');

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
