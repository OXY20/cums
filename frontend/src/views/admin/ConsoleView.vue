<script setup lang="ts">
/**
 * 课堂控制台：选择班级、课程、课时并发布/切换/结束课堂。
 * 对应建设方案 5.2「课堂控制台」与 5.3「课堂发布流程」。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  api,
  type ClassInfo,
  type ClassroomSession,
  type Course,
  type CurrentSession,
  type Lesson,
} from '@/api'
import { formatTime, sessionStatusText } from '@/utils/format'

const classes = ref<ClassInfo[]>([])
const courses = ref<Course[]>([])
const lessons = ref<Lesson[]>([])
const sessions = ref<ClassroomSession[]>([])
const current = ref<CurrentSession | null>(null)

const selectedClass = ref<number | null>(null)
const selectedCourse = ref<number | null>(null)
const selectedLesson = ref<number | null>(null)
const busy = ref(false)
let timer: number | undefined

/** 当前活动课堂（进行中或已暂停） */
const activeSession = computed(() => current.value?.session ?? null)

onMounted(async () => {
  await Promise.all([loadClasses(), loadCourses(), loadSessions(), loadCurrent()])
  // 定期刷新，避免多教师同时操作时状态过期
  timer = window.setInterval(() => {
    loadSessions()
    loadCurrent()
  }, 15000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})

async function loadClasses() {
  try {
    classes.value = (await api.classes()).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '班级加载失败')
  }
}

async function loadCourses() {
  try {
    courses.value = (await api.courses()).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '课程加载失败')
  }
}

async function loadSessions() {
  try {
    sessions.value = (await api.sessions()).items
  } catch {
    /* 轮询失败不打扰用户 */
  }
}

async function loadCurrent() {
  try {
    current.value = await api.currentSession()
  } catch {
    current.value = null
  }
}

/** 选择课程后加载课时 */
async function onCourseChange(courseId: number | null) {
  selectedLesson.value = null
  lessons.value = []
  if (courseId === null) return
  try {
    lessons.value = (await api.lessons(courseId)).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '课时加载失败')
  }
}

/** 发布课堂：创建场次并立即开始 */
async function publish() {
  if (selectedClass.value === null || selectedLesson.value === null) {
    ElMessage.warning('请先选择班级、课程与课时')
    return
  }

  busy.value = true
  try {
    const session = await api.createSession(selectedClass.value, selectedLesson.value)
    await api.startSession(session.id)
    ElMessage.success('已开始上课，学生端将自动更新')
    await Promise.all([loadSessions(), loadCurrent()])
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '发布课堂失败')
  } finally {
    busy.value = false
  }
}

async function pause() {
  if (!activeSession.value) return
  try {
    await api.pauseSession(activeSession.value.id)
    ElMessage.success('课堂已暂停')
    await Promise.all([loadSessions(), loadCurrent()])
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '暂停失败')
  }
}

async function resume() {
  if (!activeSession.value) return
  try {
    await api.startSession(activeSession.value.id)
    ElMessage.success('课堂已恢复')
    await Promise.all([loadSessions(), loadCurrent()])
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '恢复失败')
  }
}

async function end() {
  if (!activeSession.value) return
  try {
    await ElMessageBox.confirm('结束课堂后学生端将不再显示该课堂，历史记录会保留。', '确认结束', {
      type: 'warning',
      confirmButtonText: '结束课堂',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }

  try {
    await api.endSession(activeSession.value.id)
    ElMessage.success('课堂已结束')
    await Promise.all([loadSessions(), loadCurrent()])
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '结束失败')
  }
}

function previewStudentPage() {
  window.open('/student', '_blank')
}

function statusText(status: string) {
  return sessionStatusText(status)
}
</script>

<template>
  <div>
    <h1 class="page-title">课堂控制台</h1>
    <p class="page-subtitle">选择班级、课程与课时后开始上课，学生端会自动同步。</p>

    <!-- 当前课堂 -->
    <div class="card">
      <div class="console-row">
        <div>
          <strong>当前课堂：</strong>
          <template v-if="current">
            <span class="status-tag" :class="`status-tag--${current.session.status}`">
              {{ statusText(current.session.status) }}
            </span>
            <span style="margin-left: 8px">
              {{ current.course_title }} · {{ current.lesson_title }}
            </span>
            <span style="margin-left: 8px; color: var(--text-sub)">
              班级：{{ current.class_name }}
            </span>
          </template>
          <span v-else style="color: var(--text-sub)">无进行中的课堂</span>
        </div>

        <div class="console-actions">
          <el-button v-if="current?.session.status === 'running'" @click="pause">暂停</el-button>
          <el-button v-else-if="current?.session.status === 'paused'" type="primary" @click="resume">
            恢复
          </el-button>
          <el-button v-if="current" type="danger" plain @click="end">结束课堂</el-button>
          <el-button @click="previewStudentPage">预览学生页面</el-button>
        </div>
      </div>
    </div>

    <!-- 发布课堂 -->
    <h2 class="section-title">发布课堂</h2>
    <div class="card">
      <el-form label-width="90px" style="max-width: 520px">
        <el-form-item label="班级 / 机房">
          <el-select v-model="selectedClass" placeholder="请选择班级" style="width: 100%">
            <el-option
              v-for="item in classes"
              :key="item.id"
              :label="item.room_name ? `${item.name}（${item.room_name}）` : item.name"
              :value="item.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="课程">
          <el-select
            v-model="selectedCourse"
            placeholder="请选择课程"
            style="width: 100%"
            @change="onCourseChange"
          >
            <el-option
              v-for="item in courses"
              :key="item.id"
              :label="`${item.title}（共 ${item.lesson_count} 课时）`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="课时">
          <el-select
            v-model="selectedLesson"
            placeholder="请先选择课程"
            style="width: 100%"
            :disabled="lessons.length === 0"
          >
            <el-option
              v-for="item in lessons"
              :key="item.id"
              :label="`第 ${item.sort_order} 课时 · ${item.title}`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>

        <el-form-item>
          <el-button type="primary" :loading="busy" @click="publish">开始上课</el-button>
        </el-form-item>
      </el-form>

      <p v-if="classes.length === 0" class="page-subtitle" style="margin: 0">
        暂无班级，请先创建班级与机房。
      </p>
    </div>

    <!-- 历史记录 -->
    <h2 class="section-title">最近课堂记录</h2>
    <div class="card">
      <el-table :data="sessions" size="small" empty-text="暂无课堂记录">
        <el-table-column prop="id" label="场次" width="80" />
        <el-table-column prop="class_id" label="班级 ID" width="100" />
        <el-table-column prop="lesson_id" label="课时 ID" width="100" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <span class="status-tag" :class="`status-tag--${row.status}`">
              {{ statusText(row.status) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="开始时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.started_at) }}</template>
        </el-table-column>
        <el-table-column label="结束时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.ended_at) }}</template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.console-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.console-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
