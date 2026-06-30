import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * BatchTranslate ESLint flat config。
 * 架构第 1、3 节技术栈：WXT + Preact + Signals + TS，ESM。
 *
 * 设计取向（对齐 issue TRA-14 约束）：从宽松起步、warn 为主，避免一次性引入大量
 * error 阻塞现有 319 个用例对应源码；重点保证可运行、可扩。`lint` 脚本为 `eslint .`，
 * 不带 `--max-warnings`，故 warn 不会让 CI 失败；后续收紧只需把 warn 升 error 或加
 * `--max-warnings 0`。
 */

// recommended 默认全部为 error，这里统一降为 warn（保留 options），实现「宽松起步」。
const toWarn = (rules = {}) =>
  Object.fromEntries(
    Object.entries(rules).map(([key, value]) => {
      if (value === 'error') return [key, 'warn'];
      if (Array.isArray(value) && value[0] === 'error') return [key, ['warn', ...value.slice(1)]];
      return [key, value];
    }),
  );

// 收集所有 extends 配置（含 tseslint 中间的 eslint-recommended 段）的规则统一降为 warn。
// 不能只取 `.at(-1)`：tseslint.configs.recommended[1]（eslint-recommended）也会注入
// `prefer-const` 等 error 规则，漏掉会以 error 形式阻塞 CI。
const collectWarnRules = (...configs) => {
  const merged = {};
  for (const cfg of configs) {
    if (!cfg?.rules) continue;
    Object.assign(merged, toWarn(cfg.rules));
  }
  return merged;
};

const baseRules = collectWarnRules(
  js.configs.recommended,
  ...tseslint.configs.recommended,
);

export default tseslint.config(
  // ─── 全局忽略：构建产物与工具目录 ──────────────────────────────────────────
  {
    ignores: [
      'dist/',
      '.wxt/',
      '.output/',
      'coverage/',
      'playwright-report/',
      'test-results/',
      'node_modules/',
    ],
  },

  // ─── 源码与配置文件 ─────────────────────────────────────────────────────────
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // content script / SW / options / popup 均跑在浏览器扩展环境。
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // recommended 规则统一降为 warn，避免阻塞。
      ...baseRules,
      // 与 tsconfig `verbatimModuleSyntax` 对齐：type-only import 必须用 `import type`。
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      // WXT 自动生成的 .wxt 类型全局可用，no-undef 对扩展全局（chrome 等）误报，TS 已覆盖。
      'no-undef': 'off',
    },
  },

  // ─── 测试文件：允许 describe/it/vi 等全局 ──────────────────────────────────
  {
    files: ['**/*.{test,spec}.{ts,tsx}', 'src/test/**', 'e2e/**'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
);
