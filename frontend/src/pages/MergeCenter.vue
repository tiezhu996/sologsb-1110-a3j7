<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Upload, Refresh, CircleCheck } from '@element-plus/icons-vue';
import { parseBackup, type BackupPayload } from '../utils/export';
import { db } from '../utils/db';
import {
  MERGE_TABLES,
  TABLE_LABEL,
  TABLE_FIELDS,
  analyzeMerge,
  commitMerge,
  loadLocalByTable,
  displayValue,
  type AnalyzeInput,
} from '../utils/merge';
import type { MergeAnalysis, MergeConflict, MergeConflictItem, MergeDecision, MergeTable } from '../types/merge';
import { useBoardStore } from '../stores/boardStore';
import { useChamberStore } from '../stores/chamberStore';
import { useLacquerStore } from '../stores/lacquerStore';
import { useStringingStore } from '../stores/stringingStore';

const boardStore = useBoardStore();
const chamberStore = useChamberStore();
const lacquerStore = useLacquerStore();
const stringingStore = useStringingStore();

const loading = ref(false);
const committing = ref(false);
const fileName = ref('');
const source = ref('');
const analysis = ref<MergeAnalysis | null>(null);
const pending = ref<MergeConflict[]>([]);
const activeTable = ref<MergeTable>('boards');

/** conflictKey(table:key) -> 裁决 */
const decisions = ref(new Map<string, MergeDecision>());
/** 勾选写入的新增条目 */
const includedNewKeys = ref(new Set<string>());

const TABLE_ORDER: MergeTable[] = MERGE_TABLES;

const pendingCount = computed(() => pending.value.length);
const totals = computed(() => analysis.value?.totals ?? null);
const hasPreview = computed(() => analysis.value !== null);

/** 未裁决数量（含遗留冲突） */
const unresolvedCount = computed(() => {
  if (!analysis.value) return 0;
  return TABLE_ORDER.reduce((n, t) => n + analysis.value!.tables[t].conflicts.filter((c) => !decisions.value.has(`${t}:${c.key}`)).length, 0);
});

function badgeType(table: MergeTable): { type: 'primary' | 'success' | 'warning' | 'info'; label: string } {
  const t = analysis.value?.tables[table];
  if (!t) return { type: 'info', label: TABLE_LABEL[table] };
  const undecided = t.conflicts.filter((c) => !decisions.value.has(`${table}:${c.key}`)).length;
  if (undecided > 0) return { type: 'warning', label: `${TABLE_LABEL[table]} · ${undecided} 冲突待裁` };
  if (t.conflicts.length > 0) return { type: 'success', label: `${TABLE_LABEL[table]} · 冲突已裁` };
  if (t.newItems.length > 0) return { type: 'primary', label: `${TABLE_LABEL[table]} · ${t.newItems.length} 新增` };
  return { type: 'info', label: `${TABLE_LABEL[table]} · 无变化` };
}

async function refreshLocal(reanalyze: boolean, payload?: BackupPayload) {
  loading.value = true;
  try {
    const localByTable = await loadLocalByTable();
    pending.value = await db.mergeConflicts.toArray();
    if (reanalyze && payload) {
      const input: AnalyzeInput = {
        localByTable,
        incoming: payload,
        pending: pending.value,
        source: source.value || payload.exportedAt || '备份文件',
      };
      analysis.value = analyzeMerge(input);
      decisions.value = new Map();
      includedNewKeys.value = new Set();
      for (const t of TABLE_ORDER) {
        for (const item of analysis.value.tables[t].newItems) {
          includedNewKeys.value.add(`${item.table}:${item.key}`);
        }
      }
      // 有冲突的表优先展示
      const firstConflictTable = TABLE_ORDER.find((t) => analysis.value!.tables[t].conflicts.length > 0);
      if (firstConflictTable) activeTable.value = firstConflictTable;
    } else if (!reanalyze && pending.value.length > 0) {
      // 无文件时，把遗留未决冲突单独做一份分析，供逐条处理
      analysis.value = analyzeMerge({
        localByTable,
        incoming: { boards: [], chambers: [], lacquers: [], stringings: [] },
        pending: pending.value,
        source: '本机遗留冲突',
      });
      decisions.value = new Map();
      includedNewKeys.value = new Set();
      const firstConflictTable = TABLE_ORDER.find((t) => analysis.value!.tables[t].conflicts.length > 0);
      if (firstConflictTable) activeTable.value = firstConflictTable;
    } else if (!reanalyze) {
      // 无文件也无遗留冲突：收起预览
      analysis.value = null;
      decisions.value = new Map();
      includedNewKeys.value = new Set();
    }
  } finally {
    loading.value = false;
  }
}

