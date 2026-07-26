// src/renderer/mermaidLoader.js — 흐름도 탭이 처음 열릴 때만 mermaid를 끌어오는 지연 로더.
//
// 번들에 섞지 않는 이유: mermaid는 앱의 나머지 전부를 합친 것보다 큰 의존성이라, app.js에 넣으면
// 흐름도를 한 번도 보지 않는 사용자까지 시작 비용을 치른다. 빌드가 dist/renderer/mermaid.min.js로
// 복사해 두고 여기서 script 태그로 끌어온다 — CSP가 script-src 'self'라 같은 오리진의
// 상대경로여야만 통과한다(CDN은 애초에 막힌다).
//
// mermaid.min.js는 로드 끝에 globalThis.mermaid를 직접 대입한다 → 별도 모듈 해석이 필요 없다.

let pending = null; // 로드 Promise를 모듈에 붙들어 둔다 → 두 번째 호출부터 재사용(script 중복 주입 방지)
let seq = 0; // render id 충돌 방지용 일련번호

function inject() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = './mermaid.min.js';
    s.async = true;
    s.addEventListener('load', () => {
      if (window.mermaid) resolve(window.mermaid);
      else reject(new Error('mermaid를 불러왔지만 초기화되지 않았습니다'));
    });
    s.addEventListener('error', () =>
      reject(new Error('mermaid를 불러오지 못했습니다 (dist/renderer/mermaid.min.js 확인)')));
    document.head.appendChild(s);
  });
}

// 실패한 Promise도 그대로 캐시한다 — 여기서의 실패는 "번들에 파일이 빠졌다"는 배포 문제라
// 다시 시도해도 결과가 달라지지 않는다. 재시도 루프로 script를 계속 꽂는 것보다 낫다.
export function loadMermaid() {
  if (!pending) {
    pending = inject().then((mermaid) => {
      mermaid.initialize({
        startOnLoad: false, // 우리가 원하는 시점에만 그린다(숨겨진 탭에서 자동 렌더되면 폭이 0으로 잡힌다)
        // securityLevel은 반드시 'strict' — 'sandbox'는 결과를 iframe에 담는데
        // 이 앱 CSP에는 frame-src가 없어 그 iframe이 통째로 막힌다.
        // 'strict'는 DOMPurify로 출력을 정화하므로 LLM이 만든 코드에도 안전하다.
        securityLevel: 'strict',
        theme: 'dark',
      });
      return mermaid;
    });
  }
  return pending;
}

// 파싱 오류는 그대로 던진다 — 호출측이 사용자에게 원본 코드와 함께 보여준다.
export async function renderMermaid(code, id) {
  const mermaid = await loadMermaid();
  const rid = id || `mmd-${++seq}`;
  try {
    const { svg } = await mermaid.render(rid, code);
    return svg;
  } finally {
    // mermaid는 글자 폭을 재려고 #d<id> 임시 노드를 body에 붙이는데, 파싱이 깨지면 그대로 남는다.
    // 남은 노드는 같은 id로 다시 그릴 때 서로 방해하므로 성공·실패 모두 확실히 치운다.
    document.getElementById(`d${rid}`)?.remove();
  }
}
