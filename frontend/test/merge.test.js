import assert from 'node:assert/strict';
import { db, __fake } from './fake-db.js';
import {
  analyzeMerge,
  commitMerge,
  loadLocalByTable,
  businessKey,
  recordsEqual,
  MERGE_TABLES,
} from '../src/utils/merge.ts';

let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const source = '对方备份.json';

function board(over = {}) {
  return {
    id: 'b-local',
    boardNo: 'MB-1',
    guqinNo: 'Q-1',
    part: '面板',
    species: '桐木',
    dryYears: 8,
    thicknessMm: 32,
    grain: '直纹',
    defect: '无',
    receivedAt: day(10),
    ...over,
  };
}
function chamber(over = {}) {
  return {
    id: 'c-local',
    guqinNo: 'Q-1',
    nayinThickness: 16,
    longchiThickness: 14,
    fengzhaoThickness: 15,
    chamberDepth: 26,
    postPos: '天柱中',
    poolSize: '200×22',
    carvedAt: day(5),
    carver: '周砚秋',
    ...over,
  };
}
function layer(over = {}) {
  return {
    id: 'l-local',
    guqinNo: 'Q-1',
    seq: 1,
    mixRatio: '1:1',
    curingTemp: 24,
    curingHumidity: 78,
    polishGrit: 240,
    layerThickness: 0.12,
    totalThickness: 0.12,
    appliedAt: day(7),
    operator: '林听雪',
    ...over,
  };
}
function stringing(over = {}) {
  return {
    id: 's-local',
    guqinNo: 'Q-1',
    stringType: '丝弦',
    nut: '红木雁足',
    stringGap: 17,
    sanNote: '散音好',
    anNote: '按音顺',
    fanNote: '泛音清',
    nineVirtues: '润',
    defects: ['无'],
    strungAt: day(2),
    operator: '周砚秋',
    noteVersions: [],
    ...over,
  };
}

async function analyze(localByTable, incoming, pending = []) {
  return analyzeMerge({ localByTable, incoming, pending, source });
}
const incomingOf = (boards = [], chambers = [], lacquers = [], stringings = []) => ({ boards, chambers, lacquers, stringings });

// 1. 业务键定义
await test('业务键：板材按板材号、槽腹按琴号、髹漆按琴号+遍次、上弦按琴号+上弦日期', async () => {
  assert.equal(businessKey('boards', board()), 'boardNo=MB-1');
  assert.equal(businessKey('chambers', chamber()), 'guqinNo=Q-1');
  assert.equal(businessKey('lacquers', layer()), 'guqinNo=Q-1|seq=1');
  assert.equal(businessKey('stringings', stringing()), `guqinNo=Q-1|strungAt=${day(2).slice(0, 10)}`);
});

// 2. 去重分类：新增/一致/冲突
await test('同键且内容一致归入“一致”；仅日期时分秒不同也算一致（按天比对）', async () => {
  const localBoards = [board()];
  const incomingBoards = [board({ id: 'b-other-id', receivedAt: new Date().toISOString().slice(0, 10) + 'T23:59:00.000Z' })];
  const a = await analyze(
    { boards: localBoards, chambers: [], lacquers: [], stringings: [] },
    incomingOf(incomingBoards),
  );
  assert.equal(a.totals.newCount, 0);
  assert.equal(a.totals.sameCount, 1);
  assert.equal(a.totals.conflictCount, 0);
  assert.ok(recordsEqual(board(), board({ id: '完全不同' })));
});

await test('同键内容不同归入冲突并列出差异字段；本机独有的导入记录为新增', async () => {
  const a = await analyze(
    { boards: [board()], chambers: [], lacquers: [], stringings: [] },
    incomingOf([board({ id: 'b-in', thicknessMm: 28, remark: '对方改过厚度' }), board({ id: 'b-new', boardNo: 'MB-9', guqinNo: 'Q-9' })]),
  );
  assert.equal(a.totals.conflictCount, 1);
  assert.equal(a.totals.newCount, 1);
  assert.deepEqual(a.tables.boards.conflicts[0].changedFields, ['thicknessMm', 'remark']);
});

