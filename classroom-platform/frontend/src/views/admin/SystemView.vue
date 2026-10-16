<script setup lang="ts">
/**
 * 系统状态：服务健康、存储占用与审计日志。
 * 对应建设方案 5.2「系统状态」与 4.5「运行监控」。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, type Health } from '@/api'
import { formatBytes, formatDuration, formatTime } from '@/utils/format'

interface AuditLog {
  id: number
  user_id: number | null
  action: string
  target_type: string
  target_id: string
  created_at: string
}

const health = ref<Health | null>(null)
const logs = ref<AuditLog[]>([])
const loading = ref(true)
let timer: number | undefined

onMounted(async () => {
  await refresh()
  timer = window.setInterval(refresh, 20000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})

async function refresh() {
  try {
    health.value = await api.health()
    logs.value = (await api.auditLogs()).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '状态加载失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div>
    <h1 class="page-title">系统状态</h1>
    <p class="page-subtitle">监控数据以低开销方式采集，不进行高频数据库写入。</p>

    <div v-if="health" class="stat-grid">
      <div class="card stat-card">
        <div class="stat-card__label">服务状态</div>
        <div class="stat-card__value" :class="{ 'stat-card__value--warn': health.status !== 'ok' }">
          {{ health.status === 'ok' ? '正常' : '异常' }}
        </div>
      </div>

      <div class="card stat-card">
        <div class="stat-card__label">数据库</div>
        <div class="stat-card__value">{{ health.database === 'ok' ? '正常' : '异常' }}</div>
      </div>

      <div class="card stat-card">
        <div class="stat-card__label">活动课堂</div>
        <div class="stat-card__value">{{ health.active_sessions }}</div>
      </div>

      <div class="card stat-card">
        <div class="stat-card__label">进行中下载</div>
        <div class="stat-card__value">{{ health.active_downloads }}</div>
      </div>

      <div class="card stat-card">
        <div class="stat-card__label">资源占用</div>
        <div class="stat-card__value">{{ formatBytes(health.objects_bytes) }}</div>
      </div>

      <div class="card stat-card">
        <div class="stat-card__label">运行时长</div>
        <div class="stat-card__value">{{ formatDuration(health.uptime_seconds) }}</div>
      </div>
    </div>

    <h2 class="section-title">审计日志</h2>
    <div class="card">
      <el-table v-loading="loading" :data="logs" size="small" empty-text="暂无审计记录">
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="action" label="操作" min-width="180" />
        <el-table-column prop="target_type" label="对象类型" width="120" />
        <el-table-column prop="target_id" label="对象 ID" width="110" />
        <el-table-column prop="user_id" label="用户 ID" width="100" />
        <el-table-column label="时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 14px;
}

.stat-card {
  padding: 14px 16px;
}

.stat-card__label {
  color: var(--text-sub);
  font-size: 13px;
  margin-bottom: 4px;
}

.stat-card__value {
  font-size: 22px;
  font-weight: 600;
}

.stat-card__value--warn {
  color: #d03050;
}
</style>
