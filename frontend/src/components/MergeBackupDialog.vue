<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { UploadFilled } from '@element-plus/icons-vue';
import { parseBackupText, type BackupPayload } from '../utils/export';
import {
  commitMerge,
  dayOf,
  diffFields,
  formatFieldValue,
  loadLocalIndex,
  mergeIncomingPending,
  previewBackup,
  sameContent,
  setConflictResolution,
  upsertConflicts,
} from '../utils/merge';
import { MERGE_FIELDS, MERGE_TABLE_LABELS, type FieldMeta, type MergeEntry, type MergeTable, type PendingConflict } from '../types/merge';
import { useBoardStore } from '../stores/boardStore';
import { useChamberStore } from '../stores/chamberStore';
import { useLacquerStore } from '../stores/lacquerStore';
import { useStringingStore } from '../stores/stringingStore';
import { db } from '../utils/db';

const emit = defineEmits<{ (e: 'committed'): void }>();

const boardStore = useBoardStore();
const chamberStore = useChamberStore();
const lacquerStore = useLacquerStore();
const stringingStore = useStringingStore();

const visible = defineModel<boolean>('visible', { required: true });
const fileInput = ref<HTMLInputElement | null>(null);

const loaded = ref<{ file: string; payload: BackupPayload } | null>(null);
/** 本次载入备份生成的预览项（add/identical/conflict 全量，内存态） */
const previewEntries = ref<MergeEntry[]>([]);
/** 冲突队列（持久态），打开弹窗时与每次操作后刷新 */
const pending = ref<PendingConflict[]>([]);
const activeFilter = ref<'all' | 'add' | 'conflict' | 'identical'>('all');
const activeTable = ref<MergeTable | 'all'>('all');
const expanded = ref<Set<string>>(new Set());
const submitting = ref(false);
const loading = ref(false);
const incomingPendingAdded = ref(0);

const TABLE_ORDER: MergeTable[] = ['boards', 'chambers', 'lacquers', 'stringings'];

onMounted(refreshPending);

// 每次打开弹窗都刷新队列（可能在别处处理过、或刚从备份并入）
watch(visible, (open) => {
  if (open) void refreshPending();
});

/** 列表 = 队列项（实时结合本机记录）+ 本次预览中非队列项；冲突以队列为准 */
const allRows = computed<MergeEntry[]>(() => {
  const queueIds = new Set(pending.value.map((p) => p.id));
  const fromQueue: MergeEntry[] = pending.value.map((p) => {
    const local = findLocalSync(p.table, p.mergeKey);
    return {
      rowId: p.id,
      table: p.table,
      keyLabel: p.keyLabel,
      keyParts: p.keyParts,
      status: local ? (sameAs(p, local) ? 'identical' : 'conflict') : 'add',
      resolution: p.resolution,
      local: local ?? p.local,
      incoming: p.incoming,
      sourceFile: p.sourceFile,
      exportedAt: p.exportedAt,
    };
  });
  const fromPreview = previewEntries.value.filter((e) => !queueIds.has(e.rowId));
  return [...fromQueue, ...fromPreview];
});

const rows = computed<MergeEntry[]>(() =>
  allRows.value.filter((e) => {
    if (activeTable.value !== 'all' && e.table !== activeTable.value) return false;
    if (activeFilter.value === 'all') return e.status !== 'invalid';
    return e.status === activeFilter.value;
  }),
);

const invalidRows = computed<MergeEntry[]>(() =>
  previewEntries.value.filter((e) => e.status === 'invalid' && (activeTable.value === 'all' || e.table === activeTable.value)),
);

/** 队列冲突里尚未决议的数量（徽标用） */
const unresolvedCount = computed(() => pending.value.filter((p) => p.resolution === 'pending').length);
const resolvedCount = computed(() => pending.value.length - unresolvedCount.value);

const stats = computed(() => {
  const count = (status: MergeEntry['status']) => allRows.value.filter((e) => e.status === status).length;
  return {
    add: count('add'),
    identical: count('identical'),
    conflict: count('conflict'),
    invalid: count('invalid'),
    unresolved: unresolvedCount.value,
    resolved: resolvedCount.value,
  };
});

