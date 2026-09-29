import { db } from './db';
import { uid } from './id';
import { toPlain } from './plain';
import { cumulativeThickness, sortLayers } from './layer';
import type { BackupPayload } from './export';
import {
  MERGE_FIELDS as FIELD_LIST,
  type FieldMeta,
  type MergeEntry,
  type MergeKey,
  type MergePreview,
  type MergeTable,
  type PendingConflict,
} from '../types/merge';

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** ISO 日期归一到 YYYY-MM-DD（上弦按日期去重，不区分时分秒；无时区后缀按当地日期，不做 UTC 偏移） */
export function dayOf(iso: unknown): string {
  const s = str(iso);
  const m = s.match(DAY_RE);
  if (m) return m[0];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface KeyResult {
  key: MergeKey;
  label: string;
  parts: MergeEntry['keyParts'];
  ok: boolean;
  reason?: string;
}

/** 计算业务键；缺键的行判为无效（不进库也不进冲突表） */
export function keyOf(table: MergeTable, row: Record<string, unknown>): KeyResult {
  if (table === 'boards') {
    const boardNo = str(row.boardNo);
    if (!boardNo) return { key: '', label: '', parts: {}, ok: false, reason: '缺少板材号' };
    return { key: boardNo, label: `板材号 ${boardNo}`, parts: { boardNo }, ok: true };
  }
  if (table === 'chambers') {
    const guqinNo = str(row.guqinNo);
    if (!guqinNo) return { key: '', label: '', parts: {}, ok: false, reason: '缺少琴号' };
    return { key: guqinNo, label: `琴号 ${guqinNo}`, parts: { guqinNo }, ok: true };
  }
  if (table === 'lacquers') {
    const guqinNo = str(row.guqinNo);
    const seq = num(row.seq);
    if (!guqinNo || !Number.isInteger(seq) || seq <= 0) {
      return { key: '', label: '', parts: {}, ok: false, reason: '缺少琴号或遍次' };
    }
    return { key: `${guqinNo}#${seq}`, label: `琴号 ${guqinNo} · 第 ${seq} 遍`, parts: { guqinNo, seq }, ok: true };
  }
  const guqinNo = str(row.guqinNo);
  const strungDay = dayOf(row.strungAt);
  if (!guqinNo || !DAY_RE.test(strungDay)) {
    return { key: '', label: '', parts: {}, ok: false, reason: '缺少琴号或上弦日期' };
  }
  return {
    key: `${guqinNo}@${strungDay}`,
    label: `琴号 ${guqinNo} · 上弦 ${strungDay}`,
    parts: { guqinNo, strungDay },
    ok: true,
  };
}

/** 去掉行 id 与髹漆派生字段 totalThickness（提交后统一重算，不参与同异判定） */
function comparable(table: MergeTable, row: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = row;
  if (table === 'lacquers') delete rest.totalThickness;
  return rest;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * 同键两条是否“内容一样”：
 * - 忽略行 id 与髹漆派生的 totalThickness；
 * - 评语历史版本只忽略版本自身的 id，版本条目数量或内容不同仍算冲突；
 * - 各 *At 日期字段归一到 YYYY-MM-DD 比较（去重业务键按“日期”而非时刻）。
 */
export function sameContent(table: MergeTable, a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const strip = (row: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(comparable(table, row))) {
      if (k === 'noteVersions' && Array.isArray(v)) {
        out[k] = v.map((ver) => (isRecord(ver) ? (() => {
          const { id: _vId, ...rest } = ver;
          return normalizeDates(rest);
        })() : ver));
      } else {
        out[k] = k.endsWith('At') && typeof v === 'string' ? dayOf(v) : v;
      }
    }
    return out;
  };
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

/** 归一对象内的日期字段到天（评语历史版本等嵌套结构用） */
function normalizeDates(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = k.endsWith('At') && typeof v === 'string' ? dayOf(v) : v;
  }
  return out;
}

export function queueId(table: MergeTable, key: MergeKey): string {
  return `${table}:${key}`;
}

type LocalIndex = Record<MergeTable, Map<MergeKey, Record<string, unknown>>>;

function indexRows(table: MergeTable, rows: unknown[], map: Map<MergeKey, Record<string, unknown>>): void {
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const k = keyOf(table, raw);
    // 本机表内出现重复键时保留首条（正常数据不会发生）
    if (k.ok && !map.has(k.key)) map.set(k.key, raw);
  }
}

