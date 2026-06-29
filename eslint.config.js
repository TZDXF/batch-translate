import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// ESLint flat config。lint 仅做静态规则，不做类型感知（无需 project）以保持 CI 轻快。
export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
