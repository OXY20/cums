<script setup lang="ts">
/**
 * 学生端课程主页：课时列表 + 资源下载。
 * 对应建设方案 5.1「课程详情」。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, fileUrl, type Course, type CurrentSession, type Lesson, type Resource } from '@/api'
import { formatBytes, sessionStatusText } from '@/utils/format'
import HomeworkSubmitDialog from '@/components/HomeworkSubmitDialog.vue'
import SubmissionResultDialog from '@/components/SubmissionResultDialog.vue'
import type { CreateSubmissionResponse } from '@/api'

const props = defineProps<{ courseId: string }>()
const router = useRouter()

const course = ref<Course | null>(null)
const lessons = ref<Lesson[]>([])
const activeLesson = ref<Lesson | null>(null)
const resources = ref<Resource[]>([])
const current = ref<CurrentSession | null>(null)
const loading = ref(true)

/** 作业上传弹窗 */
const submitVisible = ref(false)
/** 提交成功后的预览弹窗 */
const resultVisible = ref(false)
const submitResult = ref<CreateSubmissionResponse | null>(null)

const courseId = computed(() => Number(props.courseId))

/** 当前课堂是否属于本课程 */
const isCurrentCourse = computed(
  () => current.value !== null && current.value.course_title === course.value?.title,
)

/**
 * 当前课时所属的班级。
 *
 * 只有在「本节课正在进行」时才能确定班级；否则为 null，
 * 服务端会退化为按课时统计重复提交。
 */
const activeClassId = computed(() => {
  if (!current.value) return null
  if (!isCurrentCourse.value) return null
  if (activeLesson.value && current.value.session.lesson_id !== activeLesson.value.id) return null
  return current.value.session.class_id
})

/** 打开作业上传弹窗 */
function openSubmit() {
  if (!activeLesson.value) {
    ElMessage.info('请先选择一个课时')
    return
  }
  submitVisible.value = true
}

/** 提交成功：弹出预览 */
function onSubmitted(payload: CreateSubmissionResponse) {
  submitResult.value = payload
  resultVisible.value = true
}

onMounted(async () => {
  try {
    course.value = await api.course(courseId.value)
    lessons.value = (await api.lessons(courseId.value)).items
    current.value = await api.currentSession()
    if (lessons.value.length > 0) await selectLesson(lessons.value[0])
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '课程加载失败')
  } finally {
    loading.value = false
  }
})

async function selectLesson(lesson: Lesson) {
  activeLesson.value = lesson
  try {
    resources.value = (await api.lessonResources(lesson.id)).items
  } catch {
    resources.value = []
  }
}

/** 解析课时结构化内容 */
const lessonBlocks = computed(() => {
  if (!activeLesson.value) return []
  try {
    const parsed = JSON.parse(activeLesson.value.content_json) as Record<string, unknown>
    return Object.entries(parsed)
      .filter(([, value]) => value !== null && value !== '')
      .map(([key, value]) => ({
        key,
        label: BLOCK_LABELS[key] ?? key,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      }))
  } catch {
    return []
  }
})

const BLOCK_LABELS: Record<string, string> = {
  goal: '学习目标',
  intro: '教学说明',
  steps: '操作步骤',
  notes: '注意事项',
  task: '练习任务',
  criteria: '完成标准',
  video: '示范视频',
}

function download(resource: Resource) {
  window.open(fileUrl(resource.id), '_blank')
}

/** 下载本节课全部资源 */
function downloadAll() {
  if (resources.value.length === 0) {
    ElMessage.info('本节课暂无资源')
    return
  }
  for (const resource of resources.value) download(resource)
  ElMessage.success(`已开始下载 ${resources.value.length} 个文件`)
}

function enterSession() {
  if (current.value) router.push(`/student/sessions/${current.value.session.id}`)
}
</script>

