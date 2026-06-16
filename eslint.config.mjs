// eslint.config.mjs — wcompare가 lint에 주입하는 기본 규칙. 사용자 프로젝트와 무관.
export default [
  {
    files: ['**/*.{js,cjs,mjs,jsx,ts,tsx}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'off',
      'eqeqeq': 'warn',
      'no-debugger': 'warn',
    },
  },
];