function findLocalSync(table: MergeTable, key: string): Record<string, unknown> | undefined {
  const storeRows =
    table === 'boards' ? boardStore.boards
    : table === 'chambers' ? chamberStore.chambers
    : table === 'lacquers' ? lacquerStore.layers
    : stringingStore.stringings;
  for (const raw of storeRows as unknown as Record<string, unknown>[]) {
    if (table === 'boards' && String(raw.boardNo ?? '').trim() === key) return raw;
    if (table === 'chambers' && String(raw.guqinNo ?? '').trim() === key) return raw;
    if (table === 'lacquers') {
      const [guqinNo, seq] = key.split('#');
      if (String(raw.guqinNo ?? '').trim() === guqinNo && Number(raw.seq) === Number(seq)) return raw;
    }
    if (table === 'stringings') {
      const [guqinNo, day] = key.split('@');
      if (String(raw.guqinNo ?? '').trim() === guqinNo && dayOf(raw.strungAt) === day) return raw;
    }
  }
  return undefined;
}

function sameAs(p: PendingConflict, local: Record<string, unknown>): boolean {
  return sameContent(p.table, local, p.incoming as Record<string, unknown>);
}

async function refreshPending() {
  pending.value = await db.mergeQueue.orderBy('queuedAt').toArray();
}

async function openPicker() {
  fileInput.value?.click();
}

async function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  loading.value = true;
  try {
    const text = await file.text();
    const payload = parseBackupText(text);

    // 先并入备份携带的未处理冲突（幂等），再生成预览
    incomingPendingAdded.value = await mergeIncomingPending(payload);
    const localIndex = await loadLocalIndex();
    const preview = previewBackup(payload, file.name, localIndex);
    await upsertConflicts(preview.entries);

    loaded.value = { file: file.name, payload };
    previewEntries.value = preview.entries;
    await refreshPending();
    activeFilter.value = 'all';
    expanded.value = new Set();

    const c = preview.entries.filter((e) => e.status === 'conflict').length;
    const a = preview.entries.filter((e) => e.status === 'add').length;
    ElMessage.success(`预览完成：新增 ${a} 条、冲突 ${c} 条；本机记录尚未改动`);
  } catch (error) {
    ElMessage.error(`备份解析失败：${(error as Error).message}`);
  } finally {
    loading.value = false;
  }
}

async function chooseResolution(entry: MergeEntry, resolution: 'local' | 'imported') {
  await setConflictResolution(entry.rowId, resolution);
  await refreshPending();
}

async function clearResolution(entry: MergeEntry) {
  // 恢复为未处理：把决议改回 pending（直接写队列）
  await setConflictResolutionPending(entry.rowId);
  await refreshPending();
}

async function setConflictResolutionPending(id: string) {
  const existed = await db.mergeQueue.get(id);
  if (existed) await db.mergeQueue.put({ ...existed, resolution: 'pending' });
}

