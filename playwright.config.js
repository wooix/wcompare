// playwright.config.js
const { defineConfig } = require('@playwright/test');

// e2e는 실제 Electron 창을 띄운다. 그대로 두면 테스트를 돌릴 때마다 창 수십 개가 사용자 화면 위로
// 튀어나와 다른 작업을 방해한다. main.js가 이 변수를 보고 창을 show:false로 만든다 —
// 숨긴 창도 레이아웃·렌더는 그대로라 크기 측정과 스크린샷 결과가 보이는 창과 동일하다(실측 확인).
// 여기서 process.env에 심어 두면 spec들이 env를 넘기든(대개 { ...process.env, ... }) 안 넘기든
// 자식 Electron이 그대로 물려받는다.
// 창을 눈으로 보며 디버깅하려면: WCOMPARE_SHOW_WINDOW=1 npx playwright test <spec>
if (!process.env.WCOMPARE_SHOW_WINDOW) process.env.WCOMPARE_HIDE_WINDOW = '1';

module.exports = defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
});
