<script setup lang="ts">
/**
 * 作业提交记录：教师端查看学生提交、预览文件并标记审阅状态。
 *
 * 列表支持按课程 / 课时 / 审阅标签筛选，以及「仅看重复提交」；
 * 详情弹窗复用 SubmissionPreview 组件，按文件类型分流预览。
 * 提交时间与来源 IP 均由服务端记录，客户端无法伪造。
 *
 * 这里是「按记录逐条翻」的视角；需要整班批量批改时走课时批改页，
 * 两个入口共用同一套审阅字段，互不冲突。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  api,
  REVIEW_LABEL_META,
  reviewLabelText,
  type Course,
  type Lesson,
  type ReviewLabel,
  type Submission,
  type SubmissionDetail,
  type SubmissionStatus,
} from '@/api'
import { formatTime, submissionStatusText } from '@/utils/format'
import SubmissionPreview from '@/components/SubmissionPreview.vue'

/**
 * 下拉筛选值。
 *
 * el-select 清空时会写入空字符串，因此这里用 `''` 表示「不限」，
 * 而不是 undefined，避免清空后仍被当成已选值参与查询。
 */
type FilterId = number | ''

/** 课程列表：用于筛选下拉 */
const courses = ref<Course[]>([])
/** 当前课程下的课时列表 */
const lessons = ref<Lesson[]>([])
const lessonsLoading = ref(false)

const courseId = ref<FilterId>('')
const lessonId = ref<FilterId>('')
const duplicateOnly = ref(false)
/** 按审阅标签筛选；空串表示不限 */
const reviewLabel = ref<ReviewLabel | 'unreviewed' | ''>('')

const rows = ref<Submission[]>([])
const total = ref(0)
const loading = ref(true)

/** 详情弹窗 */
const detailVisible = ref(false)
const detailLoading = ref(false)
const detail = ref<SubmissionDetail | null>(null)
/** 正在提交的审阅状态，用于两个按钮各自独立 loading */
const reviewingStatus = ref<SubmissionStatus | null>(null)
/** 正在切换的标签，避免连点造成状态错乱 */
const labelingId = ref<number | null>(null)

/** 空态文案随筛选条件变化，便于教师判断是「没有数据」还是「筛过头了」 */
const emptyText = computed(() => {
  const filtered =
    courseId.value !== '' ||
    lessonId.value !== '' ||
    duplicateOnly.value ||
    reviewLabel.value !== ''
  return filtered ? '当前筛选条件下没有提交记录，试试放宽条件' : '还没有学生提交作业'
})

onMounted(async () => {
  await loadCourses()
  await load()
})

/** 把下拉值转成接口参数；空字符串表示不限制 */
function toQueryId(value: FilterId): number | undefined {
  return value === '' ? undefined : value
}

async function loadCourses() {
  try {
    courses.value = (await api.courses()).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '课程加载失败')
  }
}

/** 切换课程：清空课时筛选并重新加载课时下拉 */
async function onCourseChange() {
  lessonId.value = ''
  lessons.value = []
  if (courseId.value !== '') await loadLessons(courseId.value)
  await load()
}

async function loadLessons(id: number) {
  lessonsLoading.value = true
  try {
    lessons.value = (await api.lessons(id)).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '课时加载失败')
  } finally {
    lessonsLoading.value = false
  }
}

/** 拉取提交记录列表 */
async function load() {
  loading.value = true
  try {
    const result = await api.submissions({
      courseId: toQueryId(courseId.value),
      lessonId: toQueryId(lessonId.value),
      duplicateOnly: duplicateOnly.value,
      reviewLabel: reviewLabel.value === '' ? undefined : reviewLabel.value,
    })
    rows.value = result.items
    total.value = result.total
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '提交记录加载失败')
  } finally {
    loading.value = false
  }
}

/** 重置全部筛选条件并重新查询 */
async function resetFilters() {
  courseId.value = ''
  lessonId.value = ''
  duplicateOnly.value = false
  reviewLabel.value = ''
  lessons.value = []
  await load()
}

/** 状态标签配色：已查看为成功色，问题为警告色，已提交为中性色 */
function statusTagType(status: SubmissionStatus): 'success' | 'warning' | 'info' {
  if (status === 'reviewed') return 'success'
  if (status === 'flagged') return 'warning'
  return 'info'
}

