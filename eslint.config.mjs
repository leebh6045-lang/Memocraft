import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';

// 边界同时禁止相对路径穿越和别名绕行；领域类型允许被界面共享。
const restricted = (groups) => [
  'error',
  {
    patterns: groups.map((group) => ({
      group,
      message: '请遵守 docs/项目结构.md 的层间依赖边界。',
    })),
  },
];
export default ts.config(
  { ignores: ['out/**', 'release/**', '.local/**', 'node_modules/**', 'test-results/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: ts.parser, extraFileExtensions: ['.vue'] },
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        crypto: 'readonly',
        HTMLElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        ResizeObserver: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        KeyboardEvent: 'readonly',
        ClipboardEvent: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    files: ['src/**/*.{ts,vue}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': restricted([
        ['node:*', 'electron', '**/main/**', '**/storage/**', '**/services/**'],
      ]),
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted([
        [
          'node:*',
          'electron',
          'vue',
          '**/storage/**',
          '**/services/**',
          '**/main/**',
          '**/renderer/**',
          '**/preload/**',
        ],
      ]),
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted([
        [
          'node:*',
          'electron',
          'vue',
          '**/storage/**',
          '**/services/**',
          '**/main/**',
          '**/renderer/**',
          '**/preload/**',
        ],
      ]),
    },
  },
  {
    files: ['src/storage/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted([
        ['electron', 'vue', '**/renderer/**', '**/main/**', '**/preload/**', '**/services/**'],
      ]),
    },
  },
  {
    files: ['src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted([
        ['electron', 'vue', '**/renderer/**', '**/main/**', '**/preload/**'],
      ]),
    },
  },
  {
    files: ['src/main/**/*.ts'],
    rules: {
      // 主进程负责生命周期、IPC 与装配：可以调用业务与存储，但不能引入界面代码。
      'no-restricted-imports': restricted([['vue', '**/renderer/**', '**/preload/**']]),
    },
  },
  {
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted([
        ['**/storage/**', '**/services/**', '**/main/**', '**/renderer/**'],
      ]),
    },
  },
  prettier,
);
