<script setup lang="ts">
/**
 * 提交成功后的预览弹窗。
 *
 * 上传成功后立即展示，让学生确认文件已正确上传：
 * - 图片 / 视频 / PDF 直接内嵌预览；
 * - 其他类型给出下载入口；
 * - 顶部展示提交人、时间、来源 IP 与重复标记，信息与教师后台一致。
 */
import { computed } from 'vue'
import { fileUrl, type CreateSubmissionResponse } from '@/api'
import { formatBytes, formatTime, submissionStatusText } from '@/utils/format'
import SubmissionPreview from '@/components/SubmissionPreview.vue'

const props = defineProps<{
  modelValue: boolean
  result: CreateSubmissionResponse | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const detail = computed(() => props.result?.submission ?? null)

/** 是否被标记为重复提交 */
const isDuplicate = computed(() => (detail.value?.duplicate_flag ?? 0) === 1)

const fileSummary = computed(() => {
  const files = detail.value?.files ?? []
  const total = files.reduce((sum, file) => sum + file.size_bytes, 0)
  return `${files.length} 个文件 · ${formatBytes(total)}`
})

function downloadAll() {
  for (const file of detail.value?.files ?? []) {
    window.open(fileUrl(file.resource_id), '_blank')
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="作业已提交" width="760px" top="6vh">
    <div v-if="detail" class="result">
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
          </span>
        </div>
        <div v-if="detail.note" class="result__meta-row">
          <span class="result__label">备注</span>
          <span class="result__value">{{ detail.note }}</span>
        </div>
      </div>

      <!-- 文件预览 -->
      <h3 class="result__section">文件预览</h3>
      <SubmissionPreview :detail="detail" />
    </div>

    <template #footer>
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
