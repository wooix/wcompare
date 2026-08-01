// test/summaryExport.test.js — 요약 내보내기 순수 로직(main/summaryExport.js).
const { test } = require('node:test');
const assert = require('node:assert');

const {
  KINDS, MAX_EXPORT_CHARS,
  sanitizeFileNamePart, sanitizeExportFileName, defaultExportFileName, stripOuterFence, buildExportMarkdown,
} = require('../src/main/summaryExport.js');

test('buildExportMarkdown: flow는 ```mermaid 펜스로 감싸진다', () => {
  const md = buildExportMarkdown(
    { overview: '', sections: '', flow: 'flowchart TD\n  A["시작"] --> B["끝"]' },
    { scope: 'all' },
  );
  assert.match(md, /```mermaid\nflowchart TD\n {2}A\["시작"\] --> B\["끝"\]\n```/);
  assert.match(md, /## 흐름도/);
});

test('buildExportMarkdown: 이미 펜스로 감싸진 flow는 이중 펜스가 되지 않는다', () => {
  const md = buildExportMarkdown(
    { flow: '```mermaid\nflowchart TD\n  A-->B\n```' },
    {},
  );
  // 바깥쪽 펜스 한 겹만 벗겨지고, 새로 감싼 펜스가 정확히 한 쌍만 있어야 한다.
  const fenceCount = (md.match(/```/g) || []).length;
  assert.equal(fenceCount, 2, '여는/닫는 펜스 한 쌍만 남아야 한다');
  assert.match(md, /```mermaid\nflowchart TD\n {2}A-->B\n```/);
});

test('buildExportMarkdown: 중첩 펜스가 있는 flow는 벗기지 않고 그대로 다시 감싼다', () => {
  const nested = '```mermaid\nflowchart TD\n  A["```code```"] --> B\n```';
  const md = buildExportMarkdown({ flow: nested }, {});
  // stripOuterFence가 안쪽 ``` 을 보고 포기했으므로 원본(자체 펜스 4개)이 손대지 않은 채
  // buildExportMarkdown이 새로 두른 펜스 2개가 더해져 총 6개가 나온다 — "벗기지 않았다"는 뜻.
  const fenceCount = (md.match(/```/g) || []).length;
  assert.equal(fenceCount, 6);
  assert.ok(md.includes(nested), '원본이 그대로(손대지 않고) 포함되어야 한다');
});

test('buildExportMarkdown: scope=current면 지정한 탭 하나만 담는다', () => {
  const parts = { overview: '개요 본문', sections: '## 1장\n절 본문', flow: 'flowchart TD\n  A-->B' };
  const md = buildExportMarkdown(parts, { scope: 'current', tab: 'sections' });
  assert.match(md, /## 절별 요약/);
  assert.match(md, /절 본문/);
  assert.doesNotMatch(md, /## Overview/);
  assert.doesNotMatch(md, /## 흐름도/);
});

test('buildExportMarkdown: scope=current인데 tab이 부적합하면 전체로 물러난다', () => {
  const parts = { overview: '개요 본문', sections: '절 본문', flow: 'flowchart TD\n  A-->B' };
  for (const badTab of [undefined, null, '', 'bogus', 'constructor']) {
    const md = buildExportMarkdown(parts, { scope: 'current', tab: badTab });
    assert.match(md, /## Overview/, `tab=${String(badTab)}`);
    assert.match(md, /## 절별 요약/, `tab=${String(badTab)}`);
    assert.match(md, /## 흐름도/, `tab=${String(badTab)}`);
  }
});

test('buildExportMarkdown: 빈 parts(문자열 없음/공백뿐)는 빈 문자열을 돌려준다', () => {
  assert.equal(buildExportMarkdown({}, {}), '');
  assert.equal(buildExportMarkdown({ overview: '', sections: '   ', flow: null }, {}), '');
  assert.equal(buildExportMarkdown(null, {}), '');
  assert.equal(buildExportMarkdown(undefined, undefined), '');
  assert.equal(buildExportMarkdown([1, 2, 3], {}), '', '배열은 객체로 취급하지 않는다');
});

test('buildExportMarkdown: 제목이 있으면 표제로, 없으면 문서 경로의 파일명으로 대신한다', () => {
  const withTitle = buildExportMarkdown({ overview: 'x' }, { title: '논문 제목', docPath: '/a/b/paper.pdf' });
  assert.match(withTitle, /^# 논문 제목 — 논문 요약/);
  assert.match(withTitle, /_원본: paper\.pdf_/);

  const withoutTitle = buildExportMarkdown({ overview: 'x' }, { docPath: '/a/b/paper.pdf' });
  assert.match(withoutTitle, /^# paper — 논문 요약/);

  const withoutBoth = buildExportMarkdown({ overview: 'x' }, {});
  assert.match(withoutBoth, /^# 요약 — 논문 요약/);
  assert.doesNotMatch(withoutBoth, /_원본:/);
});

test('sanitizeFileNamePart: 경로 구분자·제어문자·선행 점·상위 디렉터리 토큰을 제거한다', () => {
  assert.equal(sanitizeFileNamePart('a/b\\c'), 'abc');
  assert.equal(sanitizeFileNamePart('a:b*c?d"e<f>g|h'), 'abcdefgh');
  assert.equal(sanitizeFileNamePart('a\x00\x1f\x7fb'), 'ab');
  assert.equal(sanitizeFileNamePart('../../etc/passwd'), 'etcpasswd');
  assert.equal(sanitizeFileNamePart('....'), '');
  assert.equal(sanitizeFileNamePart('.....'), '');
  assert.ok(!sanitizeFileNamePart('a..b..c..d').includes('..'));
  assert.equal(sanitizeFileNamePart('.hidden'), 'hidden');
  assert.equal(sanitizeFileNamePart(''), '');
  assert.equal(sanitizeFileNamePart(null), '');
  assert.equal(sanitizeFileNamePart(42), '');
  assert.ok(sanitizeFileNamePart('x'.repeat(200)).length <= 80);
});

test('defaultExportFileName: 원본 PDF 파일명에서 파생하고 scope/tab에 따라 접미사가 붙는다', () => {
  assert.equal(defaultExportFileName('/x/y/My Paper.pdf'), 'My Paper-요약.md');
  assert.equal(
    defaultExportFileName('/x/y/My Paper.pdf', { scope: 'current', tab: 'flow' }),
    'My Paper-요약-흐름도.md',
  );
  assert.equal(
    defaultExportFileName('/x/y/My Paper.pdf', { scope: 'current', tab: 'sections' }),
    'My Paper-요약-절별요약.md',
  );
});

test('defaultExportFileName: docPath가 없거나 위험한 값이어도 안전한 기본 이름으로 물러난다', () => {
  assert.equal(defaultExportFileName(), '요약.md');
  assert.equal(defaultExportFileName(''), '요약.md');
  assert.equal(defaultExportFileName(null), '요약.md');
  // 디렉터리 성분은 path.basename이 이미 떼어내지만, 파일명 자체가 점뿐이어도 안전해야 한다.
  const name = defaultExportFileName('/x/../..pdf');
  assert.ok(!name.includes('/') && !name.includes('..'));
  assert.equal(name, '요약.md');
});

test('stripOuterFence: 여는/닫는 펜스가 정확히 한 쌍일 때만 벗긴다', () => {
  assert.equal(stripOuterFence('```mermaid\nA-->B\n```'), 'A-->B');
  assert.equal(stripOuterFence('```\nA-->B\n```'), 'A-->B');
  assert.equal(stripOuterFence('A-->B'), 'A-->B', '펜스가 없으면 그대로');
  const nested = '```mermaid\nA["```x```"] --> B\n```';
  assert.equal(stripOuterFence(nested), nested, '안쪽에 펜스가 있으면 건드리지 않는다');
});

test('KINDS/MAX_EXPORT_CHARS는 다른 모듈과 어긋나지 않는 형태를 유지한다', () => {
  assert.deepEqual(KINDS, ['overview', 'sections', 'flow']);
  // 파트 하나 20만자 * 3 + 마크다운 오버헤드보다 넉넉히 커야 한다(summaryStore.MAX_PART_CHARS 참고).
  assert.ok(MAX_EXPORT_CHARS > 200000 * 3);
});

// ===== sanitizeExportFileName =====
// 회귀: 예전에는 ipc 핸들러가 완성된 이름에 sanitizeFileNamePart(80자 상한)를 다시 걸어,
// 파일명이 긴 논문에서 '-요약.md'의 확장자까지 잘려 나갔다.
test('sanitizeExportFileName: 긴 이름에서도 .md 확장자를 잃지 않는다', () => {
  const long = defaultExportFileName(`${'가'.repeat(90)}.pdf`);
  const out = sanitizeExportFileName(long);
  assert.ok(out.endsWith('.md'), `확장자가 남아야 한다: ${out}`);
  assert.ok([...out].length <= 84, `이름이 상한 안에 있어야 한다: ${[...out].length}`);
});

test('sanitizeExportFileName: 경로 구분자·상위 토큰·제어문자를 막는다', () => {
  for (const bad of ['../../etc/passwd.md', '/tmp/x.md', 'a\u0000b.md', 'C:\\win\\x.md']) {
    const out = sanitizeExportFileName(bad);
    assert.ok(!out.includes('/') && !out.includes('\\'), `경로 구분자가 남았다: ${out}`);
    assert.ok(!out.includes('..'), `상위 토큰이 남았다: ${out}`);
    assert.ok(!/[\u0000-\u001f]/.test(out), `제어문자가 남았다: ${JSON.stringify(out)}`);
    assert.ok(out.endsWith('.md'), `확장자가 없다: ${out}`);
  }
});

test('sanitizeExportFileName: 비거나 못 쓸 값이면 기본 이름으로 되돌린다', () => {
  for (const v of ['', '   ', '...', null, undefined, 42, {}]) {
    assert.equal(sanitizeExportFileName(v), defaultExportFileName());
  }
});

test('sanitizeFileNamePart: 서로게이트 쌍을 반쪽으로 자르지 않는다', () => {
  // 코드 유닛으로 자르면 마지막에 고아 서로게이트(짝 없는 상위 대리)가 남아 파일명 끝 글자가
  // U+FFFD로 깨진다. 마지막 '글자'를 보는 것으로는 검증되지 않는다 — 정상 쌍의 끝 코드 유닛도
  // 서로게이트 범위에 있기 때문이다. 코드 포인트로 훑어 짝 없는 대리가 하나도 없는지를 봐야 한다.
  const out = sanitizeFileNamePart('🎉'.repeat(60));
  const lone = [...out].some((ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff);
  assert.equal(lone, false, '고아 서로게이트가 남았다');
  assert.equal([...out].length, 60, '멀쩡한 이모지는 상한(80) 안이라 그대로 남아야 한다');
});