/** 审阅标签配色 */
function labelTagType(label: string): 'success' | 'primary' | 'danger' | 'info' {
  const found = REVIEW_LABEL_META.find((item) => item.value === label)
  return (found?.type as 'success' | 'primary' | 'danger' | 'info') ?? 'info'
}

/** 分数显示：未打分为「—」 */
function scoreText(score: number | null): string {
  if (score === null || score === undefined) return '—'
  return Number.isInteger(score) ? String(score) : score.toFixed(1)
}

/** 列表里直接打标签：再点一次同一标签视为取消 */
async function labelRow(row: Submission, label: ReviewLabel) {
  const next: ReviewLabel = row.review_label === label ? '' : label
  labelingId.value = row.id
  try {
    const updated = await api.reviewSubmission(row.id, { label: next })
    // 原地更新行，避免整表重载导致滚动位置丢失
    Object.assign(row, {
      review_label: updated.review_label,
      review_score: updated.review_score,
      review_comment: updated.review_comment,
      reviewed_at: updated.reviewed_at,
      status: updated.status,
    })
    if (detail.value?.id === row.id) detail.value = updated
    ElMessage.success(next === '' ? '已取消标签' : `已标记为「${reviewLabelText(next)}」`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '标签保存失败')
  } finally {
    labelingId.value = null
  }
}

/** 打开详情弹窗并按需拉取完整详情（含文件列表） */
async function openDetail(row: Submission) {
  detailVisible.value = true
  detailLoading.value = true
  detail.value = null
  try {
    detail.value = await api.submission(row.id)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '提交详情加载失败')
    detailVisible.value = false
  } finally {
    detailLoading.value = false
  }
}

/** 标记审阅状态：成功后同时刷新弹窗与列表 */
async function review(status: SubmissionStatus) {
  if (!detail.value) return

  reviewingStatus.value = status
  try {
    detail.value = await api.reviewSubmission(detail.value.id, { status })
    ElMessage.success(status === 'flagged' ? '已标记为问题' : '已标记为已查看')
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '标记失败')
  } finally {
    reviewingStatus.value = null
  }
}

/** 详情弹窗里打标签 */
async function labelDetail(label: ReviewLabel) {
  if (!detail.value) return
  const next: ReviewLabel = detail.value.review_label === label ? '' : label
  labelingId.value = detail.value.id
  try {
    detail.value = await api.reviewSubmission(detail.value.id, { label: next })
    const row = rows.value.find((item) => item.id === detail.value?.id)
    if (row) {
      Object.assign(row, {
        review_label: detail.value.review_label,
        review_score: detail.value.review_score,
        review_comment: detail.value.review_comment,
        reviewed_at: detail.value.reviewed_at,
        status: detail.value.status,
      })
    }
    ElMessage.success(next === '' ? '已取消标签' : `已标记为「${reviewLabelText(next)}」`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '标签保存失败')
  } finally {
    labelingId.value = null
  }
}
</script>

