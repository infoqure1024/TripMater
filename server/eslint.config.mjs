import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const sharedLanguageOptions = {
  parser: tsParser,
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: './tsconfig.eslint.json',
  },
};

const sharedRules = {
  ...tsPlugin.configs['recommended'].rules,
  ...tsPlugin.configs['recommended-type-checked'].rules,
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  '@typescript-eslint/explicit-function-return-type': 'off',
  // Fastify plugin/route registration functions must be async by convention
  // even when they contain no top-level await expressions.
  '@typescript-eslint/require-await': 'off',
};

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'scripts/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ...sharedLanguageOptions,
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...sharedRules,
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['__tests__/**/*.ts'],
    languageOptions: {
      ...sharedLanguageOptions,
      globals: {
        console: 'readonly',
        process: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...sharedRules,
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