await test('髹漆按琴号+遍次、上弦按琴号+上弦日期区分', async () => {
  const a = await analyze(
    { boards: [], chambers: [], lacquers: [layer()], stringings: [stringing()] },
    incomingOf(
      [],
      [],
      [layer({ id: 'l-in', mixRatio: '1:1.2' }), layer({ id: 'l-new', seq: 2, layerThickness: 0.1 })],
      [stringing({ id: 's-in', stringGap: 18 }), stringing({ id: 's-new2', strungAt: day(30) })],
    ),
  );
  assert.equal(a.tables.lacquers.conflicts.length, 1);
  assert.equal(a.tables.lacquers.newItems.length, 1);
  assert.equal(a.tables.stringings.conflicts.length, 1);
  assert.equal(a.tables.stringings.newItems.length, 1);
  assert.deepEqual(a.tables.lacquers.conflicts[0].changedFields, ['mixRatio']);
});

await test('缺业务键 / 文件内重复键的记录进入 skipped', async () => {
  const a = await analyze(
    { boards: [], chambers: [], lacquers: [], stringings: [] },
    incomingOf([{ id: 'x' }, board({ id: 'b1' }), board({ id: 'b2' })], [], [layer({ id: 'l-bad', seq: 0 })]),
  );
  assert.equal(a.totals.skippedCount, 2);
  assert.equal(a.tables.boards.skipped.length, 1); // 文件内两条 MB-1，第二条跳过
  assert.equal(a.tables.lacquers.skipped.length, 1);
});

// 3. 提交：本机不动、裁决生效、未裁决留存
await test('提交只落新增；冲突未裁决时本机原样、冲突写入 mergeConflicts', async () => {
  __fake.reset();
  await __fake.put('boards', [board()]);
  const localByTable = await loadLocalByTable();
  const a = await analyze(localByTable, incomingOf([board({ id: 'in1', thicknessMm: 28 }), board({ id: 'in2', boardNo: 'MB-2', guqinNo: 'Q-2' })]));

  const before = __fake.rows('boards');
  const result = await commitMerge({
    analysis: a,
    includedNewKeys: new Set(['boards:boardNo=MB-2']),
    decisions: [],
    source,
  });
  assert.equal(result.inserted, 1);
  assert.equal(result.unresolved, 1);

  const after = __fake.rows('boards');
  const mb1 = after.find((r) => r.boardNo === 'MB-1');
  assert.equal(mb1.thicknessMm, 32, '本机冲突记录必须保持原样');
  assert.equal(mb1.id, 'b-local');
  assert.equal(after.find((r) => r.boardNo === 'MB-2').id, 'in2');
  assert.equal(__fake.rows('mergeConflicts').length, 1);
  const mc = __fake.rows('mergeConflicts')[0];
  assert.equal(mc.table, 'boards');
  assert.equal(mc.key, 'boardNo=MB-1');
  assert.equal(mc.local.thicknessMm, 32);
  assert.equal(mc.incoming.thicknessMm, 28);
  assert.equal(before.length + 1, after.length);
});