/** 本地四表当前快照，按业务键索引 */
export async function loadLocalIndex(): Promise<LocalIndex> {
  const [boards, chambers, lacquers, stringings] = await Promise.all([
    db.boards.toArray(),
    db.chambers.toArray(),
    db.lacquers.toArray(),
    db.stringings.toArray(),
  ]);
  const index: LocalIndex = {
    boards: new Map(),
    chambers: new Map(),
    lacquers: new Map(),
    stringings: new Map(),
  };
  indexRows('boards', boards, index.boards);
  indexRows('chambers', chambers, index.chambers);
  indexRows('lacquers', lacquers, index.lacquers);
  indexRows('stringings', stringings, index.stringings);
  return index;
}

/**
 * 预览一份备份：不写任何业务表。
 * - 无同键 → add；同键且内容一致 → identical；同键内容不同 → conflict
 * - 备份内重复键只取第一条，其余进 invalid
 */
export function previewBackup(
  payload: BackupPayload,
  sourceFile: string,
  localIndex: LocalIndex,
): MergePreview {
  const entries: MergeEntry[] = [];
  const tables: Array<{ table: MergeTable; rows: unknown[] }> = [
    { table: 'boards', rows: payload.boards ?? [] },
    { table: 'chambers', rows: payload.chambers ?? [] },
    { table: 'lacquers', rows: payload.lacquers ?? [] },
    { table: 'stringings', rows: payload.stringings ?? [] },
  ];
  for (const { table, rows } of tables) {
    const seen = new Set<MergeKey>();
    for (const raw of rows) {
      if (!isRecord(raw)) {
        entries.push({ rowId: uid('mv'), table, keyLabel: '（非对象行）', keyParts: {}, status: 'invalid', resolution: 'pending', reason: '记录格式不是对象' });
        continue;
      }
      const k = keyOf(table, raw);
      const fallbackLabel = str(raw.boardNo) || str(raw.guqinNo) || '（缺键记录）';
      if (!k.ok) {
        entries.push({
          rowId: uid('mv'),
          table,
          keyLabel: fallbackLabel,
          keyParts: {},
          status: 'invalid',
          resolution: 'pending',
          reason: k.reason,
          sourceFile,
          exportedAt: payload.exportedAt,
        });
        continue;
      }
      if (seen.has(k.key)) {
        entries.push({
          rowId: uid('mv'),
          table,
          keyLabel: k.label,
          keyParts: k.parts,
          status: 'invalid',
          resolution: 'pending',
          reason: '备份内业务键重复，已跳过此行',
          sourceFile,
          exportedAt: payload.exportedAt,
        });
        continue;
      }
      seen.add(k.key);

      const local = localIndex[table].get(k.key);
      const status: MergeEntry['status'] = !local ? 'add' : sameContent(table, local, raw) ? 'identical' : 'conflict';
      entries.push({
        rowId: queueId(table, k.key),
        table,
        keyLabel: k.label,
        keyParts: k.parts,
        status,
        resolution: 'pending',
        local,
        incoming: raw,
        sourceFile,
        exportedAt: payload.exportedAt,
      });
    }
  }
  return { sourceFile, exportedAt: payload.exportedAt, entries };
}

/** 从备份里携带的待处理冲突并入本机冲突队列（同键已存在则保留本机队列项与处置） */
export async function mergeIncomingPending(payload: BackupPayload): Promise<number> {
  const rows = (payload.pendingConflicts ?? []) as unknown[];
  let added = 0;
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const table = str(raw.table) as MergeTable;
    if (!['boards', 'chambers', 'lacquers', 'stringings'].includes(table)) continue;
    const id = str(raw.id);
    if (!id || (await db.mergeQueue.get(id))) continue;
    const keyParts = isRecord(raw.keyParts) ? (raw.keyParts as PendingConflict['keyParts']) : {};
    await db.mergeQueue.put(
      toPlain({
        id,
        table,
        mergeKey: str(raw.mergeKey) || id.split(':').slice(1).join(':'),
        keyLabel: str(raw.keyLabel) || id,
        keyParts,
        local: isRecord(raw.local) ? raw.local : {},
        incoming: isRecord(raw.incoming) ? raw.incoming : {},
        resolution: 'pending',
        sourceFile: str(raw.sourceFile) || undefined,
        exportedAt: str(raw.exportedAt) || undefined,
        queuedAt: new Date().toISOString(),
      } satisfies PendingConflict),
    );
    added += 1;
  }
  return added;
}

