'use strict';
// 探针: 验证酷我 newradio.nr 私人FM 的 offset 分页是否真能翻出不同歌曲。
// 用法: node tests/kw-radio-offset-probe.js
const { handleKwRadio } = require('../kuwo-api');

(async () => {
  const fid = '-26711';
  const pages = [];
  let offset = 0;
  for (let i = 0; i < 4; i++) {
    const r = await handleKwRadio(fid, 15, offset);
    const ids = r.tracks.map(t => t.rid);
    pages.push({ page: i, offset, nextOffset: r.offset, count: ids.length, hasMore: r.hasMore, ids });
    offset = r.offset;
  }
  const all = pages.flatMap(p => p.ids);
  const unique = new Set(all);
  console.log('pages:', pages.map(p => `offset=${p.offset}->${p.nextOffset} count=${p.count}`).join('  |  '));
  console.log('total raw:', all.length, ' unique:', unique.size);
  // 重叠分析: 每页与前一页的重叠
  for (let i = 1; i < pages.length; i++) {
    const prev = new Set(pages[i - 1].ids);
    const overlap = pages[i].ids.filter(id => prev.has(id)).length;
    console.log(`page${i} vs page${i - 1} overlap: ${overlap}/${pages[i].ids.length}`);
  }
})().catch(e => { console.error('PROBE_FAILED', e); process.exit(1); });
