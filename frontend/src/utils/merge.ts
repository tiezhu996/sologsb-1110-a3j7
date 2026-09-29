import { db } from './db';
import { uid } from './id';
import { toPlainList } from './plain';
import { withCumulative } from './seed';
import type { BackupPayload } from './export';
import type {
  MergeAnalysis,
  MergeAnalysisTable,
  MergeConflict,
  MergeConflictItem,
  MergeDecision,
  MergeTable,
} from '../types/merge';
import type { LacquerLayer } from '../types/lacquer-layer';

type AnyRecord = Record<string, unknown>;

export const MERGE_TABLES: MergeTable[] = ['boards', 'chambers', 'lacquers', 'stringings'];

export const TABLE_LABEL: Record<MergeTable, string> = {
  boards: '板材',
  chambers: '槽腹',
  lacquers: '髹漆',
  stringings: '上弦',
};

/**
 * 各表参与合并的字段（比对与差异展示用），顺序即展示顺序。
 * id 不参与比对——两台电脑各自生成记录 id，同键的两条本就可能不同。
 */
export const TABLE_FIELDS: Record<MergeTable, Array<{ key: string; label: string; date?: boolean; array?: boolean }>> = {
  boards: [
    { key: 'boardNo', label: '板材号' },
    { key: 'guqinNo', label: '琴号' },
    { key: 'part', label: '部位' },
    { key: 'species', label: '树种' },
    { key: 'dryYears', label: '阴干年限（年）' },
    { key: 'thicknessMm', label: '厚度（mm）' },
    { key: 'grain', label: '木纹' },
    { key: 'defect', label: '缺陷' },
    { key: 'receivedAt', label: '入库时间', date: true },
    { key: 'remark', label: '备注' },
  ],
  chambers: [
    { key: 'guqinNo', label: '琴号' },
    { key: 'nayinThickness', label: '纳音厚度（mm）' },
    { key: 'longchiThickness', label: '龙池厚度（mm）' },
    { key: 'fengzhaoThickness', label: '凤沼厚度（mm）' },
    { key: 'chamberDepth', label: '槽腹深度（mm）' },
    { key: 'postPos', label: '天地柱位置' },
    { key: 'poolSize', label: '龙池凤沼尺寸' },
    { key: 'carvedAt', label: '掏膛日期', date: true },
    { key: 'carver', label: '掏膛人' },
    { key: 'remark', label: '备注' },
  ],
  lacquers: [
    { key: 'guqinNo', label: '琴号' },
    { key: 'seq', label: '遍次' },
    { key: 'mixRatio', label: '灰胎配比' },
    { key: 'curingTemp', label: '荫房温度（℃）' },
    { key: 'curingHumidity', label: '荫房湿度（%）' },
    { key: 'polishGrit', label: '打磨目数' },
    { key: 'layerThickness', label: '本遍厚度（mm）' },
    { key: 'totalThickness', label: '累计厚度（mm）' },
    { key: 'appliedAt', label: '施工日期', date: true },
    { key: 'operator', label: '髹漆人' },
    { key: 'remark', label: '备注' },
  ],
  stringings: [
    { key: 'guqinNo', label: '琴号' },
    { key: 'stringType', label: '弦材质' },
    { key: 'nut', label: '雁足与绒扣' },
    { key: 'stringGap', label: '弦距（mm）' },
    { key: 'sanNote', label: '散音评语' },
    { key: 'anNote', label: '按音评语' },
    { key: 'fanNote', label: '泛音评语' },
    { key: 'nineVirtues', label: '九德简述' },
    { key: 'defects', label: '缺陷标记', array: true },
    { key: 'strungAt', label: '上弦日期', date: true },
    { key: 'operator', label: '上弦人' },
    { key: 'noteVersions', label: '评语历史版本', array: true },
  ],
};

/** 日期字段：不同电脑写入时分秒/时区会有差别，比对与展示一律归到“天” */
const DATE_FIELDS = new Set(['receivedAt', 'carvedAt', 'appliedAt', 'strungAt']);

/**
 * 派生字段不参与内容比对：髹漆累计厚度由各遍 layerThickness 累加而来，
 * 提交合并时会按本机现有遍次整体重算，两台机器仅累计值不同不算冲突。
 */