function toggleExpand(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function diffList(entry: MergeEntry) {
  if (!entry.local || !entry.incoming) return [];
  return diffFields(entry.table, entry.local, entry.incoming);
}

function fieldValue(entry: MergeEntry, meta: FieldMeta, side: 'local' | 'incoming'): string {
  const row = side === 'local' ? entry.local : entry.incoming;
  return formatFieldValue(meta, row?.[meta.key]);
}

async function submit() {
  const left = unresolvedCount.value;
  try {
    if (left > 0) {
      await ElMessageBox.confirm(
        `还有 ${left} 条冲突未决定。提交后这些冲突将原样保留在本机并随下次导出备份带走，确定现在提交吗？`,
        '存在未处理冲突',
        { type: 'warning', confirmButtonText: '提交并保留未处理冲突', cancelButtonText: '继续逐条处理' },
      );
    } else {
      await ElMessageBox.confirm('确认按以上预览与逐条决议提交合并？本机同键记录将按决议覆盖。', '提交合并', {
        type: 'info',
        confirmButtonText: '确认提交',
      });
    }
  } catch {
    return;
  }

  submitting.value = true;
  try {
    const result = await commitMerge(previewEntries.value);
    await Promise.all([boardStore.hydrate(), chamberStore.hydrate(), lacquerStore.hydrate(), stringingStore.hydrate()]);
    await refreshPending();
    // 清掉本次内存预览；遗留冲突已在队列中展示
    previewEntries.value = [];
    loaded.value = null;
    emit('committed');
    ElMessage.success(
      `合并已提交：新增 ${result.added} 条、采用导入覆盖 ${result.updated} 条、保留本机 ${result.keptLocal} 条` +
        (result.autoCleared ? `、差异已消失 ${result.autoCleared} 条` : '') +
        (result.conflictLeft ? `；剩余 ${result.conflictLeft} 条冲突留待下次` : ''),
    );
  } catch (error) {
    ElMessage.error(`合并提交失败（本机记录未改动）：${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
}

const TABLE_TAG_TYPE: Record<MergeTable, 'primary' | 'success' | 'warning' | 'danger'> = {
  boards: 'primary',
  chambers: 'success',
  lacquers: 'warning',
  stringings: 'danger',
};
</script>

<template>
  <el-dialog v-model="visible" title="合并对方备份（预览后提交）" width="920px" top="6vh" :close-on-click-modal="false">
    <el-alert type="info" :closable="false" show-icon class="merge-tip">
      <template #title>
        合并不会清空本机：板材按板材号、槽腹按琴号、髹漆按琴号+遍次、上弦按琴号+上弦日期比对；
        同键不同内容进入冲突列表，由你逐条决定「保留本机 / 采用导入」，提交才写库；未处理的冲突保留并随备份导出。
      </template>
    </el-alert>

    <div class="merge-toolbar">
      <input ref="fileInput" type="file" accept="application/json,.json" style="display: none" @change="onFileChosen" />
      <el-button type="primary" :icon="UploadFilled" :loading="loading" @click="openPicker">选择对方备份 JSON</el-button>
      <el-tag v-if="loaded" type="info" size="large">{{ loaded.file }}</el-tag>
      <el-tag v-if="incomingPendingAdded" type="warning" size="large">备份另带 {{ incomingPendingAdded }} 条未处理冲突</el-tag>
      <el-tag v-if="unresolvedCount" type="danger" size="large">本机待处理冲突 {{ unresolvedCount }} 条</el-tag>
    </div>

    <div class="merge-stats">
      <el-radio-group v-model="activeFilter" size="small">
        <el-radio-button label="all">全部</el-radio-button>
        <el-radio-button label="add">新增（{{ stats.add }}）</el-radio-button>
        <el-radio-button label="conflict">冲突（{{ stats.conflict }}，待处理 {{ stats.unresolved }}）</el-radio-button>
        <el-radio-button label="identical">内容一致（{{ stats.identical }}）</el-radio-button>
      </el-radio-group>
      <el-select v-model="activeTable" size="small" style="width: 130px">
        <el-option label="全部工序" value="all" />
        <el-option v-for="t in TABLE_ORDER" :key="t" :label="MERGE_TABLE_LABELS[t]" :value="t" />
      </el-select>
    </div>

    <el-empty v-if="rows.length === 0 && invalidRows.length === 0" :image-size="70" description="请选择一份对方导出的备份 JSON 开始预览；本机记录在提交前不会被改动" />

    <el-alert v-if="invalidRows.length" type="warning" :closable="false" show-icon class="merge-invalid">
      <template #title>
        {{ invalidRows.length }} 条记录缺少业务键或在备份内重复，已跳过不参与合并：
        {{ invalidRows.map((r) => `${MERGE_TABLE_LABELS[r.table]} ${r.keyLabel}（${r.reason ?? '无效'}）`).join('；') }}
      </template>
    </el-alert>

    <div v-else class="merge-list">
      <div v-for="entry in rows" :key="entry.rowId" class="merge-row" :class="{ 'is-pending-conflict': entry.status === 'conflict' && entry.resolution === 'pending' }">
        <div class="merge-row-head">
          <el-tag :type="TABLE_TAG_TYPE[entry.table]" size="small">{{ MERGE_TABLE_LABELS[entry.table] }}</el-tag>
          <span class="merge-key">{{ entry.keyLabel }}</span>
          <el-tag v-if="entry.status === 'add'" type="success" size="small">新增</el-tag>
          <el-tag v-else-if="entry.status === 'identical'" type="info" size="small">内容一致</el-tag>
          <el-tag v-else type="danger" size="small">冲突</el-tag>
          <el-tag v-if="entry.resolution === 'local'" type="warning" size="small">决定：保留本机</el-tag>
          <el-tag v-if="entry.resolution === 'imported'" type="primary" size="small">决定：采用导入</el-tag>
          <span v-if="entry.sourceFile" class="merge-source">来自 {{ entry.sourceFile }}</span>
          <span class="merge-spacer" />
          <el-button v-if="entry.status !== 'identical'" link type="primary" size="small" @click="toggleExpand(entry.rowId)">
            {{ expanded.has(entry.rowId) ? '收起对照' : '展开对照' }}
          </el-button>
        </div>

        <div v-if="expanded.has(entry.rowId) && entry.status === 'add' && entry.incoming" class="merge-detail">
          <el-descriptions :column="2" size="small" border>
            <el-descriptions-item v-for="f in MERGE_FIELDS[entry.table]" :key="f.key" :label="f.label">
              {{ fieldValue(entry, f, 'incoming') }}
            </el-descriptions-item>
          </el-descriptions>
        </div>

        <div v-if="expanded.has(entry.rowId) && entry.local && entry.incoming" class="merge-detail">
          <el-table :data="diffList(entry)" size="small" border>
            <el-table-column prop="label" label="不一致字段" width="150" />
            <el-table-column label="本机记录">
              <template #default="scope">
                <span class="cell-local">{{ fieldValue(entry, scope.row, 'local') }}</span>
              </template>
            </el-table-column>
            <el-table-column label="导入记录">
              <template #default="scope">
                <span class="cell-incoming">{{ fieldValue(entry, scope.row, 'incoming') }}</span>
              </template>
            </el-table-column>
          </el-table>
          <el-table v-if="diffList(entry).length === 0" :data="[]" size="small">
            <template #empty>内容已一致，提交时自动消项</template>
          </el-table>
        </div>

        <div v-if="entry.status === 'conflict'" class="merge-actions">
          <el-radio-group
            :model-value="entry.resolution === 'pending' ? '' : entry.resolution"
            size="small"
            @change="(v: 'local' | 'imported') => chooseResolution(entry, v)"
          >
            <el-radio-button label="local">保留本机</el-radio-button>
            <el-radio-button label="imported">采用导入</el-radio-button>
          </el-radio-group>
          <el-button v-if="entry.resolution !== 'pending'" link type="info" size="small" @click="clearResolution(entry)">
            改回未处理（留到下次）
          </el-button>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">关闭（未处理冲突已保留）</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">
        提交合并{{ unresolvedCount ? `（仍有 ${unresolvedCount} 条未处理）` : '' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.merge-tip {
  margin-bottom: 12px;
}
.merge-invalid {
  margin-bottom: 10px;
}
.merge-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.merge-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.merge-list {
  max-height: 52vh;
  overflow-y: auto;
  border: 1px solid #ece0cf;
  border-radius: 8px;
  padding: 6px;
}
.merge-row {
  border: 1px solid #f0e6d8;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 6px;
  background: #fff;
}
.merge-row.is-pending-conflict {
  border-color: #f5c6a0;
  background: #fff9f2;
}
.merge-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.merge-key {
  font-weight: 600;
  color: #4a3728;
}
.merge-source {
  color: #a3968a;
  font-size: 12px;
}
.merge-spacer {
  flex: 1;
}
.merge-detail {
  margin-top: 8px;
}
.merge-actions {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.cell-local {
  color: #a86414;
}
.cell-incoming {
  color: #1d5fa8;
}
</style>
