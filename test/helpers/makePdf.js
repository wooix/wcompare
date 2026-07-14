// 유효한 멀티페이지 PDF 바이트를 생성한다(xref 오프셋 정확 계산). 외부 의존 없음.
// linkTo(1-based)를 주면 1쪽에 "Jump" 텍스트와 그 쪽으로 가는 내부 링크(Link annotation)를 넣는다.
function makePdf(pageCount = 3, { width = 300, height = 900, linkTo = 0 } = {}) {
  const offsets = {};
  let pdf = '%PDF-1.4\n';
  const addObj = (num, body) => {
    offsets[num] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${num} 0 obj\n${body}\nendobj\n`;
  };
  // 1 Catalog, 2 Pages, 3 Font, 그 다음 페이지/콘텐츠 객체, 마지막에 링크 annotation
  let objNum = 4;
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const pageNum = objNum++; const contentNum = objNum++;
    let stream = `BT /F1 28 Tf 24 ${height - 60} Td (Page ${i + 1}) Tj ET`;
    if (i === 0 && linkTo) stream += ` BT /F1 18 Tf 24 ${height - 120} Td (Jump) Tj ET`;
    pages.push({ pageNum, contentNum, stream });
  }
  const annotNum = linkTo ? objNum++ : 0;

  addObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  addObj(2, `<< /Type /Pages /Kids [${pages.map((p) => `${p.pageNum} 0 R`).join(' ')}] /Count ${pageCount} >>`);
  addObj(3, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  pages.forEach((p, i) => {
    const annots = i === 0 && annotNum ? ` /Annots [${annotNum} 0 R]` : '';
    addObj(p.pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${p.contentNum} 0 R /Resources << /Font << /F1 3 0 R >> >>${annots} >>`);
    addObj(p.contentNum, `<< /Length ${Buffer.byteLength(p.stream, 'latin1')} >>\nstream\n${p.stream}\nendstream`);
  });
  if (annotNum) {
    const dest = pages[Math.min(linkTo, pageCount) - 1].pageNum;
    addObj(annotNum, `<< /Type /Annot /Subtype /Link /Rect [24 ${height - 128} 140 ${height - 96}] /Border [0 0 0] /Dest [${dest} 0 R /XYZ 0 ${height} null] >>`);
  }

  const maxObj = objNum - 1;
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += String(offsets[n] ?? 0).padStart(10, '0') + ' 00000 n \n';
  pdf += xref + `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
module.exports = { makePdf };