<template>
  <div>
    <h1 class="page-title">作业提交记录</h1>
    <p class="page-subtitle">
      学生每次提交都会记录提交时间与来源 IP；同一课时同一班级出现多人提交时会被自动标记为重复，便于核对。
    </p>

    <!-- 筛选区 -->
    <div class="card filter-bar">
      <div class="filter-bar__item">
        <span class="filter-bar__label">课程</span>
        <el-select
          v-model="courseId"
          placeholder="全部课程"
          clearable
          style="width: 200px"
          @change="onCourseChange"
        >
          <el-option v-for="item in courses" :key="item.id" :label="item.title" :value="item.id" />
        </el-select>
      </div>

      <div class="filter-bar__item">
        <span class="filter-bar__label">课时</span>
        <el-select
          v-model="lessonId"
          placeholder="全部课时"
          clearable
          :disabled="courseId === ''"
          :loading="lessonsLoading"
          style="width: 240px"
          @change="load"
        >
          <el-option
            v-for="item in lessons"
            :key="item.id"
            :label="`第 ${item.sort_order} 课时 · ${item.title}`"
            :value="item.id"
          />
        </el-select>
      </div>

      <div class="filter-bar__item">
        <span class="filter-bar__label">审阅标签</span>
        <el-select
          v-model="reviewLabel"
          placeholder="全部"
          clearable
          style="width: 140px"
          @change="load"
        >
          <el-option label="待批改" value="unreviewed" />
          <el-option
            v-for="meta in REVIEW_LABEL_META"
            :key="meta.value"
            :label="meta.text"
            :value="meta.value"
          />
        </el-select>
      </div>

      <div class="filter-bar__item">
        <span class="filter-bar__label">仅看重复提交</span>
        <el-switch v-model="duplicateOnly" @change="load" />
      </div>

      <el-button @click="resetFilters">重置筛选</el-button>

      <span class="filter-bar__count">共 {{ total }} 条</span>
    </div>

    <!-- 提交记录列表 -->
    <div class="card">
      <el-table v-loading="loading" :data="rows" :empty-text="emptyText">
        <el-table-column prop="id" label="ID" width="70" />

        <el-table-column prop="student_name" label="学生姓名" width="110" show-overflow-tooltip />

        <el-table-column label="学号" width="110">
          <template #default="{ row }">
            <span class="mono">{{ row.student_no || '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="课程" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.course_title || '—' }}</template>
        </el-table-column>

        <el-table-column label="课时" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ row.lesson_title || '—' }}</template>
        </el-table-column>

        <el-table-column label="班级" width="100">
          <template #default="{ row }">{{ row.class_name || '—' }}</template>
        </el-table-column>

        <el-table-column prop="file_count" label="文件数" width="80" />

        <el-table-column label="来源 IP" width="130">
          <template #default="{ row }">
            <span class="mono">{{ row.client_ip || '—' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="提交时间" width="170">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>

        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.status)">
              {{ submissionStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="分数" width="80">
          <template #default="{ row }">
            <span :class="{ 'score-strong': row.review_score !== null }">
              {{ scoreText(row.review_score) }}
            </span>
          </template>
        </el-table-column>

        <el-table-column label="标签" min-width="230">
          <template #default="{ row }">
            <div class="tag-row">
              <el-tag
                v-for="meta in REVIEW_LABEL_META"
                :key="meta.value"
                size="small"
                :type="row.review_label === meta.value ? labelTagType(meta.value) : 'info'"
                :effect="row.review_label === meta.value ? 'dark' : 'plain'"
                class="tag-row__btn"
                :class="{ 'tag-row__btn--busy': labelingId === row.id }"
                @click="labelRow(row, meta.value)"
              >
                {{ meta.text }}
              </el-tag>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="重复" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.duplicate_flag === 1" size="small" type="warning">重复</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="openDetail(row)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 详情弹窗：信息 + 文件预览 + 审阅操作 -->
    <el-dialog v-model="detailVisible" title="提交详情" width="760px" top="6vh" destroy-on-close>
      <div v-loading="detailLoading" class="detail">
        <template v-if="detail">
          <!-- 重复提交提示：说明本节课本班级已有其他人先提交 -->
          <el-alert
            v-if="detail.duplicate_flag === 1"
            :title="`本节课本班级已有提交（${detail.duplicate_of_name || '其他同学'}，编号 ${detail.duplicate_of}）`"
            type="warning"
            :closable="false"
            show-icon
          />

          <div class="detail__meta">
            <div class="detail__row">
              <span class="detail__label">学生姓名</span>
              <span class="detail__value">
                {{ detail.student_name }}
                <span v-if="detail.student_no" class="mono detail__no">
                  {{ detail.student_no }}
                </span>
              </span>
            </div>

            <div class="detail__row">
              <span class="detail__label">课程 · 课时</span>
              <span class="detail__value">
                {{ detail.course_title || '—' }} · {{ detail.lesson_title || '—' }}
              </span>
            </div>

            <div class="detail__row">
              <span class="detail__label">班级</span>
              <span class="detail__value">{{ detail.class_name || '未指定班级' }}</span>
            </div>

            <div class="detail__row">
              <span class="detail__label">提交时间</span>
              <span class="detail__value">{{ formatTime(detail.created_at) }}</span>
            </div>

            <div class="detail__row">
              <span class="detail__label">来源 IP</span>
              <span class="detail__value mono">{{ detail.client_ip || '—' }}</span>
            </div>

            <div class="detail__row">
              <span class="detail__label">状态</span>
              <span class="detail__value">
                <el-tag size="small" :type="statusTagType(detail.status)">
                  {{ submissionStatusText(detail.status) }}
                </el-tag>
              </span>
            </div>

            <div class="detail__row detail__row--wide">
              <span class="detail__label">审阅标签</span>
              <span class="detail__value">
                <span class="tag-row">
                  <el-tag
                    v-for="meta in REVIEW_LABEL_META"
                    :key="meta.value"
                    size="small"
                    :type="detail.review_label === meta.value ? labelTagType(meta.value) : 'info'"
                    :effect="detail.review_label === meta.value ? 'dark' : 'plain'"
                    class="tag-row__btn"
                    @click="labelDetail(meta.value)"
                  >
                    {{ meta.text }}
                  </el-tag>
                </span>
                <span v-if="detail.reviewed_at" class="detail__value--small detail__reviewed">
                  批改于 {{ formatTime(detail.reviewed_at) }}
                  <template v-if="detail.review_score !== null">
                    · 分数 {{ scoreText(detail.review_score) }}
                  </template>
                </span>
              </span>
            </div>

            <div v-if="detail.review_comment" class="detail__row detail__row--wide">
              <span class="detail__label">教师评语</span>
              <span class="detail__value">{{ detail.review_comment }}</span>
            </div>

            <div class="detail__row detail__row--wide">
              <span class="detail__label">User-Agent</span>
              <span class="detail__value detail__value--small">{{ detail.user_agent || '—' }}</span>
            </div>

            <div v-if="detail.note" class="detail__row detail__row--wide">
              <span class="detail__label">备注</span>
              <span class="detail__value">{{ detail.note }}</span>
            </div>
          </div>

          <h3 class="detail__section">文件预览</h3>
          <SubmissionPreview :detail="detail" />
        </template>

        <div v-else-if="!detailLoading" class="empty-state">暂无提交详情</div>
      </div>

      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button
          type="primary"
          :disabled="!detail"
          :loading="reviewingStatus === 'reviewed'"
          @click="review('reviewed')"
        >
          标记已查看
        </el-button>
        <el-button
          type="warning"
          plain
          :disabled="!detail"
          :loading="reviewingStatus === 'flagged'"
          @click="review('flagged')"
        >
          标记问题
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 筛选区：窄屏自动换行 */
.filter-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
}

.filter-bar__item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-bar__label {
  flex: none;
  font-size: 13px;
  color: var(--text-sub);
  white-space: nowrap;
}

.filter-bar__count {
  margin-left: auto;
  font-size: 13px;
  color: var(--text-sub);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.muted {
  color: var(--text-sub);
}

/* 行内标签按钮：列表里直接打标签，不必开弹窗 */
.tag-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tag-row__btn {
  cursor: pointer;
  user-select: none;
}

.tag-row__btn:hover {
  opacity: 0.82;
}

/* 请求进行中时压暗，提示已在保存 */
.tag-row__btn--busy {
  opacity: 0.5;
  pointer-events: none;
}

.score-strong {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.detail__no {
  margin-left: 8px;
  color: var(--text-sub);
}

.detail__reviewed {
  margin-left: 10px;
}

/* 详情弹窗 */
.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 120px;
}

.detail__meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 20px;
  padding: 12px 14px;
  background: #fafbfc;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.detail__row {
  display: flex;
  gap: 10px;
  font-size: 13px;
  min-width: 0;
}

/* User-Agent 与备注较长，独占整行 */
.detail__row--wide {
  grid-column: 1 / -1;
}

.detail__label {
  flex: none;
  width: 76px;
  color: var(--text-sub);
}

.detail__value {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.detail__value--small {
  font-size: 12px;
  color: var(--text-sub);
}

.detail__section {
  margin: 4px 0 0;
  font-size: 14px;
}

@media (max-width: 640px) {
  .detail__meta {
    grid-template-columns: 1fr;
  }
}
</style>
