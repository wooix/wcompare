// Page identities survive clipping; even long documents retain distributed coverage.
const READING_VERSION = 2;
function prepareReadingSource(pages, max = 110000) {
  if (!Number.isInteger(max) || max < 256) throw new RangeError('본문 예산은 256자 이상이어야 합니다');
  if (!Array.isArray(pages)) throw new Error('페이지 텍스트가 없습니다');
  const clean = pages.map(p => String(p ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' '));
  if (!clean.some(p => p.trim())) throw new Error('추출할 텍스트가 없습니다. 스캔 PDF는 OCR 처리한 뒤 다시 여세요.');
  const full = clean.map((p, i) => `[PDF p.${i + 1}]\n${p}`).join('\n\n');
  if (full.length <= max) return { text: full, truncated: false };
  // Bound both marker overhead and sample count. Never invent or renumber pages.
  const count = Math.min(clean.length, 400, Math.max(1, Math.floor(max / 100)));
  const indices = Array.from({ length: count }, (_, i) => count === 1 ? 0 : Math.round(i * (clean.length - 1) / (count - 1)));
  const notice = '[자료 일부 생략: 페이지별 발췌이며 누락 부분은 확인할 수 없음]\n';
  const quota = Math.floor((max - notice.length) / count) - 45;
  const chunks = indices.map(i => {
    const p = clean[i];
    const room = Math.max(0, quota);
    const text = p.length <= room ? p : p.slice(0, Math.floor(room * .65)) + '\n[페이지 중간 생략]\n' + p.slice(-Math.max(1, Math.floor(room * .35)));
    return `[PDF p.${i + 1}]\n${text}`;
  });
  return { text: notice + chunks.join('\n\n'), truncated: true };
}
function citationPage(href) {
  const match = /^#paper-page-([1-9]\d{0,5})$/.exec(href || '');
  return match ? Number(match[1]) : null;
}
module.exports = { prepareReadingSource, citationPage, READING_VERSION };
