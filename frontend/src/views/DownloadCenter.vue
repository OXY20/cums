<script setup lang="ts">
/**
 * 下载中心：展示已下载记录与下载状态。
 *
 * 浏览器无法可靠获取任意本地目录或跨会话保留下载进度，
 * 因此本页只记录本次会话内发起的下载，并明确说明这一边界。
 */
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, fileUrl, type Resource } from '@/api'
import { formatBytes, resourceStatusText } from '@/utils/format'

interface DownloadRecord {
  resource: Resource
  startedAt: number
  state: 'downloading' | 'done'
}

const records = ref<DownloadRecord[]>([])
const resources = ref<Resource[]>([])

onMounted(async () => {
  try {
    resources.value = (await api.resources()).items
  } catch {
    // 未登录时资源列表不可用，保留空列表
    resources.value = []
  }
})

function start(resource: Resource) {
  const record: DownloadRecord = { resource, startedAt: Date.now(), state: 'downloading' }
  records.value.unshift(record)
  window.open(fileUrl(resource.id), '_blank')

  // 浏览器不暴露下载完成事件，这里按发起后短延时标记为已完成。
  window.setTimeout(() => {
    record.state = 'done'
  }, 1500)

  ElMessage.success(`已开始下载：${resource.name}`)
}

function clearRecords() {
  records.value = []
}
</script>

<template>
  <div class="page">
    <h1 class="page-title">下载中心</h1>
    <p class="page-subtitle">
      浏览器不允许网页直接指定本地保存目录，也不保证页面关闭后自动续传；如需可靠续传与固定目录，后续可使用 Windows 辅助客户端。
    </p>

    <h2 class="section-title">
      本次会话的下载记录
      <el-button v-if="records.length > 0" size="small" @click="clearRecords">清空</el-button>
    </h2>

    <div class="card">
      <div v-if="records.length === 0" class="empty-state">尚未发起下载。</div>
      <div v-for="(record, index) in records" :key="index" class="resource-item">
        <span class="resource-item__name">{{ record.resource.name }}</span>
        <span class="resource-item__size">{{ formatBytes(record.resource.size_bytes) }}</span>
        <el-tag :type="record.state === 'done' ? 'success' : 'warning'" size="small">
          {{ record.state === 'done' ? '已发起' : '下载中' }}
        </el-tag>
      </div>
    </div>

    <h2 class="section-title">可用资源</h2>

    <div class="card">
      <div v-if="resources.length === 0" class="empty-state">暂无可下载资源。</div>
      <div v-for="resource in resources" :key="resource.id" class="resource-item">
        <span class="resource-item__name">{{ resource.name }}</span>
        <span class="resource-item__size">{{ formatBytes(resource.size_bytes) }}</span>
        <el-tag
          size="small"
          :type="resource.status === 'ready' ? 'success' : 'info'"
        >
          {{ resourceStatusText(resource.status) }}
        </el-tag>
        <el-button
          size="small"
          type="primary"
          plain
          :disabled="resource.status !== 'ready'"
          @click="start(resource)"
        >
          下载
        </el-button>
      </div>
    </div>
  </div>
</template>