/**
 * 把一次预览中的冲突写入冲突队列（未决议即持久化，关掉页面也在）。
 * 已存在的队列项：刷新本机/导入快照；档案员已做出的决议默认保留——
 * 但若新备份里的导入内容与上次不同，则决议依据已变，重置为待处理。
 */
export async function upsertConflicts(entries: MergeEntry[]): Promise<void> {
  for (const e of entries.filter((x) => x.status === 'conflict')) {
    const id = e.rowId;
    const existed = await db.mergeQueue.get(id);
    const incomingChanged = existed ? !sameContent(e.table, existed.incoming as Record<string, unknown>, e.incoming ?? {}) : false;
    const keptResolution =
      !existed || incomingChanged
        ? 'pending'
        : existed.resolution === 'local' || existed.resolution === 'imported'
          ? existed.resolution
          : 'pending';
    const record: PendingConflict = {
      id,
      table: e.table,
      mergeKey: id.split(':').slice(1).join(':'),
      keyLabel: e.keyLabel,
      keyParts: e.keyParts,
      local: toPlain(e.local ?? {}),
      incoming: toPlain(e.incoming ?? {}),
      resolution: keptResolution,
      sourceFile: e.sourceFile,
      exportedAt: e.exportedAt,
      queuedAt: existed?.queuedAt ?? new Date().toISOString(),
    };
    await db.mergeQueue.put(toPlain(record));
  }
}

/** 更新队列中某条冲突的逐条决议 */
export async function setConflictResolution(id: string, resolution: 'local' | 'imported'): Promise<void> {
  const existed = await db.mergeQueue.get(id);
  if (!existed) return;
  await db.mergeQueue.put(toPlain({ ...existed, resolution }));
}

/** 队列项转预览项（结合当前本机记录实时判断：已无记录→新增；内容已一致→可直接消项） */
export function pendingToEntry(p: PendingConflict, local?: Record<string, unknown>): MergeEntry {
  return {
    rowId: p.id,
    table: p.table,
    keyLabel: p.keyLabel,
    keyParts: p.keyParts,
    status: local ? (sameContent(p.table, local, p.incoming) ? 'identical' : 'conflict') : 'add',
    resolution: p.resolution,
    local: local ?? p.local,
    incoming: p.incoming,
    sourceFile: p.sourceFile,
    exportedAt: p.exportedAt,
  };
}

function tableOf(table: MergeTable) {
  return table === 'boards' ? db.boards : table === 'chambers' ? db.chambers : table === 'lacquers' ? db.lacquers : db.stringings;
}

/** 按业务键在业务表中找当前本机行 */
export async function findByKey(table: MergeTable, key: string): Promise<Record<string, unknown> | undefined> {
  const rows = (await tableOf(table).toArray()) as unknown[];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const k = keyOf(table, raw);
    if (k.ok && k.key === key) return raw;
  }
  return undefined;
}

/** 采用导入时重映射内部 id，避免与对端备份中的 id 相撞；覆盖同键本机行时沿用其 id */
function remapIds(table: MergeTable, incoming: Record<string, unknown>, localId?: string): Record<string, unknown> {
  const prefix = table === 'boards' ? 'board' : table === 'chambers' ? 'chamber' : table === 'lacquers' ? 'layer' : 'stringing';
  const out: Record<string, unknown> = { ...incoming, id: localId ?? uid(prefix) };
  if (table === 'stringings' && Array.isArray(incoming.noteVersions)) {
    out.noteVersions = incoming.noteVersions.map((v) => (isRecord(v) ? { ...v, id: uid('tone') } : v));
  }
  return out;
}

