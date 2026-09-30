'use strict';

// 酷我(KW)音源接入的回归测试。
// 这些断言覆盖的是"重新移植上游版本时容易被漏掉"的接线点:
// 只要某个 provider 枚举里少了 kw, 酷我歌单/歌曲就会退化成网易云,
// 表现为歌单归到"网易云歌单"分组、详情页显示"歌单暂无可播放歌曲"。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const moduleFile = file => 'public/js/modules/' + file;

function loadFunctions(context, file, names) {
  const source = read(moduleFile(file));
  for (const name of names) {
    const declaration = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
    assert.ok(declaration, `${file} 缺少 ${name}()`);
    const end = source.indexOf('\n}', declaration.index);
    assert.ok(end > declaration.index, `${file} 的 ${name}() 未闭合`);
    vm.runInContext(source.slice(declaration.index, end + 2), context, { filename: file });
  }
}

function loadVar(context, file, name) {
  const source = read(moduleFile(file));
  const pattern = name === 'MUSIC_SEARCH_PROVIDER_ORDER' || name === 'SEARCH_HISTORY_MODES'
    ? new RegExp(`var ${name} = \\[[^\\]]*\\];`)
    : new RegExp(`var ${name} = [^;]+;`);
  const match = pattern.exec(source);
  assert.ok(match, `${file} 缺少 ${name}`);
  vm.runInContext(match[0], context);
}

test('酷我歌单归属与详情接口不再退化成网易云', () => {
  const context = vm.createContext({});
  const file = '06-lyrics/02-playlist-detail.js';
  loadFunctions(context, file, [
    'normalizePlaylistProvider', 'playlistProviderLabel', 'playlistProviderName',
    'playlistPanelProviderId', 'playlistTracksEndpoint',
  ]);
  assert.equal(context.normalizePlaylistProvider('kw'), 'kw');
  assert.equal(context.normalizePlaylistProvider('kuwo'), 'kw');
  assert.equal(context.normalizePlaylistProvider('mineradio'), 'mineradio');
  assert.equal(context.normalizePlaylistProvider('netease'), 'netease');
  assert.equal(context.playlistProviderLabel('kw'), 'KW');
  assert.equal(context.playlistProviderName('kw'), '酷我音乐');
  assert.equal(context.playlistPanelProviderId('kw', '88'), 'kw:88');
  assert.equal(
    context.playlistTracksEndpoint('kw', '88', { offset: 50, limit: 50 }),
    '/api/kw/playlist/tracks?id=88&offset=50&limit=50'
  );
  // 分组标签/顺序/分组表都必须保留 kw, 否则歌单会被塞进"网易云歌单"
  const source = read(moduleFile(file));
  assert.match(source, /kw: '酷我音乐歌单'/);
  assert.match(source, /var order = \[[^\]]*'kw'/);
  assert.match(source, /var groups = \{[^}]*kw: \[\]/);
});

test('酷我歌单进入队列时保留 provider 与 id', () => {
  const context = vm.createContext({});
  loadFunctions(context, '06-lyrics/03-podcast-playlist-loaders.js', ['playlistQueueSource']);
  loadFunctions(context, '06-lyrics/02-playlist-detail.js', ['normalizePlaylistProvider', 'playlistTracksEndpoint']);
  loadFunctions(context, '06-lyrics/03-podcast-playlist-loaders.js', ['playlistQueuePageUrl']);
  const kw = context.playlistQueueSource('kw:88');
  assert.deepEqual({ provider: kw.provider, id: kw.id, requestId: kw.requestId }, { provider: 'kw', id: '88', requestId: 'kw:88' });
  assert.equal(context.playlistQueueSource('mineradio:99').provider, 'mineradio');
  assert.equal(context.playlistQueuePageUrl(kw, 96, 96), '/api/kw/playlist/tracks?id=88&offset=96&limit=96');
});

