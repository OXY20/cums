<script setup lang="ts">
/**
 * 课程作业统计：按课时看提交情况，并能查出谁没交。
 *
 * 教师打开课程详情时最关心两件事：
 * 1. 这门课每节课的作业收齐了没有；
 * 2. 具体某一节课，谁还没交——好把名单复制到群里催。
 *
 * 因此界面分两层：上面是课时看板（一眼看全班进度），
 * 点进某个课时后再看已交/未交明细。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  api,
  type ClassInfo,
  type CourseHomeworkOverview,
  type LessonHomeworkSummary,
  type LessonSubmissionBoard,
} from '@/api'
import { formatTime } from '@/utils/format'

const props = defineProps<{
  courseId: number
}>()

const router = useRouter()

/** 跳到名单管理页 */
function goRoster() {
  router.push('/admin/roster')
}

/** 进入某课时的批量批改页，带上当前班级，避免重复选择 */
function goReview(lesson: LessonHomeworkSummary) {
  const query = selectedClassId.value !== null ? { class_id: String(selectedClassId.value) } : {}
  router.push({ name: 'admin-lesson-review', params: { lessonId: lesson.lesson_id }, query })
}

/** 可选班级：课程是模板，同一门课会被多个班级使用，统计必须按班级看 */
const classes = ref<ClassInfo[]>([])
const selectedClassId = ref<number | null>(null)

/**
 * 班级选择默认不选。
 *
 * 同一门课通常给多个班上课，默认选中某个班会让人误以为看到的是全部数据。
 * 但「这门课只教过一个班」时，让教师再手选一次纯属多余，
 * 所以拿到总览后如果发现只用一个班就自动选上；多个班时仍然要求显式选择。
 */
const classChosen = computed(() => selectedClassId.value !== null)

const overview = ref<CourseHomeworkOverview | null>(null)
const loading = ref(false)

/** 当前展开的课时看板 */
const board = ref<LessonSubmissionBoard | null>(null)
const boardLoading = ref(false)
const boardVisible = ref(false)

/** 名单人数；用于展示「已交 / 应缴」 */
const rosterTotal = computed(() => overview.value?.roster_total ?? 0)

/** 整门课的总体进度 */
const overall = computed(() => {
  const lessons = overview.value?.lessons ?? []
  if (lessons.length === 0 || rosterTotal.value === 0) {
    return { expected: 0, submitted: 0, percent: 0 }
  }
  const expected = rosterTotal.value * lessons.length
  const submitted = lessons.reduce((sum, l) => sum + (rosterTotal.value - l.missing_count), 0)
  return {
    expected,
    submitted,
    percent: expected > 0 ? Math.round((submitted / expected) * 100) : 0,
  }
})

/** 未交总数（所有课时累加） */
const totalMissing = computed(() =>
  (overview.value?.lessons ?? []).reduce((sum, l) => sum + l.missing_count, 0),
)

onMounted(async () => {
  await loadClasses()
})

/** 加载班级列表 */
async function loadClasses() {
  try {
    const result = await api.classes()
    classes.value = result.items
  } catch {
    classes.value = []
  }
}

/** 加载总览 */
async function loadOverview() {
  loading.value = true
  try {
    const result = await api.homeworkOverview(props.courseId, selectedClassId.value)
    overview.value = result

    // 只教过一个班时自动选中，避免「明明只有一个班还要手选一次」
    if (selectedClassId.value === null && result.used_class_ids.length === 1) {
      selectedClassId.value = result.used_class_ids[0]
      return
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '作业统计加载失败')
    overview.value = null
  } finally {
    loading.value = false
  }
}

watch([() => props.courseId, selectedClassId], loadOverview, { immediate: true })

/** 打开某课时的提交明细 */
async function openBoard(lesson: LessonHomeworkSummary) {
  boardVisible.value = true
  boardLoading.value = true
  board.value = null
  try {
    board.value = await api.submissionBoard(lesson.lesson_id, selectedClassId.value)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '明细加载失败')
  } finally {
    boardLoading.value = false
  }
}

/** 把未交名单复制到剪贴板，方便教师发到班级群 */
async function copyMissing() {
  const missing = board.value?.missing ?? []
  if (missing.length === 0) {
    ElMessage.info('本课时没有未交学生')
    return
  }
  const text = missing.map((m) => `${m.student_no} ${m.student_name}`).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(`已复制 ${missing.length} 位未交学生名单`)
  } catch {
    // 剪贴板权限被拒时降级为提示，不阻断操作
    ElMessage.warning('浏览器拒绝了剪贴板访问，请手动选择文本复制')
  }
}

