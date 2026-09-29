/** 参与合并的四张工序表 */
export type MergeTable = 'boards' | 'chambers' | 'lacquers' | 'stringings';

/** 冲突裁决：保留本机原记录 / 采用导入记录 */
export type MergeDecision = 'local' | 'incoming';

/**
 * 未决冲突：导入时同键内容不一致、档案员尚未裁决的条目。
 * 提交合并时整体写入 IndexedDB，导出备份一并携带，下次打开继续处理。
 */
export interface MergeConflict {
  /** 冲突记录自身主键（mergeConflicts 表） */
  id: string;
  table: MergeTable;
  /** 表内业务键（板材号 / 琴号 / 琴号+遍次 / 琴号+上弦日期） */
  key: string;
  /** 给档案员看的键说明 */
  keyLabel: string;
  /** 本机原记录快照；本机已删除时为 null */
  local: Record<string, unknown> | null;
  /** 导入记录 */
  incoming: Record<string, unknown>;
  /** 来源（备份文件名 / 导出时间） */
  source: string;
  createdAt: string;
}

/** 预览中的一条新增（本机无同键记录） */
export interface MergeNewItem {
  table: MergeTable;
  key: string;
  keyLabel: string;
  record: Record<string, unknown>;
}

/** 预览中的一条一致记录（同键且内容相同，合并不必改动） */
export interface MergeSameItem {
  table: MergeTable;
  key: string;
  keyLabel: string;
  local: Record<string, unknown>;
  incoming: Record<string, unknown>;
}

/** 预览中的一条冲突 */
export interface MergeConflictItem {
  table: MergeTable;
  key: string;
  keyLabel: string;
  local: Record<string, unknown> | null;
  incoming: Record<string, unknown>;
  /** 内容不一致的字段名列表 */
  changedFields: string[];
  /** 已持久化的未决冲突 id（来自上次合并或本次已提交过） */
  pendingId?: string;
  /** 来源说明 */
  source?: string;
}

/** 无法参与合并而被跳过的导入记录 */
export interface MergeSkippedItem {
  table: MergeTable;
  reason: string;
  record: unknown;
}

export interface MergeAnalysisTable {
  table: MergeTable;
  newItems: MergeNewItem[];
  sameItems: MergeSameItem[];
  conflicts: MergeConflictItem[];
  skipped: MergeSkippedItem[];
}

export interface MergeAnalysis {
  tables: Record<MergeTable, MergeAnalysisTable>;
  /** 本机内容已与导入一致、可直接清除的遗留未决冲突 */
  stalePendingIds: string[];
  totals: {
    newCount: number;
    sameCount: number;
    conflictCount: number;
    skippedCount: number;
  };
}
