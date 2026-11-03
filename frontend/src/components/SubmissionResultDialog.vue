<script setup lang="ts">
/**
 * 提交成功后的预览弹窗。
 *
 * 上传成功后立即展示，让学生确认文件已正确上传：
 * - 图片 / 视频 / PDF 直接内嵌预览；
 * - 其他类型给出下载入口；
 * - 顶部展示提交人、时间、来源 IP 与重复标记，信息与教师后台一致。
 *
 * 学生端没有登录态，本次提交的访问凭证（`access_token`）决定了
 * 学生能否回读、撤回自己的作业、下载作业文件。凭证随结果一起传进来，
 * 文件预览与下载地址都带上它；凭证由父组件负责持久化保存。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  api,
  fileUrl,
  setActiveSubmissionToken,
  type CreateSubmissionResponse,
} from '@/api'
import { formatBytes, formatTime, submissionStatusText } from '@/utils/format'
import SubmissionPreview from '@/components/SubmissionPreview.vue'

const props = defineProps<{
  modelValue: boolean
  result: CreateSubmissionResponse | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 撤回成功：父组件据此提示并刷新提交状态 */
  withdrawn: [payload: { submissionId: number; lessonId: number }]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const detail = computed(() => props.result?.submission ?? null)

/** 本次提交的访问凭证，用于文件下载与撤回 */
const accessToken = computed(() => props.result?.access_token ?? '')

/** 撤回截止时间；服务端未提供时为 null */
const withdrawDeadline = computed(() => props.result?.withdraw_deadline ?? null)

/** 是否已撤回 */
const isWithdrawn = computed(() => Boolean(detail.value?.withdrawn_at))

/** 撤回请求进行中 */
const withdrawing = ref(false)

/**
 * 撤回截止时间是否仍然有效。
 *
 * 截止时间是服务端时间（UTC，可能带也可能不带时区标记），
 * 解析方式与 `formatTime` 保持一致，避免时区偏差导致误判。
 */
function parseServerTime(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)
  const iso = hasZone ? text : `${text.replace(' ', 'T')}Z`
  const time = new Date(iso).getTime()
  return Number.isNaN(time) ? null : time
}

/** 是否还能撤回：有截止时间、未过期、且尚未撤回 */
const canWithdraw = computed(() => {
  if (isWithdrawn.value) return false
  const deadline = withdrawDeadline.value
  if (!deadline) return false
  const time = parseServerTime(deadline)
  return time !== null && time > Date.now()
})

/** 撤回截止时间的展示文案 */
const withdrawDeadlineText = computed(() => {
  const deadline = withdrawDeadline.value
  return deadline ? formatTime(deadline) : ''
})

/** 是否被标记为重复提交 */
const isDuplicate = computed(() => (detail.value?.duplicate_flag ?? 0) === 1)

/**
 * 把当前查看的提交凭证登记到 API 模块。
 *
 * 这样预览组件里图片 / 视频 / PDF 的内联地址也会带上凭证，
 * 而无需改动只读的 `SubmissionPreview.vue`。弹窗关闭时清空，
 * 避免离开后教学资源或其它页面的下载被误加上凭证。
 */
watch(
  () => [visible.value, accessToken.value] as const,
  ([open, token]) => setActiveSubmissionToken(open ? token : null),
  { immediate: true },
)

onBeforeUnmount(() => setActiveSubmissionToken(null))

const fileSummary = computed(() => {
  const files = detail.value?.files ?? []
  const total = files.reduce((sum, file) => sum + file.size_bytes, 0)
  return `${files.length} 个文件 · ${formatBytes(total)}`
})

function downloadAll() {
  for (const file of detail.value?.files ?? []) {
    window.open(fileUrl(file.resource_id, accessToken.value), '_blank')
  }
}