/** 课时提交率的颜色：未收齐用警示色 */
function progressStatus(lesson: LessonHomeworkSummary): '' | 'success' | 'warning' {
  if (rosterTotal.value === 0) return ''
  if (lesson.missing_count === 0) return 'success'
  return 'warning'
}

/** 课时提交百分比 */
function lessonPercent(lesson: LessonHomeworkSummary): number {
  if (rosterTotal.value === 0) return 0
  const done = rosterTotal.value - lesson.missing_count
  return Math.round((done / rosterTotal.value) * 100)
}

/** 状态中文 */
function statusText(status: string): string {
  switch (status) {
    case 'submitted':
      return '已提交'
    case 'reviewed':
      return '已查看'
    case 'flagged':
      return '已标记问题'
    default:
      return status
  }
}
</script>

<template>
  <div class="hw">
    <!-- 顶部：班级选择与总体进度 -->
    <div class="hw__head">
      <div class="hw__head-left">
        <span class="hw__label">统计班级</span>
        <el-select
          v-model="selectedClassId"
          placeholder="请选择班级"
          clearable
          style="width: 220px"
          :loading="loading"
        >
          <el-option
            v-for="item in classes"
            :key="item.id"
            :label="item.name"
            :value="item.id"
          />
        </el-select>
        <span v-if="!classChosen" class="hw__hint hw__hint--warn">
          选择班级后才能统计「谁没交」
        </span>
        <span v-else-if="rosterTotal === 0" class="hw__hint">
          该班级还没有导入名单，<el-button link type="primary" size="small" @click="goRoster">去导入</el-button>
        </span>
      </div>

      <div v-if="rosterTotal > 0" class="hw__summary">
        <span class="hw__summary-item">
          应缴 <strong>{{ overall.expected }}</strong> 份
        </span>
        <span class="hw__summary-item">
          已交 <strong>{{ overall.submitted }}</strong> 份
        </span>
        <span class="hw__summary-item" :class="{ 'hw__summary-item--warn': totalMissing > 0 }">
          待补交 <strong>{{ totalMissing }}</strong> 份
        </span>
      </div>
    </div>

    <div v-if="loading" class="empty-state">正在加载…</div>

    <template v-else-if="overview">
      <div v-if="overview.lessons.length === 0" class="empty-state">
        本课程还没有课时，先在左侧添加课时。
      </div>

      <div v-else class="hw__lessons">
        <div
          v-for="lesson in overview.lessons"
          :key="lesson.lesson_id"
          class="hw__lesson"
          @click="openBoard(lesson)"
        >
          <div class="hw__lesson-main">
            <span class="hw__lesson-no">第 {{ lesson.sort_order }} 课时</span>
            <span class="hw__lesson-title">{{ lesson.lesson_title }}</span>
          </div>

          <div class="hw__lesson-stats">
            <template v-if="rosterTotal > 0">
              <el-progress
                :percentage="lessonPercent(lesson)"
                :status="progressStatus(lesson)"
                :stroke-width="8"
                :show-text="false"
                class="hw__lesson-bar"
              />
              <span class="hw__lesson-count">
                {{ rosterTotal - lesson.missing_count }} / {{ rosterTotal }}
              </span>
              <el-tag
                v-if="lesson.missing_count > 0"
                type="warning"
                size="small"
                effect="plain"
              >
                {{ lesson.missing_count }} 人未交
              </el-tag>
              <el-tag v-else type="success" size="small" effect="plain">已收齐</el-tag>
            </template>
            <template v-else>
              <span class="hw__lesson-count">{{ lesson.submitter_count }} 人提交</span>
              <span v-if="lesson.duplicate_count > 0" class="hw__lesson-dup">
                {{ lesson.duplicate_count }} 份重复
              </span>
            </template>
            <el-button link type="primary" size="small" @click.stop="goReview(lesson)">
              批改 →
            </el-button>
            <el-button link type="primary" size="small">查看明细 →</el-button>
          </div>
        </div>
      </div>
    </template>

    <!-- 课时明细：已交 / 未交 / 名单外 -->
    <el-dialog v-model="boardVisible" :title="board?.lesson_title || '提交明细'" width="760px" top="6vh">
      <div v-if="boardLoading" class="empty-state">正在加载…</div>

      <template v-else-if="board">
        <div class="board__meta">
          <span>{{ board.course_title }}</span>
          <span v-if="board.class_name">· {{ board.class_name }}</span>
          <span v-if="board.roster_total > 0">· 名单 {{ board.roster_total }} 人</span>
        </div>

        <!-- 未交名单：教师最常用的动作 -->
        <div v-if="board.missing.length > 0" class="board__section board__section--missing">
          <div class="board__section-head">
            <span class="board__section-title">
              <el-tag type="warning" size="small">未交</el-tag>
              {{ board.missing.length }} 人
            </span>
            <el-button link type="primary" size="small" @click="copyMissing">
              复制名单
            </el-button>
          </div>
          <div class="board__missing-list">
            <span v-for="m in board.missing" :key="m.student_no" class="board__missing-item">
              {{ m.student_no }} {{ m.student_name }}
            </span>
          </div>
        </div>

        <div v-else-if="board.roster_total > 0" class="board__all-done">
          <el-tag type="success">全员已交</el-tag>
        </div>

        <!-- 已交 -->
        <div class="board__section">
          <div class="board__section-head">
            <span class="board__section-title">
              <el-tag type="success" size="small">已交</el-tag>
              {{ board.submitted.length }} 人
            </span>
          </div>
          <el-table v-if="board.submitted.length > 0" :data="board.submitted" size="small" max-height="280">
            <el-table-column prop="student_no" label="学号" width="110" />
            <el-table-column prop="student_name" label="姓名" width="90" />
            <el-table-column label="提交时间" width="160">
              <template #default="{ row }">{{ formatTime(row.latest_at) }}</template>
            </el-table-column>
            <el-table-column prop="client_ip" label="来源 IP" width="120" />
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <span>{{ statusText(row.status) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="备注" min-width="120">
              <template #default="{ row }">
                <el-tag v-if="row.submission_count > 1" size="small" type="info" effect="plain">
                  {{ row.submission_count }} 次
                </el-tag>
                <el-tag v-if="row.has_duplicate" size="small" type="warning" effect="plain">
                  重复
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
          <div v-else class="empty-state" style="padding: 14px">还没有人提交</div>
        </div>

        <!-- 名单外的提交者 -->
        <div v-if="board.unlisted.length > 0" class="board__section">
          <div class="board__section-head">
            <span class="board__section-title">
              <el-tag type="info" size="small">名单外</el-tag>
              {{ board.unlisted.length }} 人
            </span>
            <span class="board__section-hint">
              这些提交者不在名单中，可能是临时加人，或姓名填写有误
            </span>
          </div>
          <div class="board__unlisted-list">
            <span v-for="u in board.unlisted" :key="u.latest_submission_id" class="board__unlisted-item">
              {{ u.student_no || '（无学号）' }} {{ u.student_name }}
              <span class="board__unlisted-time">{{ formatTime(u.latest_at) }}</span>
            </span>
          </div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.hw {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hw__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.hw__head-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.hw__label {
  font-size: 13px;
  color: var(--text-sub);
}

.hw__hint {
  font-size: 12px;
  color: var(--text-sub);
}

.hw__hint--warn {
  color: #e6a23c;
}

.hw__summary {
  display: flex;
  gap: 18px;
  font-size: 13px;
  color: var(--text-sub);
}

.hw__summary-item strong {
  color: var(--text-main);
  font-size: 15px;
}

.hw__summary-item--warn strong {
  color: #e6a23c;
}

.hw__lessons {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hw__lesson {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  flex-wrap: wrap;
}

.hw__lesson:hover {
  border-color: var(--brand);
  background: var(--brand-soft);
}

.hw__lesson-main {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 200px;
}

.hw__lesson-no {
  flex: none;
  font-size: 12px;
  color: var(--brand);
  background: var(--brand-soft);
  border-radius: 4px;
  padding: 2px 8px;
}

.hw__lesson-title {
  font-size: 14px;
}

.hw__lesson-stats {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.hw__lesson-bar {
  width: 120px;
}

.hw__lesson-count {
  font-size: 13px;
  color: var(--text-sub);
  font-variant-numeric: tabular-nums;
}

.hw__lesson-dup {
  font-size: 12px;
  color: #e6a23c;
}

.board__meta {
  font-size: 13px;
  color: var(--text-sub);
  margin-bottom: 14px;
}

.board__section {
  margin-bottom: 18px;
}

.board__section--missing {
  background: #fdf6ec;
  border: 1px solid #faecd8;
  border-radius: 8px;
  padding: 12px 14px;
}

.board__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.board__section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
}

.board__section-hint {
  font-size: 12px;
  color: var(--text-sub);
}

.board__missing-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.board__missing-item {
  font-size: 13px;
  padding: 3px 10px;
  background: #fff;
  border: 1px solid #faecd8;
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
}

.board__all-done {
  margin-bottom: 16px;
}

.board__unlisted-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.board__unlisted-item {
  font-size: 13px;
  padding: 3px 10px;
  background: #f4f4f5;
  border-radius: 4px;
}

.board__unlisted-time {
  margin-left: 6px;
  font-size: 12px;
  color: var(--text-sub);
}
</style>