test('酷我搜索是公开目录音源且走独立分页接口', () => {
  const context = vm.createContext({ platformStatus: () => ({ loggedIn: false }) });
  const file = '05-playback/07-search.js';
  loadVar(context, file, 'MUSIC_SEARCH_PROVIDER_ORDER');
  loadVar(context, file, 'SEARCH_HISTORY_MODES');
  loadFunctions(context, file, [
    'searchProviderStatus', 'searchProviderCanSearch', 'searchModeProvider',
    'activeSearchProvidersForMode', 'searchProviderUrl', 'songProviderKey', 'controlSourceProviders',
  ]);
  assert.ok(context.MUSIC_SEARCH_PROVIDER_ORDER.includes('kw'));
  assert.ok(context.SEARCH_HISTORY_MODES.includes('kw'));
  assert.equal(context.searchProviderCanSearch('kw'), true);
  assert.equal(context.searchModeProvider('kw'), 'kw');
  assert.deepEqual(Array.from(context.activeSearchProvidersForMode('kw')), ['kw']);
  assert.ok(context.activeSearchProvidersForMode('song').includes('kw'));
  assert.ok(!context.activeSearchProvidersForMode('song').includes('spotify'));
  assert.equal(context.songProviderKey({ provider: 'kw', rid: '12345' }), 'kw');
  assert.equal(context.songProviderKey({ rid: '12345' }), 'kw');
  assert.ok(context.controlSourceProviders().some(item => item.key === 'kw'));
  const url = new URL(context.searchProviderUrl('kw', '测试 & 歌曲', 30, 60), 'http://localhost');
  assert.equal(url.pathname, '/api/kw/search');
  assert.equal(url.searchParams.get('keywords'), '测试 & 歌曲');
  assert.equal(url.searchParams.get('offset'), '60');
});

test('酷我播放取链保留音质、RID、至臻解密与暂停续播', async () => {
  const calls = [];
  const context = vm.createContext({
    songProviderKey: song => song.provider || song.source || song.type,
    getProviderPlaybackQuality: () => 'lossless',
    playbackQualityCapValue: () => '',
    playbackQualityCapBlocksTier: () => false,
    playbackQualityAboveCap: () => false,
    normalizePlaybackQualityForProvider: value => value || 'lossless',
    hasProviderSvip: () => false,
    loginStatus: {},
    apiJson: async (url, options) => { calls.push({ url, options }); return { url: 'https://example.com/audio.flac' }; },
  });
  const qualityFile = '05-playback/00-api-quality-output.js';
  loadFunctions(context, qualityFile, ['normalizePlaybackProvider', 'playbackQualityLabel']);
  loadFunctions(context, '05-playback/13-playback-start-audio.js', ['resolveAlbumGaplessPlaybackData']);
  loadFunctions(context, '05-playback/14-player-controls.js', ['canRefreshCurrentPlaybackUrlForResume']);
  assert.equal(context.normalizePlaybackProvider('kw'), 'kw');
  assert.equal(context.normalizePlaybackProvider('kuwo'), 'kw');
  assert.equal(context.playbackQualityLabel('jymaster', 'kw'), '酷我至臻');
  assert.equal(context.canRefreshCurrentPlaybackUrlForResume({ provider: 'kw', type: 'kw', rid: '12345' }), true);
  await context.resolveAlbumGaplessPlaybackData({ provider: 'kw', type: 'kw', rid: '12345' });
  assert.equal(calls[0].url, '/api/kw/song/url?rid=12345&quality=lossless');
  assert.equal(calls[0].options.timeoutMs, 9000);
  // 至臻 mflac 需要把 ekey 交给 /api/audio 做 QMCv2 边下边解
  const playback = read(moduleFile('05-playback/13-playback-start-audio.js'));
  assert.ok((playback.match(/kwekey/g) || []).length >= 2, '酷我至臻 QMC 解密参数必须同时覆盖常规播放与无缝预载');
});

test('酷我歌曲在内置歌单中保留音源标识与元数据', async (t) => {
  const { BuiltInPlaylistLibrary } = require('../desktop/built-in-playlist-library');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mineradio-built-in-kw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const library = new BuiltInPlaylistLibrary({ userDataPath: dir });
  const { playlist } = await library.create('酷我混合歌单');
  await library.addTrack(playlist.id, { provider: 'netease', id: '12345', name: '网易云歌曲' });
  await library.addTrack(playlist.id, {
    provider: 'kw', source: 'kw', type: 'kw', id: '12345', rid: '12345',
    name: '酷我歌曲', artist: '歌手', albumId: '88', duration: 180000,
    formats: 'MP3H|ALFLAC', hasFlac: true,
  });
  const duplicate = await library.addTrack(playlist.id, { source: 'kw', rid: '12345', name: '相同 RID' });
  assert.equal(duplicate.duplicate, true);
  await library.addTrack(playlist.id, { type: 'kw', rid: '67890', name: '仅有 RID' });
  await library.addTrack(playlist.id, { provider: 'kuwo', id: '24680', name: '兼容音源名称' });
  await assert.rejects(
    () => library.addTrack(playlist.id, { provider: 'kw', name: '缺少标识' }),
    /BUILT_IN_PLAYLIST_TRACK_INVALID/
  );

  const restored = new BuiltInPlaylistLibrary({ userDataPath: dir });
  const page = restored.page(playlist.id);
  assert.equal(page.total, 4);
  assert.deepEqual(page.tracks.map(track => track.provider), ['netease', 'kw', 'kw', 'kw']);
  assert.deepEqual(page.tracks.map(track => track.builtInIdentity), ['netease:12345', 'kw:12345', 'kw:67890', 'kw:24680']);
  assert.equal(page.tracks[1].source, 'kw');
  assert.equal(page.tracks[1].type, 'kw');
  assert.equal(page.tracks[1].rid, '12345');
  assert.equal(page.tracks[1].formats, 'MP3H|ALFLAC');
  assert.equal(page.tracks[1].hasFlac, true);
  assert.equal(page.tracks[1].albumId, '88');
});

