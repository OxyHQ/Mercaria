/**
 * ESLint for @mercaria/contracts — the house rule set, plus the two rules that
 * matter for modules that ship inside `@mercaria.co/sdk` to every runtime: no
 * Node built-ins and no `console` in `src/`, and no `any` (a schema is the
 * wall between an untrusted body and a typed value).
 */
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', parser: tsparser },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-undef': 'off', // TypeScript handles this
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'src/ ships inside the SDK to browsers and React Native.' }] },
      ],
    },
  },
];
