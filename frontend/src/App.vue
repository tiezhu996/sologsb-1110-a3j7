<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Download, Upload } from '@element-plus/icons-vue';
import { seedIfEmpty } from './utils/seed';
import { downloadText, exportBackupJson } from './utils/export';
import { db } from './utils/db';
import { useBoardStore } from './stores/boardStore';
import { useChamberStore } from './stores/chamberStore';
import { useLacquerStore } from './stores/lacquerStore';
import { useStringingStore } from './stores/stringingStore';
import MergeBackupDialog from './components/MergeBackupDialog.vue';

const route = useRoute();
const boardStore = useBoardStore();
const chamberStore = useChamberStore();
const lacquerStore = useLacquerStore();
const stringingStore = useStringingStore();
const ready = ref(false);
const mergeVisible = ref(false);
const pendingConflictCount = ref(0);

async function refreshPendingCount() {
  pendingConflictCount.value = await db.mergeQueue.where('resolution').equals('pending').count();
}

onMounted(async () => {
  try {
    await seedIfEmpty();
    await Promise.all([boardStore.hydrate(), chamberStore.hydrate(), lacquerStore.hydrate(), stringingStore.hydrate()]);
    await refreshPendingCount();
  } catch (error) {
    ElMessage.error(`本地数据装载失败：${(error as Error).message}`);
  } finally {
    ready.value = true;
  }
});

async function handleExport() {
  const json = await exportBackupJson();
  downloadText(`gbguqin-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
  ElMessage.success(
    pendingConflictCount.value > 0
      ? `已导出全量 JSON 备份（含 ${pendingConflictCount.value} 条未处理冲突）`
      : '已导出 IndexedDB 全量 JSON 备份',
  );
}
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="208px" class="app-aside">
      <div class="brand">
        <div class="brand-title">古琴斫制工序记录台</div>
        <div class="brand-sub">gbguqin · 纯前端本地存储</div>
      </div>
      <el-menu :default-active="route.path" router class="app-menu" background-color="#4a3728" text-color="#f0e6d8" active-text-color="#ffd591">
        <el-menu-item index="/">琴坯进度</el-menu-item>
        <el-menu-item index="/boards">板材登记</el-menu-item>
        <el-menu-item index="/chambers">槽腹尺寸</el-menu-item>
        <el-menu-item index="/lacquer">灰胎髹漆</el-menu-item>
        <el-menu-item index="/stringing">上弦评价</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="app-header">
        <span class="header-title">{{ (route.meta?.title as string) ?? '古琴斫制工序记录台' }}</span>
        <span class="header-actions">
          <el-badge :hidden="pendingConflictCount === 0" :value="pendingConflictCount" class="merge-badge">
            <el-button :icon="Upload" @click="mergeVisible = true">
              合并备份{{ pendingConflictCount > 0 ? `（${pendingConflictCount} 条冲突待处理）` : '' }}
            </el-button>
          </el-badge>
          <el-button :icon="Download" @click="handleExport">导出备份</el-button>
        </span>
      </el-header>
      <el-main v-loading="!ready" element-loading-text="正在装载本地工序档案…" class="app-main">
        <router-view />
      </el-main>
      <el-footer class="app-footer">数据保存在浏览器 IndexedDB（gbguqin-db），不依赖后端服务</el-footer>
    </el-container>
  </el-container>

  <MergeBackupDialog v-model:visible="mergeVisible" @committed="refreshPendingCount" />
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
}
.app-aside {
  background: #4a3728;
  color: #f0e6d8;
}
.brand {
  padding: 16px 16px 8px;
}
.brand-title {
  font-size: 15px;
  font-weight: 600;
}
.brand-sub {
  font-size: 12px;
  color: #cbb79f;
}
.app-menu {
  border-right: none;
}
.app-header {
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid #ece0cf;
}
.header-title {
  font-weight: 600;
  color: #4a3728;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.merge-badge {
  margin-right: 2px;
}
.app-main {
  background: #f7f3ed;
  min-height: 60vh;
}
.app-footer {
  text-align: center;
  color: #a3968a;
  font-size: 12px;
  line-height: 48px;
}
</style>
