<script setup lang="ts">
/**
 * 课时作业批改：教师对一次作业的所有提交做批量审阅。
 *
 * 设计依据来自实际批改流程：
 * 1. 一次作业通常 30–60 份，逐份点开再关掉极慢，因此主界面是**列表 + 勾选**；
 * 2. 大多数作业是「通过」，所以批量打标签是一等操作，不是隐藏功能；
 * 3. 少数需要细看的，才展开侧栏逐份看内容、打分、写评语；
 * 4. 批改完要能立刻知道「还剩多少没批」，因此顶部常驻统计。
 *
 * 界面分三层：顶部统计与筛选 → 中部列表（可多选）→ 右侧逐份详情。
 * 右侧用抽屉而不是弹窗，避免遮住列表，教师可以边看边改。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  api,
  REVIEW_LABEL_META,
  reviewLabelText,
  type ClassInfo,
  type LessonReviewBoard,
  type ReviewInput,
  type ReviewLabel,
  type SubmissionDetail,
} from '@/api'
import { formatTime } from '@/utils/format'
import SubmissionPreview from '@/components/SubmissionPreview.vue'

const route = useRoute()
const router = useRouter()

const lessonId = computed(() => Number(route.params.lessonId))

/** 可选班级：同一门课给多个班上课，批改必须按班级分开 */
const classes = ref<ClassInfo[]>([])
const selectedClassId = ref<number | null>(null)

const board = ref<LessonReviewBoard | null>(null)
const loading = ref(false)

/** 当前筛选的标签；空串表示全部 */
const labelFilter = ref<ReviewLabel | 'unreviewed' | ''>('')
/** 搜索：按学号或姓名过滤，批改时用来快速定位某个学生 */
const keyword = ref('')

/** 勾选的提交 ID */
const selectedIds = ref<number[]>([])

/** 右侧详情抽屉 */
const drawerVisible = ref(false)
const activeId = ref<number | null>(null)
const active = computed<SubmissionDetail | null>(
  () => board.value?.items.find((item) => item.id === activeId.value) ?? null,
)

/** 逐份编辑中的分数与评语；保存前不写库 */
const editScore = ref<number | null>(null)
const editComment = ref('')
const saving = ref(false)
/** 批量操作中的标记，用于按钮 loading */
const batchBusy = ref(false)

/** 顶部统计 */
const stats = computed(() => board.value?.stats ?? null)

/** 当前可见的条目：先按标签筛，再按关键词筛 */
const visibleItems = computed(() => {
  const items = board.value?.items ?? []
  const kw = keyword.value.trim().toLowerCase()

  return items.filter((item) => {
    if (labelFilter.value === 'unreviewed') {
      if (item.review_label !== '') return false
    } else if (labelFilter.value !== '' && item.review_label !== labelFilter.value) {
      return false
    }
    if (!kw) return true
    return (
      item.student_name.toLowerCase().includes(kw) ||
      item.student_no.toLowerCase().includes(kw)
    )
  })
})

/** 全选框状态：只对当前可见条目生效，避免误选被筛掉的 */
const allChecked = computed({
  get: () =>
    visibleItems.value.length > 0 &&
    visibleItems.value.every((item) => selectedIds.value.includes(item.id)),
  set: (checked: boolean) => {
    if (checked) {
      selectedIds.value = visibleItems.value.map((item) => item.id)
    } else {
      selectedIds.value = []
    }
  },
})

/** 部分选中：用于全选框的半选态 */
const someChecked = computed(
  () =>
    visibleItems.value.some((item) => selectedIds.value.includes(item.id)) && !allChecked.value,
)

/** 已选份数 */
const selectedCount = computed(() => selectedIds.value.length)

/** 未批份数：优先用服务端统计，避免本地筛选造成误导 */
const unreviewedCount = computed(() => stats.value?.unreviewed ?? 0)

/** 加载班级列表 */
async function loadClasses() {
  try {
    classes.value = (await api.classes()).items
  } catch {
    classes.value = []
  }
}