await test('裁决“采用导入”沿用本机 id 覆盖；“保留本机”不写库并清除遗留冲突', async () => {
  __fake.reset();
  await __fake.put('boards', [board()]);
  let a = await analyze(await loadLocalByTable(), incomingOf([board({ id: 'in1', thicknessMm: 28 })]));
  await commitMerge({ analysis: a, includedNewKeys: new Set(), decisions: [], source });
  assert.equal(__fake.rows('mergeConflicts').length, 1);

  // 第二次会话：对遗留冲突裁决
  a = await analyze(await loadLocalByTable(), incomingOf([board({ id: 'in1', thicknessMm: 28 })]), __fake.rows('mergeConflicts'));
  assert.equal(a.tables.boards.conflicts[0].pendingId, __fake.rows('mergeConflicts')[0].id);

  const r1 = await commitMerge({
    analysis: a,
    includedNewKeys: new Set(),
    decisions: [{ conflictKey: 'boards:boardNo=MB-1', decision: 'incoming' }],
    source,
  });
  assert.equal(r1.adopted, 1);
  assert.equal(r1.unresolved, 0);
  const adopted = __fake.rows('boards')[0];
  assert.equal(adopted.id, 'b-local', '采用导入时保留本机主键，避免外键/引用断裂');
  assert.equal(adopted.thicknessMm, 28);
  assert.equal(__fake.rows('mergeConflicts').length, 0, '裁决后遗留冲突必须清除');

  // 再来一轮：保留本机
  __fake.reset();
  await __fake.put('boards', [board()]);
  await commitMerge({
    analysis: await analyze(await loadLocalByTable(), incomingOf([board({ id: 'in1', thicknessMm: 28 })])),
    includedNewKeys: new Set(),
    decisions: [],
    source,
  });
  const a2 = await analyze(await loadLocalByTable(), incomingOf(), __fake.rows('mergeConflicts'));
  const r2 = await commitMerge({
    analysis: a2,
    includedNewKeys: new Set(),
    decisions: [{ conflictKey: 'boards:boardNo=MB-1', decision: 'local' }],
    source,
  });
  assert.equal(r2.keptLocal, 1);
  assert.equal(__fake.rows('boards')[0].thicknessMm, 32);
  assert.equal(__fake.rows('mergeConflicts').length, 0);
});

// 4. 髹漆累计厚度重算
await test('采用导入/新增髹漆遍次后，受影响琴的累计厚度整体重算', async () => {
  __fake.reset();
  await __fake.put('lacquers', [
    layer({ id: 'l1', seq: 1, layerThickness: 0.1, totalThickness: 0.1 }),
    layer({ id: 'l2', seq: 2, layerThickness: 0.1, totalThickness: 0.2 }),
    layer({ id: 'l-other', guqinNo: 'Q-2', seq: 1, layerThickness: 0.2, totalThickness: 0.2 }),
  ]);
  const a = await analyze(
    await loadLocalByTable(),
    incomingOf([], [], [
      layer({ id: 'lin', seq: 2, layerThickness: 0.15 }),
      layer({ id: 'lnew', seq: 3, layerThickness: 0.05 }),
    ]),
  );
  // seq=2 冲突采用导入，seq=3 新增
  await commitMerge({
    analysis: a,
    includedNewKeys: new Set(['lacquers:guqinNo=Q-1|seq=3']),
    decisions: [{ conflictKey: 'lacquers:guqinNo=Q-1|seq=2', decision: 'incoming' }],
    source,
  });
  const rows = __fake.rows('lacquers').sort((x, y) => x.guqinNo.localeCompare(y.guqinNo) || x.seq - y.seq);
  const q1 = rows.filter((r) => r.guqinNo === 'Q-1');
  assert.deepEqual(q1.map((r) => [r.seq, r.layerThickness, r.totalThickness]), [
    [1, 0.1, 0.1],
    [2, 0.15, 0.25],
    [3, 0.05, 0.3],
  ]);
  const q2 = rows.find((r) => r.guqinNo === 'Q-2');
  assert.equal(q2.totalThickness, 0.2, '未受影响的琴不应重算');
});