const DERIVED_FIELDS: Partial<Record<MergeTable, Set<string>>> = {
  lacquers: new Set(['totalThickness']),
};

/** 业务键：板材按板材号、槽腹按琴号、髹漆按琴号+遍次、上弦按琴号+上弦日期 */
export function businessKey(table: MergeTable, row: AnyRecord): string {
  if (table === 'boards') return `boardNo=${String(row.boardNo ?? '').trim()}`;
  if (table === 'chambers') return `guqinNo=${String(row.guqinNo ?? '').trim()}`;
  if (table === 'lacquers') return `guqinNo=${String(row.guqinNo ?? '').trim()}|seq=${Number(row.seq) || 0}`;
  return `guqinNo=${String(row.guqinNo ?? '').trim()}|strungAt=${dayOf(row.strungAt)}`;
}

/** 给档案员看的键说明 */
export function keyLabel(table: MergeTable, row: AnyRecord): string {
  if (table === 'boards') return `板材号 ${String(row.boardNo ?? '')}`.trim();
  if (table === 'chambers') return `琴号 ${String(row.guqinNo ?? '')}`;
  if (table === 'lacquers') return `琴号 ${String(row.guqinNo ?? '')} · 第 ${Number(row.seq) || 0} 遍`;
  return `琴号 ${String(row.guqinNo ?? '')} · 上弦日期 ${dayOf(row.strungAt)}`;
}

function dayOf(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  return value.slice(0, 10);
}

/** 去掉一切 id（记录 id、评语版本 id），日期归天，并剔除派生字段，得到稳定可比较的纯数据 */
function normalize(value: unknown, excludeKeys?: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, excludeKeys));
  if (value && typeof value === 'object') {
    const out: AnyRecord = {};
    for (const key of Object.keys(value as AnyRecord).sort()) {
      if (key === 'id' || excludeKeys?.has(key)) continue;
      out[key] = DATE_FIELDS.has(key) ? dayOf((value as AnyRecord)[key]) : normalize((value as AnyRecord)[key], excludeKeys);
    }
    return out;
  }
  if (typeof value === 'string') return value.trim();
  return value;
}

/** 稳定序列化（键排序），供深度相等判断 */
function stableStringify(value: unknown, excludeKeys?: Set<string>): string {
  return JSON.stringify(normalize(value, excludeKeys));
}

export function recordsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** 同表记录整体相等（忽略 id、日期时分秒与派生字段） */
export function tableRecordsEqual(table: MergeTable, a: unknown, b: unknown): boolean {
  return stableStringify(a, DERIVED_FIELDS[table]) === stableStringify(b, DERIVED_FIELDS[table]);
}

/** 同键两条记录的差异字段（基于 TABLE_FIELDS，按天比对日期；派生字段不参与） */
export function diffFields(table: MergeTable, local: AnyRecord | null, incoming: AnyRecord): string[] {
  return TABLE_FIELDS[table]
    .filter(({ key }) => !DERIVED_FIELDS[table]?.has(key))
    .filter(({ key }) => !recordsEqual(local?.[key], incoming[key]))
    .map(({ key }) => key);
}