/** 撤回本次提交：确认后调用接口，失败时把后端 message 原样展示 */
async function withdraw() {
  const current = detail.value
  if (!current || withdrawing.value) return
  if (!accessToken.value) {
    ElMessage.error('缺少提交凭证，无法撤回')
    return
  }

  try {
    await ElMessageBox.confirm(
      '撤回后教师将看不到这份作业，如需重新提交请撤回后再交一次。确定撤回吗？',
      '撤回这次提交？',
      {
        confirmButtonText: '撤回提交',
        cancelButtonText: '保留提交',
        type: 'warning',
      },
    )
  } catch {
    return
  }

  withdrawing.value = true
  try {
    await api.withdrawSubmission(current.id, accessToken.value)
    ElMessage.success('已撤回')
    emit('withdrawn', { submissionId: current.id, lessonId: current.lesson_id })
    visible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '撤回失败')
  } finally {
    withdrawing.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="作业已提交" width="760px" top="6vh">
    <div v-if="detail" class="result">
      <!-- 凭证说明：不夸大作用，讲清「能撤回、能重看」即可 -->
      <div class="result__voucher">
        <span class="result__voucher-icon">✓</span>
        <div class="result__voucher-text">
          <p class="result__voucher-title">作业已提交，教师可以查看这份作业了。</p>
          <p class="result__voucher-hint">
            <template v-if="canWithdraw">
              在 {{ withdrawDeadlineText }} 之前可以撤回；撤回入口在本窗口。
            </template>
            <template v-else-if="isWithdrawn">这份提交已经撤回，教师端不再显示。</template>
            <template v-else>本次提交已超过可撤回时间，如需修改请联系教师。</template>
          </p>
        </div>
        <span v-if="isWithdrawn" class="result__withdrawn-tag">已撤回</span>
      </div>

      <!-- 重复提交提示：不指名道姓，避免暴露其他同学的提交信息 -->
      <el-alert
        v-if="isDuplicate"
        type="warning"
        :closable="false"
        show-icon
        class="result__alert"
      >
        <template #title>本次提交已标记为重复</template>
        本节课该设备或本班已有提交，你的这次提交已保存，教师可在后台核对每次记录。
      </el-alert>

      <!-- 提交信息 -->
      <div class="result__meta">
        <div class="result__meta-row">
          <span class="result__label">提交人</span>
          <span class="result__value">{{ detail.student_name }}</span>
        </div>
        <div class="result__meta-row">
          <span class="result__label">课时</span>
          <span class="result__value">{{ detail.course_title }} · {{ detail.lesson_title }}</span>
        </div>
        <div class="result__meta-row">
          <span class="result__label">提交时间</span>
          <span class="result__value">{{ formatTime(detail.created_at) }}</span>
        </div>
        <div class="result__meta-row">
          <span class="result__label">来源 IP</span>
          <span class="result__value result__value--mono">{{ detail.client_ip }}</span>
        </div>
        <div class="result__meta-row">
          <span class="result__label">文件</span>
          <span class="result__value">{{ fileSummary }}</span>
        </div>
        <div class="result__meta-row">
          <span class="result__label">状态</span>
          <span class="result__value">
            <span class="status-tag" :class="`status-tag--${detail.status}`">
              {{ submissionStatusText(detail.status) }}
            </span>
            <span v-if="isDuplicate" class="result__dup-tag">重复提交</span>
            <span v-if="isWithdrawn" class="result__dup-tag">已撤回</span>
          </span>
        </div>
        <div v-if="isWithdrawn && detail.withdrawn_at" class="result__meta-row">
          <span class="result__label">撤回时间</span>
          <span class="result__value">{{ formatTime(detail.withdrawn_at) }}</span>
        </div>
        <div v-if="detail.note" class="result__meta-row">
          <span class="result__label">备注</span>
          <span class="result__value">{{ detail.note }}</span>
        </div>
      </div>

      <!-- 文件预览：预览与下载地址都要带提交凭证，否则服务端拒绝匿名访问 -->
      <h3 class="result__section">文件预览</h3>
      <SubmissionPreview :detail="detail" />
    </div>

    <template #footer>
      <el-button
        v-if="canWithdraw"
        type="danger"
        plain
        :loading="withdrawing"
        @click="withdraw"
      >
        撤回提交
      </el-button>
      <el-button v-if="(detail?.files?.length ?? 0) > 1" @click="downloadAll">
        全部下载
      </el-button>
      <el-button type="primary" @click="visible = false">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.result {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 顶部凭证说明条 */
.result__voucher {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  background: var(--brand-soft, #eef5ff);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.result__voucher-icon {
  flex: none;
  width: 22px;
  height: 22px;
  line-height: 22px;
  text-align: center;
  border-radius: 50%;
  background: var(--brand, #2b6cb0);
  color: #fff;
  font-size: 13px;
}

.result__voucher-text {
  flex: 1;
  min-width: 0;
}

.result__voucher-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.result__voucher-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
}

.result__withdrawn-tag {
  flex: none;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 11px;
  color: #a8071a;
  background: #fff1f0;
}

.result__alert {
  margin-bottom: 2px;
}

.result__meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 20px;
  padding: 12px 14px;
  background: #fafbfc;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.result__meta-row {
  display: flex;
  gap: 10px;
  font-size: 13px;
  min-width: 0;
}

.result__label {
  flex: none;
  width: 60px;
  color: var(--text-sub);
}

.result__value {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.result__value--mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.result__dup-tag {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  color: #b26a00;
  background: #fff4e0;
}

.result__section {
  margin: 4px 0 0;
  font-size: 14px;
}

@media (max-width: 640px) {
  .result__meta {
    grid-template-columns: 1fr;
  }
}
</style>