<template>
  <div class="page">
    <el-button link @click="router.push('/student')">← 返回首页</el-button>

    <div v-if="loading" class="card empty-state">正在加载…</div>

    <template v-else-if="course">
      <!--
        页面标题体现「课程 · 课时」的层级：
        选中课时后顶部直接显示当前定位，无需再到右侧内容区找标题。
      -->
      <h1 class="page-title">
        {{ course.title }}
        <template v-if="activeLesson">
          <span class="title-sep">·</span>
          <span class="title-lesson">{{ activeLesson.title }}</span>
        </template>
      </h1>
      <p class="page-subtitle">
        <template v-if="activeLesson">
          第 {{ activeLesson.sort_order }} 课时
          <span class="subtitle-sep">｜</span>
        </template>
        {{ course.description || '暂无课程简介' }}
      </p>

      <!-- 本课程正在进行时提供快捷入口 -->
      <div v-if="isCurrentCourse && current" class="card" style="margin-bottom: 16px">
        <strong>本节课正在进行：</strong>{{ current.lesson_title }}
        <span class="status-tag" :class="`status-tag--${current.session.status}`">
          {{ sessionStatusText(current.session.status) }}
        </span>
        <el-button type="primary" size="small" style="margin-left: 12px" @click="enterSession">
          进入课堂
        </el-button>
      </div>

      <div class="lesson-layout">
        <!-- 课时列表 -->
        <aside class="lesson-nav card">
          <div class="lesson-nav__title">课时列表</div>
          <div
            v-for="lesson in lessons"
            :key="lesson.id"
            class="lesson-nav__item"
            :class="{ 'lesson-nav__item--active': activeLesson?.id === lesson.id }"
            @click="selectLesson(lesson)"
          >
            第 {{ lesson.sort_order }} 课时 · {{ lesson.title }}
          </div>
          <div v-if="lessons.length === 0" class="empty-state" style="padding: 20px">
            暂无课时
          </div>
        </aside>

        <!-- 课时正文 -->
        <section class="card lesson-content">
          <template v-if="activeLesson">
            <!-- 课时标题已提升到页面顶部，这里只保留定位信息；右侧放作业入口 -->
            <div class="lesson-head">
              <div class="lesson-content__head">
                <span class="lesson-content__label">第 {{ activeLesson.sort_order }} 课时</span>
                <span class="lesson-content__name">{{ activeLesson.title }}</span>
              </div>
              <!-- 作业上传入口：选中课时后始终可用 -->
              <el-button type="primary" @click="openSubmit">提交作业</el-button>
            </div>

            <!--
              富文本正文优先；旧数据回退到结构化字段。
              v-html 的内容已在服务端经 ammonia 白名单清洗（标签、属性、
              链接协议、图片路径、内联样式均受限），因此这里是安全的。
            -->
            <div
              v-if="activeLesson.content_html"
              class="rich-content"
              v-html="activeLesson.content_html"
            />

            <template v-else>
              <div v-if="lessonBlocks.length === 0" class="empty-state">
                本课时暂无内容。
              </div>

              <div v-for="block in lessonBlocks" :key="block.key" class="lesson-block">
                <div class="lesson-block__title">{{ block.label }}</div>
                <div class="lesson-block__text">{{ block.text }}</div>
              </div>
            </template>

            <h3 class="section-title">
              相关资源
              <el-button v-if="resources.length > 0" size="small" @click="downloadAll">
                下载全部
              </el-button>
            </h3>

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
          </template>

          <div v-else class="empty-state">请从左侧选择一个课时。</div>
        </section>
      </div>

      <!-- 作业上传弹窗 -->
      <HomeworkSubmitDialog
        v-model="submitVisible"
        :lesson-id="activeLesson?.id ?? null"
        :lesson-title="activeLesson?.title ?? ''"
        :class-id="activeClassId"
        @submitted="onSubmitted"
      />

      <!-- 提交成功后的预览弹窗 -->
      <SubmissionResultDialog v-model="resultVisible" :result="submitResult" />
    </template>
  </div>
</template>

<style scoped>
.lesson-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 16px;
  align-items: start;
}

/* 课时定位条与「提交作业」按钮同一行 */
.lesson-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.lesson-nav {
  padding: 12px;
}

.lesson-nav__title {
  font-weight: 600;
  margin-bottom: 8px;
}

.lesson-nav__item {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-sub);
  font-size: 13px;
}

.lesson-nav__item:hover {
  background: var(--brand-soft);
  color: var(--brand);
}

.lesson-nav__item--active {
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 600;
}

.lesson-content {
  min-height: 320px;
}

/* 标题层级：课程名 · 课时名 */
.title-sep {
  margin: 0 6px;
  color: var(--text-sub);
  font-weight: 400;
}

.title-lesson {
  font-weight: 600;
}

.subtitle-sep {
  margin: 0 4px;
  color: var(--border-color);
}

/* 内容区的课时定位条 */
.lesson-content__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-color);
  flex: 1;
  min-width: 0;
}

.lesson-content__label {
  flex: none;
  font-size: 12px;
  color: var(--brand);
  background: var(--brand-soft);
  border-radius: 4px;
  padding: 2px 8px;
}

.lesson-content__name {
  font-size: 13px;
  color: var(--text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .lesson-layout {
    grid-template-columns: 1fr;
  }
}
</style>