/** 页面展示值格式化 */
export function displayValue(value: unknown, opts?: { date?: boolean; array?: boolean }): string {
  if (opts?.date) return dayOf(value) || '—';
  if (opts?.array) {
    if (Array.isArray(value)) {
      if (value.length === 0) return '—';
      // 元素为对象（如上弦评语历史版本）：显示条数与首个版本时间
      if (value.every((v) => v && typeof v === 'object')) {
        const first = value[0] as AnyRecord;
        const when = typeof first.savedAt === 'string' ? `（最近 ${dayOf(first.savedAt)}）` : '';
        return `${value.length} 条${when}`;
      }
      return value.map((item) => displayValue(item)).join('；');
    }
    return value === undefined || value === null ? '—' : String(value);
  }
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

/** 记录是否具备参与合并的业务键 */
function validRow(table: MergeTable, row: AnyRecord): boolean {
  if (table === 'boards') return typeof row.boardNo === 'string' && row.boardNo.trim().length > 0;
  if (table === 'lacquers') return typeof row.guqinNo === 'string' && row.guqinNo.trim() !== '' && Number(row.seq) > 0;
  if (table === 'stringings') return typeof row.guqinNo === 'string' && row.guqinNo.trim() !== '' && dayOf(row.strungAt) !== '';
  return typeof row.guqinNo === 'string' && row.guqinNo.trim() !== '';
}

function emptyTableAnalysis(table: MergeTable): MergeAnalysisTable {
  return { table, newItems: [], sameItems: [], conflicts: [], skipped: [] };
}

export interface AnalyzeInput {
  localByTable: Record<MergeTable, AnyRecord[]>;
  incoming: Pick<BackupPayload, 'boards' | 'chambers' | 'lacquers' | 'stringings'>;
  /** 已持久化的未决冲突（来自本机 mergeConflicts 表） */
  pending?: MergeConflict[];
  source: string;
}

/**
 * 生成可预览的合并分析：纯只读计算，不动本机数据。
 * 每条导入记录按业务键落到 新增 / 一致 / 冲突 三类，坏行进 skipped。
 */
export function analyzeMerge(input: AnalyzeInput): MergeAnalysis {
  const { localByTable, incoming, pending = [] } = input;
  const incomingByTable: Record<MergeTable, unknown[]> = {
    boards: incoming.boards ?? [],
    chambers: incoming.chambers ?? [],
    lacquers: incoming.lacquers ?? [],
    stringings: incoming.stringings ?? [],
  };

  const tables = {} as Record<MergeTable, MergeAnalysisTable>;
  const seenConflictKeys = new Set<string>();
  const staleSet = new Set<string>();

  // 业务键 -> 遗留未决冲突（跨表不冲突，键格式各自带前缀）
  const pendingMap = new Map<string, MergeConflict>();
  for (const pc of pending) pendingMap.set(`${pc.table}:${pc.key}`, pc);

  for (const table of MERGE_TABLES) {
    const result = emptyTableAnalysis(table);
    const localMap = new Map<string, AnyRecord>();
    for (const row of localByTable[table]) {
      if (validRow(table, row)) localMap.set(businessKey(table, row), row);
    }
    const seenIncomingKeys = new Set<string>();

    for (const raw of incomingByTable[table]) {
      const row = raw as AnyRecord;
      if (!row || typeof row !== 'object') {
        result.skipped.push({ table, reason: '不是有效记录', record: raw });
        continue;
      }
      if (!validRow(table, row)) {
        result.skipped.push({ table, reason: '缺少业务键字段', record: row });
        continue;
      }
      const key = businessKey(table, row);
      if (seenIncomingKeys.has(key)) {
        result.skipped.push({ table, reason: '导入文件内业务键重复', record: row });
        continue;
      }
      seenIncomingKeys.add(key);

      const local = localMap.get(key) ?? null;
      const pc = pendingMap.get(`${table}:${key}`);

      if (!local) {
        if (pc) {
          // 本机记录在冲突留存期间被删除：仍需档案员决定是采用导入还是维持本机（删除即不恢复）
          result.conflicts.push({
            table,
            key,
            keyLabel: keyLabel(table, row),
            local: null,
            incoming: row,
            changedFields: diffFields(table, null, row),
            pendingId: pc.id,
            source: pc.source,
          });
          seenConflictKeys.add(`${table}:${key}`);
        } else {
          result.newItems.push({ table, key, keyLabel: keyLabel(table, row), record: row });
        }
      } else if (tableRecordsEqual(table, local, row)) {
        // 内容已一致：若曾有遗留冲突则自动消解
        result.sameItems.push({ table, key, keyLabel: keyLabel(table, row), local, incoming: row });
        if (pc) staleSet.add(pc.id);
      } else {
        result.conflicts.push({
          table,
          key,
          keyLabel: keyLabel(table, row),
          local,
          incoming: row,
          changedFields: diffFields(table, local, row),
          pendingId: pc?.id,
          source: pc?.source,
        });
        seenConflictKeys.add(`${table}:${key}`);
      }
    }

    // 未在本次导入里出现的遗留未决冲突：保留待处理；本机内容已被改成与导入一致的，标记可清除
    for (const pc of pending.filter((c) => c.table === table)) {
      if (seenIncomingKeys.has(pc.key)) continue;
      const local = localMap.get(pc.key);
      if (local && tableRecordsEqual(table, local, pc.incoming)) {
        staleSet.add(pc.id);
        continue;
      }
      result.conflicts.push({
        table,
        key: pc.key,
        keyLabel: pc.keyLabel,
        local: local ?? null,
        incoming: pc.incoming as AnyRecord,
        changedFields: diffFields(table, local ?? null, pc.incoming as AnyRecord),
        pendingId: pc.id,
        source: pc.source,
      });
      seenConflictKeys.add(`${table}:${pc.key}`);
    }

    tables[table] = result;
  }

  const totals = {
    newCount: MERGE_TABLES.reduce((n, t) => n + tables[t].newItems.length, 0),
    sameCount: MERGE_TABLES.reduce((n, t) => n + tables[t].sameItems.length, 0),
    conflictCount: MERGE_TABLES.reduce((n, t) => n + tables[t].conflicts.length, 0),
    skippedCount: MERGE_TABLES.reduce((n, t) => n + tables[t].skipped.length, 0),
  };

  return { tables, stalePendingIds: [...staleSet], totals };
}

export interface ConflictResolution {
  /** 表:业务键 */
  conflictKey: string;
  decision: MergeDecision;
}

export interface CommitMergeInput {
  analysis: MergeAnalysis;
  /** 勾选写入的新增条目键（默认全选） */
  includedNewKeys: Set<string>;
  /** 已裁决冲突 */
  decisions: ConflictResolution[];
  source: string;
}

export interface CommitMergeResult {
  inserted: number;
  adopted: number;
  keptLocal: number;
  unresolved: number;
  clearedStale: number;
  affectedGuqinNos: string[];
}

/**
 * 事务提交一次合并：
 * - 新增：bulkPut 写入（撞本机 id 时换发新 id）
 * - 已裁决冲突：local 维持原样；incoming 则沿用本机 id 覆盖，本机记录被删则按导入 id 插入
 * - 未裁决冲突：upsert 进 mergeConflicts，本机原记录一律不动，留到下次
 * - 髹漆变动的琴重算累计厚度
 */
export async function commitMerge(input: CommitMergeInput): Promise<CommitMergeResult> {
  const { analysis, includedNewKeys, decisions, source } = input;
  const decisionMap = new Map(decisions.map((d) => [d.conflictKey, d.decision]));

  const nowIso = new Date().toISOString();
  const [boardIds, chamberIds, layerIds, stringingIds] = await Promise.all([
    db.boards.toCollection().primaryKeys(),
    db.chambers.toCollection().primaryKeys(),
    db.lacquers.toCollection().primaryKeys(),
    db.stringings.toCollection().primaryKeys(),
  ]);
  const existingIds = new Set<string>([...boardIds, ...chamberIds, ...layerIds, ...stringingIds]);
  const existingPending = new Map<string, MergeConflict>();
  (await db.mergeConflicts.toArray()).forEach((c) => existingPending.set(`${c.table}:${c.key}`, c));

  const newPuts: Record<MergeTable, AnyRecord[]> = { boards: [], chambers: [], lacquers: [], stringings: [] };
  const overwritePuts: Record<MergeTable, AnyRecord[]> = { boards: [], chambers: [], lacquers: [], stringings: [] };
  const conflictUpserts: MergeConflict[] = [];
  const resolvedPendingIds = new Set<string>();
  const affectedGuqinNos = new Set<string>();

  let inserted = 0;
  let adopted = 0;
  let keptLocal = 0;
  let unresolved = 0;

  for (const table of MERGE_TABLES) {
    const t = analysis.tables[table];

    for (const item of t.newItems) {
      if (!includedNewKeys.has(`${item.table}:${item.key}`)) continue;
      const record: AnyRecord = { ...item.record };
      if (typeof record.id !== 'string' || !record.id || existingIds.has(record.id)) {
        record.id = uid(table === 'boards' ? 'board' : table === 'chambers' ? 'chamber' : table === 'lacquers' ? 'layer' : 'stringing');
      }
      existingIds.add(record.id as string);
      newPuts[table].push(record);
      inserted += 1;
      if (typeof record.guqinNo === 'string') affectedGuqinNos.add(record.guqinNo);
    }

    for (const item of t.conflicts) {
      const ck = `${item.table}:${item.key}`;
      if (item.pendingId) resolvedPendingIds.add(item.pendingId);
      const decision = decisionMap.get(ck);

      if (!decision) {
        const existed = existingPending.get(ck);
        conflictUpserts.push({
          id: existed?.id ?? item.pendingId ?? uid('conflict'),
          table: item.table,
          key: item.key,
          keyLabel: item.keyLabel,
          local: item.local,
          incoming: item.incoming,
          source: item.source ?? source,
          createdAt: existed?.createdAt ?? nowIso,
        });
        unresolved += 1;
        continue;
      }

      if (decision === 'local') {
        keptLocal += 1;
      } else {
        if (item.local) {
          overwritePuts[item.table].push({ ...item.incoming, id: item.local.id });
        } else {
          const record: AnyRecord = { ...item.incoming };
          if (typeof record.id !== 'string' || !record.id || existingIds.has(record.id)) {
            record.id = uid(item.table === 'boards' ? 'board' : item.table === 'chambers' ? 'chamber' : item.table === 'lacquers' ? 'layer' : 'stringing');
          }
          existingIds.add(record.id as string);
          overwritePuts[item.table].push(record);
        }
        adopted += 1;
        if (typeof item.incoming.guqinNo === 'string') affectedGuqinNos.add(item.incoming.guqinNo);
      }
    }
  }

  const staleCleared = analysis.stalePendingIds.filter((id) => existingPending.has(id));
  const staleClearedSet = new Set(staleCleared);

  await db.transaction('rw', db.boards, db.chambers, db.lacquers, db.stringings, db.mergeConflicts, async () => {
    for (const table of MERGE_TABLES) {
      const puts = [...newPuts[table], ...overwritePuts[table]];
      if (!puts.length) continue;
      const plain = toPlainList(puts) as never[];
      if (table === 'boards') await db.boards.bulkPut(plain);
      else if (table === 'chambers') await db.chambers.bulkPut(plain);
      else if (table === 'lacquers') await db.lacquers.bulkPut(plain);
      else await db.stringings.bulkPut(plain);
    }
    if (conflictUpserts.length) await db.mergeConflicts.bulkPut(toPlainList(conflictUpserts));

    // 已裁决 / 本机已一致的遗留冲突，从未决表移除
    const idsToDelete = [...resolvedPendingIds].filter((id) => !conflictUpserts.some((c) => c.id === id));
    const allDeleteIds = new Set([...idsToDelete, ...staleClearedSet]);
    if (allDeleteIds.size) await db.mergeConflicts.bulkDelete([...allDeleteIds]);

    // 髹漆：受影响的琴重算累计厚度（新增/覆盖/采用导入都可能改动遍次）
    if (affectedGuqinNos.size) {
      const allLayers = await db.lacquers.toArray();
      const touched = allLayers.filter((l: LacquerLayer) => affectedGuqinNos.has(l.guqinNo));
      if (touched.length) {
        const recalculated = withCumulative(touched);
        await db.lacquers.bulkPut(toPlainList(recalculated));
      }
    }
  });

  return {
    inserted,
    adopted,
    keptLocal,
    unresolved,
    clearedStale: staleCleared.length,
    affectedGuqinNos: [...affectedGuqinNos],
  };
}

/** 取本机全部表的最新记录（预览/页面加载时调用） */
export async function loadLocalByTable(): Promise<Record<MergeTable, AnyRecord[]>> {
  const [boards, chambers, lacquers, stringings] = await Promise.all([
    db.boards.toArray(),
    db.chambers.toArray(),
    db.lacquers.toArray(),
    db.stringings.toArray(),
  ]);
  return {
    boards: boards as unknown as AnyRecord[],
    chambers: chambers as unknown as AnyRecord[],
    lacquers: lacquers as unknown as AnyRecord[],
    stringings: stringings as unknown as AnyRecord[],
  };
}
