// 端到端冒烟：fake-indexeddb + 真实 Dexie，跑预览→决议→提交→重算→二次导出携带冲突
// 运行：node test/merge.e2e.mjs（需可解析 fake-indexeddb，如 NODE_PATH 指向其安装目录）
import { build } from 'esbuild';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// 通过 createRequire 定位 fake-indexeddb（ESM 下 NODE_PATH 不生效）
const require = createRequire(import.meta.url);
const fakeEntry = require.resolve('fake-indexeddb');
const { IDBFactory, IDBKeyRange } = await import(pathToFileURL(fakeEntry).href);

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;

// 单个 bundle 同时拿到 merge 工具与同一个 db 实例（stdin 入口 + resolveDir，不落临时源文件）
const result = await build({
  stdin: {
    contents: `
export * from './src/utils/merge';
export { db } from './src/utils/db';
`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const bundlePath = join(tmpdir(), `gbguqin-merge-e2e-${process.pid}.mjs`);
writeFileSync(bundlePath, result.outputFiles[0].text);
try {
  const m = await import(pathToFileURL(bundlePath).href);
  await run(m, m.db);
} finally {
  rmSync(bundlePath, { force: true });
}

async function run(m, db) {
let passed = 0;
function check(name, cond) {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`  ok - ${name}`);
}

// 本机：1 板材（同键将冲突）、1 槽腹（将冲突）、髹漆 1 遍（导入新增第 2 遍）、上弦 1 条（一致）
await db.boards.put({ id: 'b-local', boardNo: 'MB-1', guqinNo: 'Q1', part: '面板', species: '桐木', dryYears: 8, thicknessMm: 30, grain: '直纹', defect: '无', receivedAt: '2026-01-01T09:00:00' });
await db.chambers.put({ id: 'c-local', guqinNo: 'Q1', nayinThickness: 16, longchiThickness: 14, fengzhaoThickness: 15, chamberDepth: 26, postPos: '天柱中', poolSize: '200×22', carvedAt: '2026-02-01', carver: '周' });
await db.lacquers.put({ id: 'l-local', guqinNo: 'Q1', seq: 1, mixRatio: '1:1', curingTemp: 24, curingHumidity: 78, polishGrit: 240, layerThickness: 0.1, totalThickness: 0.1, appliedAt: '2026-03-01', operator: '林' });
await db.stringings.put({ id: 's-local', guqinNo: 'Q1', stringType: '丝弦', nut: '红木', stringGap: 17, sanNote: '同', anNote: '同', fanNote: '同', nineVirtues: '', defects: ['无'], strungAt: '2026-04-01T09:00:00', operator: '周', noteVersions: [] });

const payload = {
  app: 'gbguqin',
  schemaVersion: 3,
  exportedAt: '2026-09-01T00:00:00Z',
  boards: [
    { id: 'b-other', boardNo: 'MB-1', guqinNo: 'Q1', part: '面板', species: '桐木', dryYears: 8, thicknessMm: 33, grain: '直纹', defect: '无', receivedAt: '2026-01-01T10:00:00' }, // 冲突
    { id: 'b-new', boardNo: 'MB-2', guqinNo: 'Q2', part: '底板', species: '梓木', dryYears: 6, thicknessMm: 18, grain: '直纹', defect: '无', receivedAt: '2026-05-01' }, // 新增
  ],
  chambers: [{ id: 'c-other', guqinNo: 'Q1', nayinThickness: 16, longchiThickness: 14, fengzhaoThickness: 15, chamberDepth: 30, postPos: '天柱中', poolSize: '200×22', carvedAt: '2026-02-02', carver: '林' }], // 冲突
  lacquers: [{ id: 'l-other-2', guqinNo: 'Q1', seq: 2, mixRatio: '1:1.2', curingTemp: 26, curingHumidity: 82, polishGrit: 400, layerThickness: 0.2, totalThickness: 0, appliedAt: '2026-03-10', operator: '林' }], // 新增
  stringings: [{ id: 's-other', guqinNo: 'Q1', stringType: '丝弦', nut: '红木', stringGap: 17, sanNote: '同', anNote: '同', fanNote: '同', nineVirtues: '', defects: ['无'], strungAt: '2026-04-01T18:00:00', operator: '周', noteVersions: [] }], // 同日一致
};

// 预览阶段：本机表未被改动
const localIndex = await m.loadLocalIndex();
const preview = m.previewBackup(payload, 'other.json', localIndex);
const statusOf = (t, label) => preview.entries.find((e) => e.table === t && e.keyLabel === label)?.status;
check('预览前本机板材厚度仍是30', (await db.boards.get('b-local')).thicknessMm === 30);
check('板材同键冲突', statusOf('boards', '板材号 MB-1') === 'conflict');
check('板材新增', statusOf('boards', '板材号 MB-2') === 'add');
check('槽腹冲突', statusOf('chambers', '琴号 Q1') === 'conflict');
check('髹漆新增', preview.entries.some((e) => e.table === 'lacquers' && e.status === 'add'));
check('上弦同日同时刻不同判一致', preview.entries.every((e) => e.table !== 'stringings' || e.status === 'identical'));

await m.upsertConflicts(preview.entries);
check('两条冲突入队', (await db.mergeQueue.count()) === 2);

// 逐条决定：板材保留本机；槽腹采用导入（先只决板材，槽腹留 pending）
await m.setConflictResolution('boards:MB-1', 'local');

const r1 = await m.commitMerge(preview.entries);
check('提交1：新增 2（板材MB-2 + 髹漆第2遍）', r1.added === 2);
check('提交1：保留本机 1', r1.keptLocal === 1);
check('提交1：剩 1 条冲突未处理', r1.conflictLeft === 1);
check('本机板材未被覆盖（30）', (await db.boards.get('b-local')).thicknessMm === 30);
check('新板材写入且重映射 id（不用对端id）', !!(await db.boards.where('boardNo').equals('MB-2').first()) && !(await db.boards.get('b-new')));
check('槽腹仍是本机 26（未决议不覆盖）', (await db.chambers.get('c-local')).chamberDepth === 26);
const layers = await db.lacquers.where('guqinNo').equals('Q1').toArray();
check('髹漆累计厚度重算为 0.3', layers.every((l) => Math.abs(l.totalThickness - (l.seq === 1 ? 0.1 : 0.3)) < 1e-9));
check('队列里只剩槽腹冲突', (await db.mergeQueue.count()) === 1 && (await db.mergeQueue.toArray())[0].id === 'chambers:Q1');

// 第二次打开：备份里携带同一条未处理冲突，幂等合并不产生重复
await m.mergeIncomingPending({ pendingConflicts: [{ id: 'chambers:Q1', table: 'chambers', mergeKey: 'Q1', keyLabel: '琴号 Q1', keyParts: { guqinNo: 'Q1' }, local: {}, incoming: payload.chambers[0], resolution: 'pending' }] });
check('外来队列项同键幂等', (await db.mergeQueue.count()) === 1);

// 档案员下次继续：采用导入
await m.setConflictResolution('chambers:Q1', 'imported');
const r2 = await m.commitMerge([]);
check('提交2：覆盖 1 条', r2.updated === 1 && r2.conflictLeft === 0);
const chamber = await db.chambers.get('c-local');
check('槽腹沿用本机 id 但内容已覆盖（30、carver 林）', chamber.chamberDepth === 30 && chamber.carver === '林');
check('队列清空', (await db.mergeQueue.count()) === 0);

console.log(`\n${passed} checks passed`);
}