// 5. 遗留冲突跨会话 + 自动消解
await test('未处理冲突留到下次：导入文件不含该键时继续挂起；本机已改成与导入一致时自动清除', async () => {
  __fake.reset();
  await __fake.put('chambers', [chamber()]);
  await commitMerge({
    analysis: await analyze(await loadLocalByTable(), incomingOf([], [chamber({ id: 'cin', chamberDepth: 30 })])),
    includedNewKeys: new Set(),
    decisions: [],
    source,
  });
  assert.equal(__fake.rows('mergeConflicts').length, 1);

  // 无文件打开合并中心：遗留冲突应展示
  let a = await analyze(await loadLocalByTable(), incomingOf(), __fake.rows('mergeConflicts'));
  assert.equal(a.tables.chambers.conflicts.length, 1);
  assert.match(a.tables.chambers.conflicts[0].keyLabel, /琴号 Q-1/);

  // 档案员直接在槽腹页面把本机深度改成 30（与导入一致）→ 再打开应自动消解
  await __fake.put('chambers', [chamber({ chamberDepth: 30 })]);
  a = await analyze(await loadLocalByTable(), incomingOf(), __fake.rows('mergeConflicts'));
  assert.equal(a.tables.chambers.conflicts.length, 0);
  assert.deepEqual(a.stalePendingIds, [__fake.rows('mergeConflicts')[0].id]);

  const r = await commitMerge({ analysis: a, includedNewKeys: new Set(), decisions: [], source });
  assert.equal(r.clearedStale, 1);
  assert.equal(__fake.rows('mergeConflicts').length, 0);
});

await test('遗留冲突期间本机记录被删除：重新导入时需裁决，采用导入才恢复', async () => {
  __fake.reset();
  await __fake.put('stringings', [stringing()]);
  const incoming = [stringing({ id: 'sin', sanNote: '对方改写的散音评语' })];
  await commitMerge({
    analysis: await analyze(await loadLocalByTable(), incomingOf([], [], [], incoming)),
    includedNewKeys: new Set(),
    decisions: [],
    source,
  });
  // 本机删除了该上弦记录
  await db.stringings.clear();

  const a = await analyze(await loadLocalByTable(), incomingOf([], [], [], incoming), __fake.rows('mergeConflicts'));
  assert.equal(a.tables.stringings.conflicts.length, 1);
  assert.equal(a.tables.stringings.conflicts[0].local, null);
  assert.equal(a.tables.stringings.newItems.length, 0);

  await commitMerge({
    analysis: a,
    includedNewKeys: new Set(),
    decisions: [{ conflictKey: `stringings:guqinNo=Q-1|strungAt=${day(2).slice(0, 10)}`, decision: 'incoming' }],
    source,
  });
  const rows = __fake.rows('stringings');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sanNote, '对方改写的散音评语');
  assert.equal(__fake.rows('mergeConflicts').length, 0);
});

await test('髹漆仅累计厚度（派生值）不同不算冲突；提交后按本机遍次重算', async () => {
  __fake.reset();
  await __fake.put('lacquers', [
    layer({ id: 'l1', seq: 1, layerThickness: 0.1, totalThickness: 0.1 }),
    layer({ id: 'l2', seq: 2, layerThickness: 0.1, totalThickness: 99 }),
  ]);
  const a = await analyze(
    await loadLocalByTable(),
    incomingOf([], [], [
      layer({ id: 'l1x', seq: 1, layerThickness: 0.1, totalThickness: 0.2 }),
      layer({ id: 'l2x', seq: 2, layerThickness: 0.1, totalThickness: 0.2 }),
    ]),
  );
  assert.equal(a.tables.lacquers.conflicts.length, 0);
  assert.equal(a.tables.lacquers.sameItems.length, 2);
  assert.equal(a.totals.conflictCount, 0);
});

await test('四表同轮混合：各按各的键，互不干扰', async () => {  __fake.reset();
  await __fake.put('boards', [board()]);
  await __fake.put('chambers', [chamber()]);
  await __fake.put('lacquers', [layer()]);
  await __fake.put('stringings', [stringing()]);
  const a = await analyze(await loadLocalByTable(), {
    boards: [board({ species: '杉木' })],
    chambers: [chamber({ carver: '林听雪' })],
    lacquers: [layer({ curingTemp: 20 })],
    stringings: [stringing({ nut: '乌木雁足' })],
  });
  for (const t of MERGE_TABLES) assert.equal(a.tables[t].conflicts.length, 1, t);
  assert.equal(a.totals.conflictCount, 4);
});

console.log(`\n${process.exitCode ? '有失败用例' : `全部 ${passed} 个用例通过`}`);
