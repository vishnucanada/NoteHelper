import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        ignores: ['legacy/**', 'chroma_db/**', 'coverage/**', 'node_modules/**'],
    },
    {
        // Browser app code (vanilla IIFE modules sharing a window.NH namespace).
        files: ['lib/**/*.js', 'script.js', 'config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                // Globals the app reads/creates across files.
                NH: 'writable',
                pdfjsLib: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        // Test files run under Vitest in Node.
        files: ['test/**/*.{js,mjs}'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
                describe: 'readonly',
                it: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                vi: 'readonly',
            },
        },
    },
];