async function handleFile(file: File) {
  loading.value = true;
  try {
    const text = await file.text();
    const payload = parseBackup(text);
    fileName.value = file.name;
    source.value = `${file.name}（导出于 ${payload.exportedAt.slice(0, 10) || '未知日期'}）`;
    await refreshLocal(true, payload);
    ElMessage.success('备份已解析，可在下方预览后再提交');
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
  return false; // 阻止 el-upload 自动上传
}

function setDecision(item: MergeConflictItem, decision: MergeDecision) {
  decisions.value = new Map(decisions.value).set(`${item.table}:${item.key}`, decision);
}

function batchDecision(table: MergeTable | 'all', decision: MergeDecision) {
  const next = new Map(decisions.value);
  const tables = table === 'all' ? TABLE_ORDER : [table];
  for (const t of tables) {
    for (const c of analysis.value!.tables[t].conflicts) {
      next.set(`${t}:${c.key}`, decision);
    }
  }
  decisions.value = next;
}

function allNewIncluded(table: MergeTable): boolean {
  return analysis.value!.tables[table].newItems.every((i) => includedNewKeys.value.has(`${table}:${i.key}`));
}

function toggleAllNew(table: MergeTable, checked: boolean) {
  const next = new Set(includedNewKeys.value);
  for (const i of analysis.value!.tables[table].newItems) {
    const k = `${table}:${i.key}`;
    if (checked) next.add(k);
    else next.delete(k);
  }
  includedNewKeys.value = next;
}

function toggleOneNew(key: string, checked: boolean) {
  const next = new Set(includedNewKeys.value);
  if (checked) next.add(key);
  else next.delete(key);
  includedNewKeys.value = next;
}

function onDecisionRadio(item: MergeConflictItem, value: unknown) {
  setDecision(item, value as MergeDecision);
}

function onToggleAllNew(table: MergeTable, value: unknown) {
  toggleAllNew(table, Boolean(value));
}

function onToggleOneNew(key: string, value: unknown) {
  toggleOneNew(key, Boolean(value));
}

function fieldConflicts(item: MergeConflictItem, fieldKey: string): boolean {
  return item.changedFields.includes(fieldKey);
}

async function rehydrateStores() {
  await Promise.all([boardStore.hydrate(), chamberStore.hydrate(), lacquerStore.hydrate(), stringingStore.hydrate()]);
}

async function handleCommit() {
  if (!analysis.value) return;
  const newSelected = includedNewKeys.value.size;
  const tryCommit = async () => {
    committing.value = true;
    try {
      const result = await commitMerge({
        analysis: analysis.value!,
        includedNewKeys: includedNewKeys.value,
        decisions: [...decisions.value].map(([conflictKey, decision]) => ({ conflictKey, decision })),
        source: source.value || fileName.value || '备份文件',
      });
      await rehydrateStores();
      const parts = [
        `新增写入 ${result.inserted} 条`,
        `采用导入 ${result.adopted} 条`,
        `保留本机 ${result.keptLocal} 条`,
      ];
      if (result.clearedStale) parts.push(`清除已消解遗留 ${result.clearedStale} 条`);
      ElMessage.success(parts.join('，'));
      if (result.unresolved > 0) {
        ElMessage.warning(`${result.unresolved} 条未裁决冲突已保留，下次可继续处理（也会随备份导出）`);
      }
      // 重新装载：有文件则基于同一文件再分析，仅看遗留；否则回到遗留视图
      await refreshLocal(false);
      fileName.value = '';
    } catch (error) {
      ElMessage.error(`提交失败：${(error as Error).message}`);
    } finally {
      committing.value = false;
    }
  };

  if (unresolvedCount.value > 0) {
    try {
      await ElMessageBox.confirm(
        `还有 ${unresolvedCount.value} 条冲突未裁决。提交后本机原记录保持不变，这些冲突会留在「待处理冲突」中，下次打开可继续处理。是否现在提交？`,
        '存在未裁决冲突',
        { confirmButtonText: '仍然提交', cancelButtonText: '返回继续裁决', type: 'warning' },
      );
    } catch {
      return;
    }
  } else {
    try {
      await ElMessageBox.confirm(
        `确认提交合并？${newSelected ? `将写入 ${newSelected} 条新增记录，` : ''}冲突裁决将生效。`,
        '提交合并',
        { confirmButtonText: '确认提交', cancelButtonText: '再看看', type: 'primary' },
      );
    } catch {
      return;
    }
  }
  await tryCommit();
}

onMounted(() => {
  void refreshLocal(false);
});
</script>

<template>
  <div v-loading="loading" class="merge-page">
    <el-alert type="info" :closable="false" show-icon class="intro">
      <template #title>
        导入对方备份做合档预览：按业务键去重（板材按板材号、槽腹按琴号、髹漆按琴号+遍次、上弦按琴号+上弦日期）。
        同键内容一致的自动跳过；不一致的进入冲突列表，本机记录不会被改动。逐条选择「保留本机 / 采用导入」后再提交；未裁决的冲突会留存并随备份导出。
      </template>
    </el-alert>

    <el-card shadow="never" class="upload-card">
      <div class="upload-row">
        <el-upload :show-file-list="false" accept="application/json,.json" :before-upload="handleFile">
          <el-button type="primary" :icon="Upload">选择对方备份 JSON</el-button>
        </el-upload>
        <el-button :icon="Refresh" @click="refreshLocal(false)">刷新本机状态</el-button>
        <span v-if="fileName" class="file-name">当前预览文件：{{ fileName }}</span>
      </div>
      <el-alert
        v-if="pendingCount > 0"
        type="warning"
        :closable="false"
        show-icon
        class="pending-tip"
        :title="`有 ${pendingCount} 条未裁决冲突待处理（来自此前的合档），在下方各表冲突区逐条决定即可。`"
      />
    </el-card>

    <template v-if="hasPreview && totals">
      <el-card shadow="never" class="summary-card">
        <el-space size="large" wrap>
          <el-tag size="large" type="primary">新增 {{ totals.newCount }}</el-tag>
          <el-tag size="large" type="info">内容一致 {{ totals.sameCount }}</el-tag>
          <el-tag size="large" type="danger">冲突 {{ totals.conflictCount }}</el-tag>
          <el-tag size="large" type="warning">未裁决 {{ unresolvedCount }}</el-tag>
          <el-tag v-if="totals.skippedCount" size="large" type="info">跳过坏行 {{ totals.skippedCount }}</el-tag>
        </el-space>
        <div class="summary-actions">
          <el-button size="small" @click="batchDecision('all', 'local')">全部冲突保留本机</el-button>
          <el-button size="small" @click="batchDecision('all', 'incoming')">全部冲突采用导入</el-button>
          <el-button type="primary" size="small" :loading="committing" :icon="CircleCheck" @click="handleCommit">提交合并</el-button>
        </div>
      </el-card>

      <el-tabs v-model="activeTable" class="merge-tabs">
        <el-tab-pane v-for="table in TABLE_ORDER" :key="table" :name="table">
          <template #label>
            <el-tag :type="badgeType(table).type" size="small" effect="plain">{{ badgeType(table).label }}</el-tag>
          </template>

          <div class="table-section" v-if="analysis">
            <!-- 冲突 -->
            <template v-if="analysis.tables[table].conflicts.length">
              <div class="section-head">
                <span class="section-title conflict-title">冲突（{{ analysis.tables[table].conflicts.length }}）</span>
                <el-button text size="small" @click="batchDecision(table, 'local')">本表全部保留本机</el-button>
                <el-button text size="small" @click="batchDecision(table, 'incoming')">本表全部采用导入</el-button>
              </div>
              <el-card v-for="item in analysis.tables[table].conflicts" :key="item.key" shadow="hover" class="conflict-card">
                <div class="conflict-head">
                  <span class="conflict-key">{{ item.keyLabel }}</span>
                  <el-tag v-if="item.pendingId" size="small" type="warning">未决留存{{ item.source ? ` · ${item.source}` : '' }}</el-tag>
                  <el-tag v-else size="small" type="danger">新冲突</el-tag>
                  <el-radio-group
                    :model-value="decisions.get(`${table}:${item.key}`) ?? ''"
                    size="small"
                    @update:model-value="(v: unknown) => onDecisionRadio(item, v)"
                  >
                    <el-radio-button value="local">保留本机</el-radio-button>
                    <el-radio-button value="incoming">采用导入</el-radio-button>
                  </el-radio-group>
                </div>
                <el-table :data="TABLE_FIELDS[table]" size="small" border class="diff-table">
                  <el-table-column label="字段" width="150">
                    <template #default="{ row }">
                      <span :class="{ 'field-hit': fieldConflicts(item, row.key) }">{{ row.label }}</span>
                    </template>
                  </el-table-column>
                  <el-table-column label="本机记录" min-width="220">
                    <template #default="{ row }">
                      <span :class="{ 'cell-diff': fieldConflicts(item, row.key) }">
                        {{ item.local ? displayValue(item.local[row.key], { date: row.date, array: row.array }) : '（本机无此记录）' }}
                      </span>
                    </template>
                  </el-table-column>
                  <el-table-column label="导入记录" min-width="220">
                    <template #default="{ row }">
                      <span :class="{ 'cell-diff': fieldConflicts(item, row.key) }">
                        {{ displayValue(item.incoming[row.key], { date: row.date, array: row.array }) }}
                      </span>
                    </template>
                  </el-table-column>
                </el-table>
              </el-card>
            </template>

            <!-- 新增 -->
            <template v-if="analysis.tables[table].newItems.length">
              <div class="section-head">
                <el-checkbox
                  :model-value="allNewIncluded(table)"
                  @update:model-value="(v: unknown) => onToggleAllNew(table, v)"
                >全选本类新增</el-checkbox>
                <span class="section-title">新增（{{ analysis.tables[table].newItems.length }}）</span>
              </div>
              <el-table :data="analysis.tables[table].newItems" size="small" border class="new-table">
                <el-table-column width="48" align="center">
                  <template #default="{ row }">
                    <el-checkbox
                      :model-value="includedNewKeys.has(`${table}:${row.key}`)"
                      @update:model-value="(v: unknown) => onToggleOneNew(`${table}:${row.key}`, v)"
                    />
                  </template>
                </el-table-column>
                <el-table-column prop="keyLabel" label="业务键" min-width="180" />
                <el-table-column
                  v-for="f in TABLE_FIELDS[table].slice(0, 4)"
                  :key="f.key"
                  :label="f.label"
                  min-width="110"
                >
                  <template #default="{ row }">
                    {{ displayValue(row.record[f.key], { date: f.date, array: f.array }) }}
                  </template>
                </el-table-column>
              </el-table>
            </template>

            <!-- 一致 -->
            <el-collapse v-if="analysis.tables[table].sameItems.length" class="same-collapse">
              <el-collapse-item :title="`内容一致，无需处理（${analysis.tables[table].sameItems.length}）`" name="same">
                <el-table :data="analysis.tables[table].sameItems" size="small" border>
                  <el-table-column prop="keyLabel" label="业务键" min-width="180" />
                  <el-table-column
                    v-for="f in TABLE_FIELDS[table].slice(0, 3)"
                    :key="f.key"
                    :label="f.label"
                    min-width="110"
                  >
                    <template #default="{ row }">
                      {{ displayValue(row.local[f.key], { date: f.date, array: f.array }) }}
                    </template>
                  </el-table-column>
                </el-table>
              </el-collapse-item>
            </el-collapse>

            <!-- 跳过 -->
            <el-alert
              v-if="analysis.tables[table].skipped.length"
              type="error"
              :closable="false"
              show-icon
              class="skip-alert"
              :title="`${analysis.tables[table].skipped.length} 条导入记录因缺少业务键或文件内重复被跳过，未参与合并`"
            />

            <el-empty
              v-if="!analysis.tables[table].conflicts.length && !analysis.tables[table].newItems.length && !analysis.tables[table].sameItems.length"
              description="本表无导入差异"
            />
          </div>
        </el-tab-pane>
      </el-tabs>
    </template>

    <el-empty v-else-if="!loading && pendingCount === 0" description="选择一份对方导出的备份 JSON，开始合档预览" />
  </div>
</template>

<style scoped>
.merge-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.intro {
  line-height: 1.7;
}
.upload-card :deep(.el-card__body) {
  padding: 14px 16px;
}
.upload-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.file-name {
  color: #7a6a58;
  font-size: 13px;
}
.pending-tip {
  margin-top: 10px;
}
.summary-card :deep(.el-card__body) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.summary-actions {
  display: flex;
  gap: 8px;
}
.merge-tabs {
  background: #fff;
  border-radius: 6px;
  padding: 8px 14px 16px;
}
.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 14px 0 8px;
}
.section-title {
  font-weight: 600;
  color: #4a3728;
}
.conflict-title {
  color: #c45656;
}
.conflict-card {
  margin-bottom: 12px;
}
.conflict-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.conflict-key {
  font-weight: 600;
  color: #4a3728;
  margin-right: auto;
}
.diff-table {
  margin-top: 4px;
}
.field-hit {
  font-weight: 600;
  color: #c45656;
}
.cell-diff {
  color: #c45656;
}
.new-table {
  margin-bottom: 8px;
}
.same-collapse {
  margin-top: 12px;
}
.skip-alert {
  margin-top: 12px;
}
</style>
