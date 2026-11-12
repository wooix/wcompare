// Normalize supported arXiv links without losing an explicitly requested version.
function arxivPdfUrl(value) {
  const input = String(value || '').trim();
  let id = input;
  if (/^https?:/i.test(input)) {
    const url = new URL(input);
    if (!['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'].includes(url.hostname) || url.port || url.username || url.password) {
      throw new Error('arxiv.org의 논문 주소를 입력하세요.');
    }
    const match = url.pathname.match(/^\/(?:abs|pdf|html)\/(.+?)\/?$/);
    if (!match) throw new Error('arXiv의 abs, pdf 또는 html 논문 주소가 필요합니다.');
    id = match[1];
  }
  id = id.replace(/\.pdf$/i, '');
  if (!/^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*(?:\.[A-Z]{2})?\/\d{7})(?:v[1-9]\d*)?$/.test(id)) {
    throw new Error('올바른 arXiv 논문 ID가 아닙니다.');
  }
  return `https://arxiv.org/pdf/${id}`;
}
module.exports = { arxivPdfUrl };
