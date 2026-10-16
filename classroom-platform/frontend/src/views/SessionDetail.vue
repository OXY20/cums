<script setup lang="ts">
/**
 * 学生端课堂详情：展示当前课堂内容与资源下载。
 * 对应建设方案 5.1「课程详情 /student/sessions/:id」。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, fileUrl, type CurrentSession, type Resource } from '@/api'
import { formatBytes, sessionStatusText } from '@/utils/format'

const props = defineProps<{ id: string }>()
const router = useRouter()

const view = ref<CurrentSession | null>(null)
const resources = ref<Resource[]>([])
const loading = ref(true)
let timer: number | undefined

const sessionId = computed(() => Number(props.id))

const BLOCK_LABELS: Record<string, string> = {
  goal: '学习目标',
  intro: '教学说明',
  steps: '操作步骤',
  notes: '注意事项',
  task: '练习任务',
  criteria: '完成标准',
}

/** 解析快照中的结构化内容 */
const blocks = computed(() => {
  const content = view.value?.lesson_content
  if (!content) return []
  return Object.entries(content)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => ({
      key,
      label: BLOCK_LABELS[key] ?? key,
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }))
})

async function load() {
  try {
    view.value = await api.session(sessionId.value)
    resources.value = (await api.lessonResources(view.value.session.lesson_id)).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '课堂加载失败')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  // 课堂状态可能变化，定期刷新
  timer = window.setInterval(load, 30000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})

function download(resource: Resource) {
  window.open(fileUrl(resource.id), '_blank')
}

function downloadAll() {
  for (const resource of resources.value) download(resource)
}

function statusText(status: string) {
  return sessionStatusText(status)
}
</script>

<template>
  <div class="page">
    <el-button link @click="router.push('/student')">← 返回首页</el-button>

    <div v-if="loading" class="card empty-state">正在加载课堂…</div>

    <template v-else-if="view">
      <h1 class="page-title">
        {{ view.course_title }} · {{ view.lesson_title }}
        <span class="status-tag" :class="`status-tag--${view.session.status}`">
          {{ statusText(view.session.status) }}
        </span>
      </h1>
      <p class="page-subtitle">
        班级：{{ view.class_name }} ｜ 教师：{{ view.teacher_name }} ｜ 开始时间：{{
          view.session.started_at
        }}
      </p>

      <div class="card">
        <div v-if="blocks.length === 0" class="empty-state">本节课暂无结构化内容。</div>
        <div v-for="block in blocks" :key="block.key" class="lesson-block">
          <div class="lesson-block__title">{{ block.label }}</div>
          <div class="lesson-block__text">{{ block.text }}</div>
        </div>
      </div>

      <h2 class="section-title">
        相关资源
        <el-button v-if="resources.length > 0" size="small" @click="downloadAll">
          下载全部
        </el-button>
      </h2>

      <div class="card">
        <div v-if="resources.length === 0" class="empty-state">本节课暂无关联资源。</div>
        <div v-for="resource in resources" :key="resource.id" class="resource-item">
          <span class="resource-item__name">{{ resource.name }}</span>
          <span class="resource-item__size">{{ formatBytes(resource.size_bytes) }}</span>
          <el-button
            size="small"
            type="primary"
            plain
            :disabled="resource.status !== 'ready'"
            @click="download(resource)"
          >
            下载
          </el-button>
        </div>
      </div>
    </template>

    <div v-else class="card empty-state">课堂不存在或已被删除。</div>
  </div>
</template>
