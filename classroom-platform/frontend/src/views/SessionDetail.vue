<script setup lang="ts">
/**
 * 学生端课堂详情：展示当前课堂内容与资源下载。
 * 对应建设方案 5.1「课程详情 /student/sessions/:id」。
 *
 * 文字内容取自课堂快照（lesson_content），保证历史课堂不受模板修改影响；
 * 媒体与附件取自课时正文块与资源关联。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  api,
  fileUrl,
  type CurrentSession,
  type LessonBlock,
  type LessonResource,
} from '@/api'
import { formatBytes, sessionStatusText } from '@/utils/format'

const props = defineProps<{ id: string }>()
const router = useRouter()

const view = ref<CurrentSession | null>(null)
const blocks = ref<LessonBlock[]>([])
const resources = ref<LessonResource[]>([])
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

/** 快照中的结构化文字内容 */
const textBlocks = computed(() => {
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

/** 附件（非图片、非视频） */
const attachments = computed(() => resources.value.filter((r) => r.purpose === 'attachment'))

async function load() {
  try {
    view.value = await api.session(sessionId.value)

    // 课堂快照只含文字内容；媒体与附件需按课时读取。
    const detail = await api.lesson(view.value.session.lesson_id)
    blocks.value = detail.blocks
    resources.value = detail.resources
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

function download(resource: LessonResource) {
  window.open(fileUrl(resource.id), '_blank')
}

function downloadAll() {
  for (const resource of attachments.value) download(resource)
}

/** 模板中不能直接访问全局 window，因此包一层 */
function openFile(resourceId: number | null) {
  if (resourceId === null) return
  window.open(fileUrl(resourceId), '_blank')
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

      <!--
        富文本正文优先（课堂快照中保存的已清洗 HTML）；
        旧课堂快照没有 html 字段时回退到结构化文字。
      -->
      <div v-if="view.lesson_html" class="card">
        <div class="rich-content" v-html="view.lesson_html" />
      </div>

      <!-- 快照文字内容 -->
      <div v-else-if="textBlocks.length > 0" class="card">
        <div v-for="block in textBlocks" :key="block.key" class="lesson-block">
          <div class="lesson-block__title">{{ block.label }}</div>
          <div class="lesson-block__text">{{ block.text }}</div>
        </div>
      </div>

      <!-- 正文块：文字与媒体按顺序展示 -->
      <div v-if="blocks.length > 0" class="card">
        <div v-for="block in blocks" :key="block.id" class="content-block">
          <template v-if="block.block_type === 'text'">
            <div v-if="block.title" class="lesson-block__title">{{ block.title }}</div>
            <div class="lesson-block__text">{{ block.text_content }}</div>
          </template>

          <template v-else-if="block.block_type === 'image'">
            <div v-if="block.title" class="lesson-block__title">{{ block.title }}</div>
            <img
              v-if="block.resource_id"
              :src="fileUrl(block.resource_id)"
              :alt="block.title || '课时图片'"
              class="content-image"
              loading="lazy"
            />
            <el-button
              v-if="block.resource_id"
              link
              size="small"
              @click="openFile(block.resource_id)"
            >
              查看原图
            </el-button>
          </template>

          <template v-else-if="block.block_type === 'video'">
            <div v-if="block.title" class="lesson-block__title">{{ block.title }}</div>
            <video
              v-if="block.resource_id"
              :src="fileUrl(block.resource_id)"
              controls
              preload="metadata"
              class="content-video"
            />
          </template>

          <template v-else>
            <div class="lesson-block__title">{{ block.title || block.resource_name }}</div>
            <el-button
              v-if="block.resource_id"
              size="small"
              type="primary"
              plain
              @click="openFile(block.resource_id)"
            >
              下载文件
            </el-button>
          </template>
        </div>
      </div>

      <!-- 附件下载 -->
      <template v-if="attachments.length > 0">
        <h2 class="section-title">
          课时附件
          <el-button size="small" @click="downloadAll">全部下载</el-button>
        </h2>
        <div class="card">
          <div v-for="resource in attachments" :key="resource.id" class="resource-item">
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

      <div
        v-if="
          !view.lesson_html &&
          textBlocks.length === 0 &&
          blocks.length === 0 &&
          attachments.length === 0
        "
        class="card empty-state"
      >
        本节课暂无内容。
      </div>
    </template>

    <div v-else class="card empty-state">课堂不存在或已被删除。</div>
  </div>
</template>

<style scoped>
.content-block {
  margin-bottom: 18px;
}

.content-block:last-child {
  margin-bottom: 0;
}

.content-image {
  max-width: 100%;
  max-height: 520px;
  border-radius: 8px;
  display: block;
  margin: 6px 0;
}

.content-video {
  width: 100%;
  max-height: 520px;
  border-radius: 8px;
  background: #000;
  display: block;
  margin: 6px 0;
}
</style>