test('刷新内置歌单不会丢掉酷我歌单目录', () => {
  const context = vm.createContext({
    builtInPlaylists: [], neteasePlaylists: [], qqPlaylists: [], kugouPlaylists: [],
    kwPlaylists: [{ provider: 'kw', id: '88' }], qishuiPlaylists: [], spotifyPlaylists: [],
    userPlaylists: [], playlistCatalogRevision: 0,
  });
  loadFunctions(context, '06-lyrics/00-built-in-playlists.js', ['normalizeBuiltInPlaylistRows', 'applyBuiltInPlaylistSnapshot']);
  assert.equal(context.applyBuiltInPlaylistSnapshot({ ok: true, playlists: [{ id: '99' }] }), true);
  assert.deepEqual(Array.from(context.userPlaylists, row => row.provider), ['mineradio', 'kw']);
  assert.match(read(moduleFile('06-lyrics/01-playlist-panel-shell.js')), /builtInPlaylists\.concat\([^)]*kwPlaylists/);
});

test('歌单架、封面键、队列快照、首页推荐与音质重载都认识酷我', () => {
  const shelf = read(moduleFile('04-shelf/01-manager-core.js'));
  assert.match(shelf, /pl\.provider === 'kw' \|\| pl\.provider === 'kuwo' \? 'kw'/);
  assert.match(shelf, /provider === 'kw' \? 'kw:'/);
  const shelfContent = read(moduleFile('04-shelf/03-content-list-manager.js'));
  assert.match(shelfContent, /kwPlaylistId/);
  assert.match(shelfContent, /\/api\/kw\/playlist\/tracks/);
  assert.match(read(moduleFile('05-playback/01-cover-custom-map.js')), /'kw:' \+ \(song\.rid/);
  const snapshot = read(moduleFile('05-playback/09-queue-snapshot-autoplay.js'));
  assert.match(snapshot, /'kw:' \+ \(song\.rid/);
  assert.match(snapshot, /'resHash', 'rid'/);
  const home = read(moduleFile('05-playback/03a-home-dashboard.js'));
  assert.match(home, /kuwoLoginStatus\.loggedIn \? 'kw'/);
  assert.match(home, /\^\(netease\|qishui\|qq\|kugou\|kw\)\$\//);
  assert.match(read(moduleFile('05-playback/00-api-quality-output.js')), /songProviderKey\(song\) === 'kw'/);
  assert.match(read(moduleFile('05-playback/06-track-detail-lyrics-actions.js')), /provider === 'kw'\) return kuwoLoginStatus/);
  assert.match(read(moduleFile('08-account/04-user-modal-logout.js')), /provider === 'kw' \|\| provider === 'kuwo' \? 'kw'/);
});

test('酷我入口、凭据存储与打包清单保持完整', () => {
  const html = read('public/index.html');
  for (const id of ['search-mode-kw', 'login-provider-kw', 'user-provider-kw', 'kw-login-panel', 'account-add-kw']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 ${id}`);
  }
  assert.ok(html.includes('data-home-recommend-source="kw"'));
  assert.match(read('desktop/main.js'), /process\.env\.KW_ACCOUNT_FILE = path\.join\(STABLE_USER_DATA_PATH, '\.kw-account'\)/);
  assert.match(read('server.js'), /\/api\/kw\/song\/url/);
  assert.match(read('server.js'), /\/api\/kw\/playlist\/tracks/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '2.2.0');
  assert.ok(pkg.build.files.includes('kuwo_qmc.js'), '酷我 QMC 解密器必须随包发布');
  assert.ok(pkg.build.files.includes('*-api.js'));
  for (const file of ['kuwo-api.js', 'kuwo_qmc.js']) {
    assert.ok(fs.existsSync(path.join(root, file)), `缺少 ${file}`);
  }
});