/** 加载批改看板 */
async function load() {
  loading.value = true
  try {
    board.value = await api.lessonReviewBoard(lessonId.value, selectedClassId.value)
    // 刷新后丢弃失效的勾选，防止对已删除的提交发起批量操作
    const alive = new Set(board.value.items.map((item) => item.id))
    selectedIds.value = selectedIds.value.filter((id) => alive.has(id))
    if (activeId.value !== null && !alive.has(activeId.value)) {
      drawerVisible.value = false
      activeId.value = null
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '批改数据加载失败')
    board.value = null
  } finally {
    loading.value = false
  }
}

watch([lessonId, selectedClassId], load, { immediate: true })
loadClasses()

/** 进入页面时若 URL 带 class_id，直接按该班级打开 */
if (route.query.class_id) {
  const parsed = Number(route.query.class_id)
  if (Number.isFinite(parsed)) selectedClassId.value = parsed
}

/** 打开逐份详情 */
function openItem(item: SubmissionDetail) {
  activeId.value = item.id
  editScore.value = item.review_score
  editComment.value = item.review_comment
  drawerVisible.value = true
}

/** 单份打标签 */
async function labelOne(item: SubmissionDetail, label: ReviewLabel) {
  // 再点一次同一标签视为取消，符合「打错了想撤回」的直觉
  const next: ReviewLabel = item.review_label === label ? '' : label
  try {
    await api.reviewSubmission(item.id, { label: next })
    await load()
    if (activeId.value === item.id) {
      const fresh = board.value?.items.find((row) => row.id === item.id)
      if (fresh) {
        editScore.value = fresh.review_score
        editComment.value = fresh.review_comment
      }
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '标签保存失败')
  }
}

/** 保存分数与评语 */
async function saveScoreAndComment() {
  if (!active.value) return
  saving.value = true
  try {
    await api.reviewSubmission(active.value.id, {
      score: editScore.value,
      comment: editComment.value,
    })
    ElMessage.success('已保存')
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    saving.value = false
  }
}

/** 批量打标签 */
async function batchLabel(label: ReviewLabel) {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要批改的提交')
    return
  }
  const labelText = reviewLabelText(label)
  try {
    await ElMessageBox.confirm(
      `将对选中的 ${selectedIds.value.length} 份提交标记为「${labelText}」，是否继续？`,
      '批量打标签',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }

  batchBusy.value = true
  try {
    const result = await api.batchReviewSubmission(
      selectedIds.value,
      { label },
      lessonId.value,
    )
    ElMessage.success(`已批改 ${result.updated} 份`)
    selectedIds.value = []
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '批量批改失败')
  } finally {
    batchBusy.value = false
  }
}

/** 批量打分：让教师输一个分数，应用到所有选中项 */
async function batchScore() {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要打分的提交')
    return
  }
  let input: string
  try {
    const result = await ElMessageBox.prompt(
      `将为选中的 ${selectedIds.value.length} 份提交打同一个分数（0–100）`,
      '批量打分',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        inputPattern: /^(100|[1-9]?\d(\.\d)?)$/,
        inputErrorMessage: '请输入 0–100 之间的分数',
        inputPlaceholder: '例如 85',
      },
    )
    input = result.value
  } catch {
    return
  }

  batchBusy.value = true
  try {
    const result = await api.batchReviewSubmission(
      selectedIds.value,
      { score: Number(input) },
      lessonId.value,
    )
    ElMessage.success(`已打分 ${result.updated} 份`)
    selectedIds.value = []
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '批量打分失败')
  } finally {
    batchBusy.value = false
  }
}

