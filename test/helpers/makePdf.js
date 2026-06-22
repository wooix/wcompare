// 유효한 멀티페이지 PDF 바이트를 생성한다(xref 오프셋 정확 계산). 외부 의존 없음.
function makePdf(pageCount = 3, { width = 300, height = 900 } = {}) {
  const offsets = {};
  let pdf = '%PDF-1.4\n';
  const addObj = (num, body) => {
    offsets[num] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${num} 0 obj\n${body}\nendobj\n`;
  };
  // 1 Catalog, 2 Pages, 3 Font, 그 다음 페이지/콘텐츠 객체
  let objNum = 4;
  const kids = [];
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const pageNum = objNum++; const contentNum = objNum++;
    kids.push(`${pageNum} 0 R`);
    const stream = `BT /F1 28 Tf 24 ${height - 60} Td (Page ${i + 1}) Tj ET`;
    pages.push({ pageNum, contentNum, stream });
  }
  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObj(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`);
  addObj(3, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  for (const p of pages) {
    addObj(p.pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${p.contentNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    addObj(p.contentNum, `<< /Length ${Buffer.byteLength(p.stream, 'latin1')} >>\nstream\n${p.stream}\nendstream`);
  }
  const maxObj = objNum - 1;
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += String(offsets[n] ?? 0).padStart(10, '0') + ' 00000 n \n';
  pdf += xref + `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
module.exports = { makePdf };
