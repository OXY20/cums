<script setup lang="ts">
/**
 * 资源库：上传、登记、校验信息查看与删除。
 *
 * 上传流程遵循建设方案 6.2 与 9.2：先登记元数据，再上传内容，
 * 服务端写入临时目录并在 SHA-256 校验通过后发布到 objects。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, fileUrl, type Resource } from '@/api'
import { formatBytes, formatTime, resourceStatusText } from '@/utils/format'

const resources = ref<Resource[]>([])
const loading = ref(true)
const uploading = ref(false)
const progress = ref(0)

/** 同名文件按内容去重提示：同一 sha256 视为重复内容 */
const duplicateHint = ref('')

const readyCount = computed(() => resources.value.filter((r) => r.status === 'ready').length)
const totalBytes = computed(() =>
  resources.value.filter((r) => r.status === 'ready').reduce((sum, r) => sum + r.size_bytes, 0),
)

onMounted(load)

async function load() {
  loading.value = true
  try {
    resources.value = (await api.resources()).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '资源加载失败')
  } finally {
    loading.value = false
  }
}

/** 计算文件 SHA-256；大文件分块读取，避免一次性载入内存 */
async function computeSha256(file: File): Promise<string> {
  const chunkSize = 8 * 1024 * 1024
  const chunks: ArrayBuffer[] = []

  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const slice = file.slice(offset, Math.min(offset + chunkSize, file.size))
    chunks.push(await slice.arrayBuffer())
  }

  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  const merged = new Uint8Array(total)
  let position = 0
  for (const chunk of chunks) {
    merged.set(new Uint8Array(chunk), position)
    position += chunk.byteLength
  }

  const digest = await crypto.subtle.digest('SHA-256', merged)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function handleFile(file: File) {
  uploading.value = true
  progress.value = 0
  duplicateHint.value = ''

  try {
    const sha256 = await computeSha256(file)

    // 相同内容已存在时提示复用，避免重复占用磁盘
    const existing = resources.value.find((r) => r.sha256 === sha256 && r.status === 'ready')
    if (existing) {
      duplicateHint.value = `检测到相同内容已存在：${existing.name}（可直接关联到课时，无需重复上传）`
    }

    const registered = await api.registerResource({
      name: file.name,
      size_bytes: file.size,
      sha256,
    })

    const result = await api.uploadResource(registered.resource_id, file, (info) => {
      progress.value = info.percent
    })

    ElMessage.success(`上传完成：${result.name}`)
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '上传失败')
  } finally {
    uploading.value = false
    progress.value = 0
  }
}

/** el-upload 自定义上传：交由 handleFile 处理 */
function customUpload(options: { file: File }) {
  handleFile(options.file)
}

/** 模板中不能直接访问全局 window，因此包一层 */
function download(resource: Resource) {
  window.open(fileUrl(resource.id), '_blank')
}

async function remove(resource: Resource) {
  try {
    await ElMessageBox.confirm(
      `确认删除资源「${resource.name}」？服务器上的文件也会一并删除。`,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  try {
    await api.deleteResource(resource.id)
    ElMessage.success('资源已删除')
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}
</script>

<template>
  <div>
    <h1 class="page-title">资源库</h1>
    <p class="page-subtitle">
      资源文件与数据库分离存储；上传时先写入临时目录，SHA-256 校验通过后才正式发布。
    </p>

    <div class="card">
      <el-upload
        drag
        :show-file-list="false"
        :http-request="customUpload"
        :disabled="uploading"
        style="width: 100%"
      >
        <div style="padding: 20px">
          <p style="margin: 0 0 6px; font-size: 15px">将文件拖到此处，或点击选择</p>
          <p style="margin: 0; color: var(--text-sub); font-size: 12px">
            支持视频、图片、文档与压缩包等大文件；单文件上限由服务端配置决定。
          </p>
        </div>
      </el-upload>

      <el-progress
        v-if="uploading"
        :percentage="progress"
        :stroke-width="10"
        style="margin-top: 14px"
      />

      <el-alert
        v-if="duplicateHint"
        :title="duplicateHint"
        type="info"
        show-icon
        :closable="false"
        style="margin-top: 12px"
      />
    </div>

    <div class="card" style="display: flex; gap: 28px">
      <span>资源总数：<strong>{{ resources.length }}</strong></span>
      <span>可用：<strong>{{ readyCount }}</strong></span>
      <span>占用空间：<strong>{{ formatBytes(totalBytes) }}</strong></span>
    </div>

    <div class="card">
      <el-table v-loading="loading" :data="resources" empty-text="暂无资源">
        <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip />
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ formatBytes(row.size_bytes) }}</template>
        </el-table-column>
        <el-table-column label="SHA-256" width="150">
          <template #default="{ row }">
            <span style="font-family: monospace; font-size: 12px">
              {{ row.sha256 ? row.sha256.slice(0, 12) + '…' : '—' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'ready' ? 'success' : 'warning'">
              {{ resourceStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="上传时间" width="170">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              :disabled="row.status !== 'ready'"
              @click="download(row)"
            >
              下载
            </el-button>
            <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>