/** 撤销审阅：把标签和分数一起清掉，回到「未评价」 */
async function clearReview() {
  if (selectedIds.value.length === 0) {
    ElMessage.warning('请先勾选要撤销的提交')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将清除选中的 ${selectedIds.value.length} 份提交的标签与分数，是否继续？`,
      '撤销审阅',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }

  batchBusy.value = true
  try {
    const result = await api.batchReviewSubmission(
      selectedIds.value,
      { label: '', score: null },
      lessonId.value,
    )
    ElMessage.success(`已撤销 ${result.updated} 份的审阅结果`)
    selectedIds.value = []
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '撤销失败')
  } finally {
    batchBusy.value = false
  }
}

/** 标签筛选按钮的计数 */
function labelCount(value: ReviewLabel | 'unreviewed' | ''): number {
  const s = stats.value
  if (!s) return 0
  if (value === '') return s.total
  if (value === 'unreviewed') return s.unreviewed
  return s[value]
}

/** 标签对应的 Element 配色 */
function labelTagType(label: string): 'success' | 'primary' | 'danger' | 'info' {
  const found = REVIEW_LABEL_META.find((item) => item.value === label)
  if (!found) return 'info'
  return found.type as 'success' | 'primary' | 'danger' | 'info'
}

/** 返回课程详情页 */
function goBack() {
  const courseId = board.value?.course_id
  if (courseId) router.push(`/admin/courses/${courseId}`)
  else router.back()
}

/** 分数显示：未打分为「—」 */
function scoreText(score: number | null): string {
  if (score === null || score === undefined) return '—'
  return Number.isInteger(score) ? String(score) : score.toFixed(1)
}

/** 单份的审阅输入（供子组件式调用） */
function reviewInput(partial: ReviewInput): ReviewInput {
  return partial
}
</script>

<template>
  <div class="review">
    <!-- 顶部：返回 + 标题 + 统计 -->
    <div class="review__head">
      <div class="review__head-left">
        <el-button link @click="goBack">← 返回课程</el-button>
        <h1 class="page-title review__title">
          {{ board?.lesson_title || '作业批改' }}
        </h1>
        <span v-if="board" class="review__sub">
          {{ board.course_title }}
          <template v-if="board.class_name"> · {{ board.class_name }}</template>
          <template v-if="board.roster_total > 0"> · 名单 {{ board.roster_total }} 人</template>
        </span>
      </div>

      <div class="review__head-right">
        <span class="review__label">班级</span>
        <el-select
          v-model="selectedClassId"
          placeholder="全部班级"
          clearable
          style="width: 180px"
          :loading="loading"
        >
          <el-option v-for="item in classes" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div v-if="stats" class="review__stats">
      <div class="review__stat">
        <span class="review__stat-num">{{ stats.total }}</span>
        <span class="review__stat-label">提交份数</span>
      </div>
      <div class="review__stat review__stat--warn">
        <span class="review__stat-num">{{ stats.unreviewed }}</span>
        <span class="review__stat-label">待批改</span>
      </div>
      <div class="review__stat review__stat--good">
        <span class="review__stat-num">{{ stats.good }}</span>
        <span class="review__stat-label">好</span>
      </div>
      <div class="review__stat review__stat--pass">
        <span class="review__stat-num">{{ stats.pass }}</span>
        <span class="review__stat-label">通过</span>
      </div>
      <div class="review__stat review__stat--fail">
        <span class="review__stat-num">{{ stats.fail }}</span>
        <span class="review__stat-label">不通过</span>
      </div>
      <div class="review__stat">
        <span class="review__stat-num">{{ stats.other }}</span>
        <span class="review__stat-label">其他</span>
      </div>
      <div class="review__stat">
        <span class="review__stat-num">{{ scoreText(stats.average_score) }}</span>
        <span class="review__stat-label">平均分</span>
      </div>
      <div v-if="board && board.roster_total > 0" class="review__stat review__stat--warn">
        <span class="review__stat-num">{{ stats.missing }}</span>
        <span class="review__stat-label">未交</span>
      </div>
    </div>

    <!-- 筛选与批量操作条 -->
    <div class="card review__bar">
      <div class="review__bar-left">
        <el-radio-group v-model="labelFilter" size="small">
          <el-radio-button value="">全部 {{ labelCount('') }}</el-radio-button>
          <el-radio-button value="unreviewed">
            待批改 {{ labelCount('unreviewed') }}
          </el-radio-button>
          <el-radio-button value="good">好 {{ labelCount('good') }}</el-radio-button>
          <el-radio-button value="pass">通过 {{ labelCount('pass') }}</el-radio-button>
          <el-radio-button value="fail">不通过 {{ labelCount('fail') }}</el-radio-button>
          <el-radio-button value="other">其他 {{ labelCount('other') }}</el-radio-button>
        </el-radio-group>

        <el-input
          v-model="keyword"
          placeholder="搜学号或姓名"
          clearable
          size="small"
          style="width: 180px"
        />
      </div>

      <div class="review__bar-right">
        <span v-if="selectedCount > 0" class="review__selected">
          已选 {{ selectedCount }} 份
        </span>
        <el-dropdown :disabled="selectedCount === 0 || batchBusy" trigger="click">
          <el-button
            type="primary"
            size="small"
            :disabled="selectedCount === 0"
            :loading="batchBusy"
          >
            批量打标签 ▾
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="meta in REVIEW_LABEL_META"
                :key="meta.value"
                @click="batchLabel(meta.value)"
              >
                {{ meta.text }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button size="small" :disabled="selectedCount === 0" :loading="batchBusy" @click="batchScore">
          批量打分
        </el-button>
        <el-button size="small" :disabled="selectedCount === 0" :loading="batchBusy" @click="clearReview">
          撤销审阅
        </el-button>
      </div>
    </div>

    <!-- 提交列表 -->
    <div class="card">
      <div v-if="loading" class="empty-state">正在加载…</div>

      <template v-else-if="board">
        <div v-if="board.items.length === 0" class="empty-state">
          本课时还没有学生提交作业。
        </div>

        <div v-else-if="visibleItems.length === 0" class="empty-state">
          当前筛选条件下没有提交，试试切到「全部」。
        </div>

        <el-table
          v-else
          :data="visibleItems"
          size="small"
          row-key="id"
          max-height="560"
          @row-click="openItem"
        >
          <el-table-column width="44">
            <template #header>
              <el-checkbox
                v-model="allChecked"
                :indeterminate="someChecked"
                @click.stop
              />
            </template>
            <template #default="{ row }">
              <el-checkbox
                v-model="selectedIds"
                :value="row.id"
                @click.stop
              />
            </template>
          </el-table-column>

          <el-table-column label="学号" width="110">
            <template #default="{ row }">
              <span class="mono">{{ row.student_no || '—' }}</span>
            </template>
          </el-table-column>

          <el-table-column prop="student_name" label="姓名" width="100" show-overflow-tooltip />

          <el-table-column label="文件" width="90">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click.stop="openItem(row)">
                {{ row.file_count }} 个
              </el-button>
            </template>
          </el-table-column>

          <el-table-column label="提交时间" width="160">
            <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
          </el-table-column>

          <el-table-column label="来源 IP" width="120">
            <template #default="{ row }">
              <span class="mono">{{ row.client_ip || '—' }}</span>
            </template>
          </el-table-column>

          <el-table-column label="分数" width="80">
            <template #default="{ row }">
              <span :class="{ 'review__score': row.review_score !== null }">
                {{ scoreText(row.review_score) }}
              </span>
            </template>
          </el-table-column>

          <el-table-column label="标签" min-width="230">
            <template #default="{ row }">
              <div class="review__tags" @click.stop>
                <el-tag
                  v-for="meta in REVIEW_LABEL_META"
                  :key="meta.value"
                  size="small"
                  :type="row.review_label === meta.value ? labelTagType(meta.value) : 'info'"
                  :effect="row.review_label === meta.value ? 'dark' : 'plain'"
                  class="review__tag-btn"
                  @click="labelOne(row, meta.value)"
                >
                  {{ meta.text }}
                </el-tag>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="备注" width="90">
            <template #default="{ row }">
              <el-tag v-if="row.duplicate_flag === 1" size="small" type="warning" effect="plain">
                重复
              </el-tag>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
      </template>

      <div v-else class="empty-state">没有可批改的数据。</div>
    </div>

    <!-- 逐份详情抽屉：不遮住列表，教师可以边看列表边批 -->
    <el-drawer v-model="drawerVisible" :title="active?.student_name || '提交详情'" size="640px">
      <div v-if="active" class="detail">
        <div class="detail__meta">
          <span>{{ active.course_title }} · {{ active.lesson_title }}</span>
          <span v-if="active.class_name">· {{ active.class_name }}</span>
        </div>

        <div class="detail__rows">
          <div class="detail__row">
            <span class="detail__label">学号</span>
            <span class="detail__value mono">{{ active.student_no || '—' }}</span>
          </div>
          <div class="detail__row">
            <span class="detail__label">提交时间</span>
            <span class="detail__value">{{ formatTime(active.created_at) }}</span>
          </div>
          <div class="detail__row">
            <span class="detail__label">来源 IP</span>
            <span class="detail__value mono">{{ active.client_ip || '—' }}</span>
          </div>
          <div v-if="active.note" class="detail__row">
            <span class="detail__label">学生备注</span>
            <span class="detail__value">{{ active.note }}</span>
          </div>
        </div>

        <el-alert
          v-if="active.duplicate_flag === 1"
          :title="`该课时已有其他人提交（${active.duplicate_of_name || '其他同学'}，编号 ${active.duplicate_of}）`"
          type="warning"
          :closable="false"
          show-icon
        />

        <h3 class="detail__section">文件预览</h3>
        <SubmissionPreview :detail="active" />

        <h3 class="detail__section">批改</h3>
        <div class="detail__review">
          <div class="detail__review-row">
            <span class="detail__label">标签</span>
            <div class="detail__review-tags">
              <el-tag
                v-for="meta in REVIEW_LABEL_META"
                :key="meta.value"
                size="large"
                :type="active.review_label === meta.value ? labelTagType(meta.value) : 'info'"
                :effect="active.review_label === meta.value ? 'dark' : 'plain'"
                class="review__tag-btn"
                @click="labelOne(active, meta.value)"
              >
                {{ meta.text }}
              </el-tag>
            </div>
          </div>

          <div class="detail__review-row">
            <span class="detail__label">分数</span>
            <el-input-number
              v-model="editScore"
              :min="0"
              :max="100"
              :precision="1"
              :step="1"
              controls-position="right"
              style="width: 140px"
            />
            <span class="detail__hint">留空表示不打分</span>
          </div>

          <div class="detail__review-row detail__review-row--stack">
            <span class="detail__label">评语</span>
            <el-input
              v-model="editComment"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              placeholder="写给学生的反馈，可留空"
            />
          </div>

          <div class="detail__review-actions">
            <el-button type="primary" :loading="saving" @click="saveScoreAndComment">
              保存分数与评语
            </el-button>
            <span v-if="active.reviewed_at" class="detail__hint">
              上次批改：{{ formatTime(active.reviewed_at) }}
            </span>
          </div>
        </div>
      </div>

      <div v-else class="empty-state">提交已不存在，可能已被删除。</div>
    </el-drawer>
  </div>
</template>

<style scoped>
.review {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.review__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.review__head-left {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.review__title {
  margin: 0;
}

.review__sub {
  font-size: 13px;
  color: var(--text-sub);
}

.review__head-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.review__label {
  font-size: 13px;
  color: var(--text-sub);
}

/* 统计卡片 */
.review__stats {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.review__stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 82px;
  padding: 10px 14px;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.review__stat-num {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.review__stat-label {
  font-size: 12px;
  color: var(--text-sub);
}

.review__stat--warn .review__stat-num {
  color: #e6a23c;
}

.review__stat--good .review__stat-num {
  color: #67c23a;
}

.review__stat--pass .review__stat-num {
  color: var(--brand);
}

.review__stat--fail .review__stat-num {
  color: #f56c6c;
}

/* 操作条 */
.review__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.review__bar-left,
.review__bar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.review__selected {
  font-size: 13px;
  color: var(--brand);
  font-weight: 600;
}

/* 行内标签按钮 */
.review__tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.review__tag-btn {
  cursor: pointer;
  user-select: none;
}

.review__tag-btn:hover {
  opacity: 0.82;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.muted {
  color: var(--text-sub);
}

.review__score {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* 抽屉内详情 */
.detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.detail__meta {
  font-size: 13px;
  color: var(--text-sub);
}

.detail__rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: #fafbfc;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.detail__row {
  display: flex;
  gap: 10px;
  font-size: 13px;
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

.detail__section {
  margin: 4px 0 0;
  font-size: 14px;
}

/*
 * 抽屉里的预览压低高度。
 *
 * SubmissionPreview 默认按 58vh 渲染，在抽屉这种窄高容器里会把
 * 下面的批改区挤出屏幕，教师得先滚动才能打分。
 * 压到 240px 让「预览 + 标签 + 分数 + 评语」尽量同屏可见。
 */
.detail :deep(.preview__body) {
  max-height: 240px;
  min-height: 160px;
}

.detail :deep(.preview__image),
.detail :deep(.preview__video) {
  max-height: 230px;
}

.detail :deep(.preview__frame) {
  height: 240px;
}

.detail__review {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail__review-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.detail__review-row--stack {
  align-items: flex-start;
}

.detail__review-tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.detail__review-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.detail__hint {
  font-size: 12px;
  color: var(--text-sub);
}
</style>
