import type { WoodBoard } from './wood-board';
import type { SoundChamber } from './sound-chamber';
import type { LacquerLayer } from './lacquer-layer';
import type { Stringing } from './stringing';

/** 参与合并的四张工序表 */
export type MergeTable = 'boards' | 'chambers' | 'lacquers' | 'stringings';

/** 表中文名 */
export const MERGE_TABLE_LABELS: Record<MergeTable, string> = {
  boards: '板材',
  chambers: '槽腹',
  lacquers: '髹漆',
  stringings: '上弦',
};

/**
 * 合并去重业务键：
 * - 板材：板材号 boardNo
 * - 槽腹：琴号 guqinNo
 * - 髹漆：琴号 guqinNo + 遍次 seq
 * - 上弦：琴号 guqinNo + 上弦日期 strungAt（日期归一到 YYYY-MM-DD）
 */
export type MergeKey = string;

/** 条目状态：新增 / 同键同内容（可直接并入）/ 冲突（同键不同内容）/ 无效跳过 */
export type MergeStatus = 'add' | 'identical' | 'conflict' | 'invalid';

/** 冲突处置：保留本机 / 采用导入 / 未处理 */
export type MergeResolution = 'local' | 'imported' | 'pending';

/** 预览中的一条合并项 */
export interface MergeEntry {
  /** 表内唯一行 id（由 table+key 派生，仅用于前端列表 key） */
  rowId: string;
  table: MergeTable;
  /** 业务键展示 */
  keyLabel: string;
  /** 业务键原始部分 */
  keyParts: { guqinNo?: string; boardNo?: string; seq?: number; strungDay?: string };
  status: MergeStatus;
  /** 仅冲突项有值；identical/add 均为 pending */
  resolution: MergeResolution;
  /** 本机记录（同键时存在） */
  local?: Record<string, unknown>;
  /** 导入记录（同键时存在） */
  incoming?: Record<string, unknown>;
  /** 无效/重复行的跳过原因 */
  reason?: string;
  /** 来源备份文件名与导出时间 */
  sourceFile?: string;
  exportedAt?: string;
}

/** 持久化在 mergeQueue 表中的待处理冲突（提交后未决议的留下，下次继续） */
export interface PendingConflict {
  /** `${table}:${mergeKey}` */
  id: string;
  table: MergeTable;
  mergeKey: MergeKey;
  keyLabel: string;
  keyParts: MergeEntry['keyParts'];
  /** 入队时本机记录快照 */
  local: Record<string, unknown>;
  /** 导入记录快照 */
  incoming: Record<string, unknown>;
  resolution: MergeResolution;
  sourceFile?: string;
  exportedAt?: string;
  /** 入队时间 ISO */
  queuedAt: string;
}

/** 一次「载入备份」得到的预览 */
export interface MergePreview {
  sourceFile: string;
  exportedAt?: string;
  entries: MergeEntry[];
}

export interface MergeCounts {
  add: number;
  identical: number;
  conflict: number;
  invalid: number;
  /** 冲突中已逐条决定的数量 */
  resolved: number;
}

/** 字段展示元数据（用于冲突对照） */
export interface FieldMeta {
  key: string;
  label: string;
  /** 日期字段渲染为 YYYY-MM-DD */
  date?: boolean;
  /** 长文本字段（备注、评语） */
  long?: boolean;
}

const boardFields: FieldMeta[] = [
  { key: 'boardNo', label: '板材号' },
  { key: 'guqinNo', label: '琴号' },
  { key: 'part', label: '部位' },
  { key: 'species', label: '树种' },
  { key: 'dryYears', label: '阴干年限(年)' },
  { key: 'thicknessMm', label: '厚度(mm)' },
  { key: 'grain', label: '木纹' },
  { key: 'defect', label: '缺陷' },
  { key: 'receivedAt', label: '入库日期', date: true },
  { key: 'remark', label: '备注', long: true },
];

const chamberFields: FieldMeta[] = [
  { key: 'guqinNo', label: '琴号' },
  { key: 'nayinThickness', label: '纳音厚度(mm)' },
  { key: 'longchiThickness', label: '龙池厚度(mm)' },
  { key: 'fengzhaoThickness', label: '凤沼厚度(mm)' },
  { key: 'chamberDepth', label: '槽腹深度(mm)' },
  { key: 'postPos', label: '天地柱位置' },
  { key: 'poolSize', label: '龙池凤沼尺寸' },
  { key: 'carvedAt', label: '掏膛日期', date: true },
  { key: 'carver', label: '掏膛人' },
  { key: 'remark', label: '备注', long: true },
];

const lacquerFields: FieldMeta[] = [
  { key: 'guqinNo', label: '琴号' },
  { key: 'seq', label: '遍次' },
  { key: 'mixRatio', label: '灰胎配比' },
  { key: 'curingTemp', label: '荫房温度(℃)' },
  { key: 'curingHumidity', label: '荫房湿度(%)' },
  { key: 'polishGrit', label: '打磨目数' },
  { key: 'layerThickness', label: '本遍厚度(mm)' },
  { key: 'appliedAt', label: '施工日期', date: true },
  { key: 'operator', label: '髹漆人' },
  { key: 'remark', label: '备注', long: true },
];

const stringingFields: FieldMeta[] = [
  { key: 'guqinNo', label: '琴号' },
  { key: 'strungAt', label: '上弦日期', date: true },
  { key: 'stringType', label: '弦材质' },
  { key: 'nut', label: '雁足与绒扣' },
  { key: 'stringGap', label: '弦距(mm)' },
  { key: 'operator', label: '上弦人' },
  { key: 'defects', label: '缺陷标记' },
  { key: 'sanNote', label: '散音评语', long: true },
  { key: 'anNote', label: '按音评语', long: true },
  { key: 'fanNote', label: '泛音评语', long: true },
  { key: 'nineVirtues', label: '九德简述', long: true },
];

export const MERGE_FIELDS: Record<MergeTable, FieldMeta[]> = {
  boards: boardFields,
  chambers: chamberFields,
  lacquers: lacquerFields,
  stringings: stringingFields,
};

export type LocalRow = WoodBoard | SoundChamber | LacquerLayer | Stringing;