/** 重算受影响琴号的髹漆累计厚度（与 lacquerStore 口径一致） */
async function recalcLacquer(guqinNos: Set<string>): Promise<void> {
  for (const guqinNo of guqinNos) {
    if (!guqinNo) continue;
    const layers = sortLayers(await db.lacquers.where('guqinNo').equals(guqinNo).toArray());
    for (const layer of layers) {
      await db.lacquers.put(toPlain({ ...layer, totalThickness: cumulativeThickness(layers, layer.seq) }));
    }
  }
}

export interface CommitResult {
  added: number;
  updated: number;
  keptLocal: number;
  conflictLeft: number;
  autoCleared: number;
}

/**
 * 提交合并（事务）：
 * - 本次预览的 add 重映射 id 写入；identical 幂等不动
 * - 冲突队列已决议：local → 仅删队列、本机原样；imported → 覆盖/新增后删队列
 * - 内容已被本机自行改成一致的历史冲突自动消项
 * - 未处理冲突留在队列（导出备份会带上），下次继续
 */
export async function commitMerge(previewEntries: MergeEntry[]): Promise<CommitResult> {
  const result: CommitResult = { added: 0, updated: 0, keptLocal: 0, conflictLeft: 0, autoCleared: 0 };
  const affectedGuqin = new Set<string>();

  await db.transaction('rw', db.boards, db.chambers, db.lacquers, db.stringings, db.mergeQueue, async () => {
    // 队列里已有同键条目（含历次遗留）时，一律以队列决议为准，跳过预览中的直写
    const queuedAtStart = await db.mergeQueue.toArray();
    const queuedKeys = new Set(queuedAtStart.map((q) => q.id));

    // 1) 本次载入备份中的新增（冲突项一律走队列决议，不在此处理）
    for (const e of previewEntries) {
      if (e.status === 'add' && e.incoming && !queuedKeys.has(e.rowId)) {
        await tableOf(e.table).put(toPlain(remapIds(e.table, e.incoming)) as never);
        result.added += 1;
        if (e.keyParts.guqinNo) affectedGuqin.add(e.keyParts.guqinNo);
      }
    }

    // 2) 冲突队列逐条处置（含本次新载入与历次遗留）
    for (const q of queuedAtStart) {
      if (q.table === 'lacquers') affectedGuqin.add(q.keyParts?.guqinNo ?? String((q.incoming as Record<string, unknown>)?.guqinNo ?? ''));
      const existing = await findByKey(q.table, q.mergeKey);

      if (existing && sameContent(q.table, existing, q.incoming as Record<string, unknown>)) {
        // 差异已消失（如本机已手工改成一致）
        await db.mergeQueue.delete(q.id);
        result.autoCleared += 1;
        continue;
      }

      if (q.resolution === 'imported') {
        const row = remapIds(q.table, q.incoming as Record<string, unknown>, existing ? str(existing.id) : undefined);
        await tableOf(q.table).put(toPlain(row) as never);
        await db.mergeQueue.delete(q.id);
        if (existing) result.updated += 1;
        else result.added += 1;
      } else if (q.resolution === 'local') {
        await db.mergeQueue.delete(q.id);
        result.keptLocal += 1;
      } else {
        result.conflictLeft += 1;
        if (existing) await db.mergeQueue.put(toPlain({ ...q, local: existing }));
      }
    }
  });

  await recalcLacquer(affectedGuqin);
  return result;
}

/** 渲染字段值供冲突对照 */
export function formatFieldValue(meta: FieldMeta, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (meta.date) return dayOf(value);
  if (Array.isArray(value)) return value.join('、');
  return String(value);
}

/** 找出一条冲突中本机与导入不一样的字段（id / totalThickness 不展示；日期按天比较） */
export function diffFields(table: MergeTable, local: Record<string, unknown>, incoming: Record<string, unknown>): FieldMeta[] {
  return FIELD_LIST[table].filter((f) => {
    let a: unknown = local[f.key];
    let b: unknown = incoming[f.key];
    if (f.date) {
      a = a === undefined || a === null || a === '' ? a : dayOf(a);
      b = b === undefined || b === null || b === '' ? b : dayOf(b);
    }
    if (f.key === 'defects' && Array.isArray(a) && Array.isArray(b)) {
      return stableStringify([...a].sort()) !== stableStringify([...b].sort());
    }
    return stableStringify(a ?? null) !== stableStringify(b ?? null);
  });
}

export { FIELD_LIST as MERGE_FIELDS };
