// src/main/recentProjects.js — 최근 프로젝트 10개. userData에 원자적으로 기록한다.
// 렌더러에는 경로가 아니라 id만 노출한다 → 렌더러가 임의 경로를 "최근 항목"인 척 열 수 없다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX = 10;

function createRecents(filePath) {
  function list() {
    try {
      const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(items)) return [];
      return items.filter((x) => x && typeof x.id === 'string' && typeof x.path === 'string').slice(0, MAX);
    } catch {
      return []; // 최근 목록이 깨졌다고 앱이 죽으면 안 된다
    }
  }

  function save(items) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`);
    fs.renameSync(tmp, filePath); // 같은 볼륨 → 원자적
    return items;
  }

  function add(p) {
    const abs = path.resolve(p);
    const items = list().filter((x) => x.path !== abs);
    items.unshift({
      id: crypto.randomUUID(),
      path: abs,
      name: path.basename(abs, path.extname(abs)),
      openedAt: new Date().toISOString(),
    });
    return save(items.slice(0, MAX));
  }

  const pathOf = (id) => list().find((x) => x.id === id)?.path || null;
  const remove = (id) => save(list().filter((x) => x.id !== id));
  const clear = () => save([]);

  return { list, add, remove, clear, pathOf, MAX };
}

module.exports = { createRecents, MAX };
