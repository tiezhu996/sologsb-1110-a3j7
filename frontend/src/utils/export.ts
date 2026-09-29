import { db, SCHEMA_VERSION } from './db';
import type { MergeConflict } from '../types/merge';

export interface BackupPayload {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  boards: unknown[];
  chambers: unknown[];
  lacquers: unknown[];
  stringings: unknown[];
  /** 合并时尚未裁决的冲突（旧版本备份没有此字段，按空处理） */
  mergeConflicts?: MergeConflict[];
}

/** 汇总全部本地表为 JSON 备份（含未决冲突，schema 迁移前先导出） */
export async function buildBackup(): Promise<BackupPayload> {
  const [boards, chambers, lacquers, stringings, mergeConflicts] = await Promise.all([
    db.boards.toArray(),
    db.chambers.toArray(),
    db.lacquers.toArray(),
    db.stringings.toArray(),
    db.mergeConflicts.toArray(),
  ]);
  return {
    app: 'gbguqin',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    boards,
    chambers,
    lacquers,
    stringings,
    mergeConflicts,
  };
}

export async function exportBackupJson(): Promise<string> {
  return JSON.stringify(await buildBackup(), null, 2);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出 CSV（工序档案打印用） */
export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns: Array<{ key: keyof T; title: string }>,
): void {
  const header = columns.map((c) => `"${c.title}"`).join(',');
  const body = rows
    .map((row) => columns.map((c) => `"${String(row[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  downloadText(filename, `﻿${header}\n${body}`, 'text/csv');
}

/** 解析并校验备份文件；任何合并/恢复入口都先走这里 */
export function parseBackup(text: string): BackupPayload {
  let payload: Partial<BackupPayload>;
  try {
    payload = JSON.parse(text) as Partial<BackupPayload>;
  } catch {
    throw new Error('备份文件不是合法的 JSON');
  }
  if (!payload || payload.app !== 'gbguqin') {
    throw new Error('备份文件格式不匹配（缺少 app=gbguqin 标记）');
  }
  return {
    app: 'gbguqin',
    schemaVersion: typeof payload.schemaVersion === 'number' ? payload.schemaVersion : 0,
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : '',
    boards: payload.boards ?? [],
    chambers: payload.chambers ?? [],
    lacquers: payload.lacquers ?? [],
    stringings: payload.stringings ?? [],
    mergeConflicts: payload.mergeConflicts ?? [],
  };
}

/**
 * 整库恢复：用备份内容完全替换本机记录（会清空当前四表）。
 * 日常两台电脑合档请走「导入合并」（按业务键去重 + 冲突逐条裁决），本函数仅用于明确要整体替换本机档案的场景。
 */
export async function importBackup(text: string): Promise<{ boards: number; chambers: number; lacquers: number; stringings: number; conflicts: number }> {
  const payload = parseBackup(text);
  const counts = {
    boards: payload.boards.length,
    chambers: payload.chambers.length,
    lacquers: payload.lacquers.length,
    stringings: payload.stringings.length,
    conflicts: payload.mergeConflicts?.length ?? 0,
  };
  await db.transaction('rw', db.boards, db.chambers, db.lacquers, db.stringings, db.mergeConflicts, async () => {
    await Promise.all([
      db.boards.clear(),
      db.chambers.clear(),
      db.lacquers.clear(),
      db.stringings.clear(),
      db.mergeConflicts.clear(),
    ]);
    if (payload.boards.length) await db.boards.bulkPut(payload.boards as never[]);
    if (payload.chambers.length) await db.chambers.bulkPut(payload.chambers as never[]);
    if (payload.lacquers.length) await db.lacquers.bulkPut(payload.lacquers as never[]);
    if (payload.stringings.length) await db.stringings.bulkPut(payload.stringings as never[]);
    if (payload.mergeConflicts?.length) await db.mergeConflicts.bulkPut(payload.mergeConflicts as never[]);
  });
  return counts;
}
