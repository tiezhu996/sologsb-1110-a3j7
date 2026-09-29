// 纯逻辑冒烟测试：node test/merge.test.mjs（用 esbuild 把 TS 打出来后运行，db 以内存桩替换）
import { build } from 'esbuild';

const shimCode = `
export const db = {
  boards: { toArray: async () => globalThis.__LOCAL__.boards, put: async () => {}, where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
  chambers: { toArray: async () => globalThis.__LOCAL__.chambers, put: async () => {} },
  lacquers: { toArray: async () => globalThis.__LOCAL__.lacquers, put: async () => {}, where: () => ({ equals: () => ({ toArray: async () => globalThis.__LOCAL__.lacquers.filter(l => l.guqinNo === globalThis.__GQ__) }) }) },
  stringings: { toArray: async () => globalThis.__LOCAL__.stringings, put: async () => {} },
  mergeQueue: new Map(),
};
export const SCHEMA_VERSION = 3;
`;

const dbShimPlugin = {
  name: 'db-shim',
  setup(build) {
    build.onResolve({ filter: /\.\/db$/ }, (args) => ({ path: args.path, namespace: 'db-shim' }));
    build.onLoad({ filter: /.*/, namespace: 'db-shim' }, () => ({ contents: shimCode, loader: 'js' }));
  },
};

