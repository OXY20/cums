<script setup lang="ts">
/**
 * 学生端首页：当前课堂卡片 + 全部课程网格。
 * 依据建设方案 4.1 / 4.2：课堂优先，未登录也可浏览。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, type Course, type CurrentSession } from '@/api'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const current = ref<CurrentSession | null>(null)
const courses = ref<Course[]>([])
const loading = ref(true)
const lastSync = ref('')

/** 轮询间隔：SSE 断线时仍能保持课堂状态新鲜 */
const POLL_MS = 30000
let timer: number | undefined
let source: EventSource | undefined

async function loadCurrent() {
  try {
    current.value = await api.currentSession()
    lastSync.value = new Date().toLocaleTimeString('zh-CN')
  } catch {
    // 网络抖动时保留上一次结果，不打断浏览
  }
}

async function loadCourses() {
  try {
    // 学生端只展示已发布课程。
    courses.value = (await api.studentCourses()).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '课程列表加载失败')
  }
}

/** 订阅课堂变更事件 */
function subscribeEvents() {
  source = new EventSource('/api/events')
  const refresh = () => loadCurrent()
  source.addEventListener('session.started', refresh)
  source.addEventListener('session.paused', refresh)
  source.addEventListener('session.ended', refresh)
  source.onerror = () => {
    // 浏览器会自动重连；此处仅记录，轮询会兜底。
  }
}

onMounted(async () => {
  await Promise.all([loadCurrent(), loadCourses()])
  loading.value = false
  subscribeEvents()
  timer = window.setInterval(loadCurrent, POLL_MS)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
  source?.close()
})

function openSession() {
  if (current.value) router.push(`/student/sessions/${current.value.session.id}`)
}

function statusText(status: string) {
  return status === 'running' ? '进行中' : status === 'paused' ? '已暂停' : '已结束'
}
</script>

<template>
  <div class="page">
    <!-- 当前课堂 -->
    <section v-if="current" class="current-session">
      <div class="current-session__cover">课程封面</div>
      <div class="current-session__body">
        <div class="current-session__title">
          {{ current.course_title }} · {{ current.lesson_title }}
          <span class="status-tag" :class="`status-tag--${current.session.status}`">
            {{ statusText(current.session.status) }}
          </span>
        </div>
        <div class="current-session__meta">
          班级：{{ current.class_name }} ｜ 教师：{{ current.teacher_name }}
        </div>
        <el-button type="primary" @click="openSession">进入课程 →</el-button>
      </div>
    </section>

    <section v-else-if="!loading" class="card empty-state">
      <p style="margin: 0 0 6px; font-size: 15px">当前没有进行中的课堂</p>
      <p style="margin: 0">可以先浏览下方课程，等待教师发布课堂。</p>
    </section>

    <!-- 全部课程 -->
    <h2 class="section-title">全部课程</h2>

    <div v-if="loading" class="card empty-state">正在加载课程…</div>

    <div v-else-if="courses.length === 0" class="card empty-state">
      暂无课程，请等待教师创建。
    </div>

    <div v-else class="course-grid">
      <article
        v-for="course in courses"
        :key="course.id"
        class="course-card"
        @click="router.push(`/student/courses/${course.id}`)"
      >
        <div class="course-card__cover">{{ course.title.slice(0, 2) }}</div>
        <div class="course-card__body">
          <div class="course-card__title">{{ course.title }}</div>
          <div class="course-card__desc">{{ course.description || '暂无课程简介' }}</div>
          <div class="course-card__foot">共 {{ course.lesson_count }} 课时</div>
        </div>
      </article>
    </div>

    <p v-if="lastSync" style="margin-top: 18px; color: var(--text-sub); font-size: 12px">
      课堂状态最后同步：{{ lastSync }}
    </p>
  </div>
</template>
