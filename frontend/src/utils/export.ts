import { db, SCHEMA_VERSION } from './db';
import type { PendingConflict } from '../types/merge';

export interface BackupPayload {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  boards: unknown[];
  chambers: unknown[];
  lacquers: unknown[];
  stringings: unknown[];
  /** 未处理完的合并冲突（换电脑/下次打开继续逐条处置） */
  pendingConflicts?: PendingConflict[];
}

/** 汇总全部本地表为 JSON 备份（含未处理完的合并冲突） */
export async function buildBackup(): Promise<BackupPayload> {
  const [boards, chambers, lacquers, stringings, pendingConflicts] = await Promise.all([
    db.boards.toArray(),
    db.chambers.toArray(),
    db.lacquers.toArray(),
    db.stringings.toArray(),
    db.mergeQueue.toArray(),
  ]);
  return {
    app: 'gbguqin',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    boards,
    chambers,
    lacquers,
    stringings,
    pendingConflicts,
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

/** 读取并校验对方的备份文件（不写库，只做解析与格式校验） */
export function parseBackupText(text: string): BackupPayload {
  let payload: Partial<BackupPayload>;
  try {
    payload = JSON.parse(text) as Partial<BackupPayload>;
  } catch {
    throw new Error('文件不是合法的 JSON');
  }
  if (!payload || payload.app !== 'gbguqin') {
    throw new Error('备份文件格式不匹配（缺少 app=gbguqin 标记）');
  }
  return {
    app: 'gbguqin',
    schemaVersion: Number(payload.schemaVersion) || 0,
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : '',
    boards: Array.isArray(payload.boards) ? payload.boards : [],
    chambers: Array.isArray(payload.chambers) ? payload.chambers : [],
    lacquers: Array.isArray(payload.lacquers) ? payload.lacquers : [],
    stringings: Array.isArray(payload.stringings) ? payload.stringings : [],
    pendingConflicts: Array.isArray(payload.pendingConflicts) ? (payload.pendingConflicts as PendingConflict[]) : [],
  };
}