const result = await build({
  entryPoints: ['src/utils/merge.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  plugins: [dbShimPlugin],
});
const code = result.outputFiles[0].text;
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const m = await import(dataUrl);

let passed = 0;
function check(name, cond) {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// keyOf：四类业务键
check('板材按板材号', m.keyOf('boards', { boardNo: ' MB-1 ', guqinNo: 'Q-1' }).key === 'MB-1');
check('槽腹按琴号', m.keyOf('chambers', { guqinNo: 'Q-2' }).key === 'Q-2');
check('髹漆按琴号+遍次', m.keyOf('lacquers', { guqinNo: 'Q-3', seq: 2 }).key === 'Q-3#2');
check('上弦按琴号+日期(时分秒归一)', m.keyOf('stringings', { guqinNo: 'Q-4', strungAt: '2026-09-28T15:00:00.000Z' }).key === 'Q-4@2026-09-28');
check('缺板材号→无效', m.keyOf('boards', { guqinNo: 'Q' }).ok === false);
check('髹漆缺遍次→无效', m.keyOf('lacquers', { guqinNo: 'Q' }).ok === false);

// sameContent：忽略 id / totalThickness / 版本 id
check('不同 id 视为同内容', m.sameContent('boards', { id: 'a', boardNo: 'B1' }, { id: 'b', boardNo: 'B1' }));
check('字段不同即冲突', !m.sameContent('boards', { id: 'a', boardNo: 'B1', thicknessMm: 30 }, { id: 'b', boardNo: 'B1', thicknessMm: 31 }));
check('髹漆忽略 totalThickness', m.sameContent('lacquers', { id: 'a', guqinNo: 'Q', seq: 1, layerThickness: 0.1, totalThickness: 0.1 }, { id: 'b', guqinNo: 'Q', seq: 1, layerThickness: 0.1, totalThickness: 0.9 }));
check('髹漆本遍厚度不同→冲突', !m.sameContent('lacquers', { guqinNo: 'Q', seq: 1, layerThickness: 0.1 }, { guqinNo: 'Q', seq: 1, layerThickness: 0.2 }));
check('上弦忽略评语版本id', m.sameContent('stringings', { guqinNo: 'Q', strungAt: '2026-09-01', noteVersions: [{ id: 'x', sanNote: 'a' }] }, { guqinNo: 'Q', strungAt: '2026-09-01', noteVersions: [{ id: 'y', sanNote: 'a' }] }));
check('上弦评语版本内容不同→冲突', !m.sameContent('stringings', { guqinNo: 'Q', strungAt: '2026-09-01', noteVersions: [{ id: 'x', sanNote: 'a' }] }, { guqinNo: 'Q', strungAt: '2026-09-01', noteVersions: [{ id: 'y', sanNote: 'b' }] }));

// previewBackup：新增/一致/冲突 + 备份内重复键 + 缺键
const localIndex = {
  boards: new Map([['B1', { id: 'local-1', boardNo: 'B1', guqinNo: 'Q1', thicknessMm: 30 }]]),
  chambers: new Map([['Q1', { id: 'c1', guqinNo: 'Q1', chamberDepth: 25 }]]),
  lacquers: new Map([['Q1#1', { id: 'l1', guqinNo: 'Q1', seq: 1, layerThickness: 0.1 }]]),
  stringings: new Map([['Q1@2026-01-01', { id: 's1', guqinNo: 'Q1', strungAt: '2026-01-01T08:00:00Z', sanNote: '旧评语' }]]),
};
const payload = {
  app: 'gbguqin',
  schemaVersion: 3,
  exportedAt: '2026-09-28T00:00:00Z',
  boards: [
    { id: 'xa', boardNo: 'B1', guqinNo: 'Q1', thicknessMm: 30 }, // identical
    { id: 'xb', boardNo: 'B2', guqinNo: 'Q2', thicknessMm: 28 }, // add
    { id: 'xc', boardNo: 'B2', guqinNo: 'Q2', thickness: 1 }, // 重复键 invalid
    { id: 'xd', guqinNo: 'Q9' }, // 缺键 invalid
  ],
  chambers: [{ id: 'xc1', guqinNo: 'Q1', chamberDepth: 28 }], // conflict
  lacquers: [
    { id: 'xl1', guqinNo: 'Q1', seq: 1, layerThickness: 0.1, totalThickness: 9 }, // identical（忽略派生值）
    { id: 'xl2', guqinNo: 'Q1', seq: 2, layerThickness: 0.1 }, // add
  ],
  stringings: [
    { id: 'xs1', guqinNo: 'Q1', strungAt: '2026-01-01T20:00:00+08:00', sanNote: '旧评语' }, // 同日不同时刻 identical
    { id: 'xs2', guqinNo: 'Q1', strungAt: '2026-01-02', sanNote: '新一天' }, // add
  ],
};
const preview = m.previewBackup(payload, 'other.json', localIndex);
const byRow = Object.fromEntries(preview.entries.map((e) => [`${e.table}:${e.keyLabel}`, e]));
check('预览：板材新增', preview.entries.some((e) => e.table === 'boards' && e.keyLabel.includes('B2') && e.status === 'add'));
check('预览：板材一致', byRow['boards:板材号 B1'].status === 'identical');
check('预览：槽腹冲突', byRow['chambers:琴号 Q1'].status === 'conflict');
check('预览：髹漆一致忽略派生厚度', byRow['lacquers:琴号 Q1 · 第 1 遍'].status === 'identical');
check('预览：髹漆新增', preview.entries.some((e) => e.table === 'lacquers' && e.status === 'add' && e.keyParts.seq === 2));
check('预览：上弦按日期归一一致', byRow['stringings:琴号 Q1 · 上弦 2026-01-01'].status === 'identical');
check('预览：上弦不同日期新增', preview.entries.some((e) => e.table === 'stringings' && e.status === 'add' && e.keyParts.strungDay === '2026-01-02'));
check('预览：重复键跳过', preview.entries.filter((e) => e.status === 'invalid').length === 2);

// diffFields：只列出真正不同的字段
const diffs = m.diffFields('boards', localIndex.boards.get('B1'), { id: 'xa', boardNo: 'B1', guqinNo: 'Q1', thicknessMm: 31, remark: '新备注' });
check('diffFields 命中两个字段', diffs.length === 2 && diffs.some((f) => f.key === 'thicknessMm') && diffs.some((f) => f.key === 'remark'));
const chamberDiffs = m.diffFields('chambers', localIndex.chambers.get('Q1'), { id: 'xc1', guqinNo: 'Q1', chamberDepth: 28 });
check('diffFields 槽腹深度', chamberDiffs.length === 1 && chamberDiffs[0].key === 'chamberDepth');

console.log(`\n${passed} checks passed`);
