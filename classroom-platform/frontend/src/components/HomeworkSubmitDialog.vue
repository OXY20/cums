<script setup lang="ts">
/**
 * 作业上传弹窗。
 *
 * 流程：
 * 1. 打开时查询「本课时本班级是否已有提交」，有则先给出提醒；
 * 2. 学生填写姓名、选择多个文件（视频 / 图片 / 文件均可），可加备注；
 * 3. 上传中显示进度，上传成功后关闭本弹窗并交由父组件弹出预览。
 *
 * 姓名会记住在 localStorage，同一台机房电脑下次提交无需重复输入。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage, type UploadFile, type UploadUserFile } from 'element-plus'
import { api, type CreateSubmissionResponse, type LessonSubmissionStatus } from '@/api'
import { formatBytes } from '@/utils/format'

const props = defineProps<{
  modelValue: boolean
  lessonId: number | null
  lessonTitle: string
  /** 班级 ID：有活动课堂时由父组件传入，用于「本班已提交」判断 */
  classId?: number | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 提交成功，父组件据此弹出预览 */
  submitted: [payload: CreateSubmissionResponse]
}>()

/** 姓名持久化键：机房电脑多人共用，仍按姓名区分提交 */
const NAME_KEY = 'classroom.student.name'

const studentName = ref(localStorage.getItem(NAME_KEY) ?? '')
const note = ref('')
const fileList = ref<UploadUserFile[]>([])
const uploading = ref(false)
const progress = ref(0)
const status = ref<LessonSubmissionStatus | null>(null)
const statusLoading = ref(false)

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

/**
 * 已选择的原始文件。
 *
 * `UploadUserFile.raw` 的类型是 `UploadRawFile | undefined`，
 * 显式收窄后各处的 file.size / file.name 才不需要重复判空。
 */
const selectedFiles = computed<File[]>(() => {
  const list: File[] = []
  for (const item of fileList.value) {
    const raw = item.raw as File | undefined
    if (raw instanceof File) list.push(raw)
  }
  return list
})

const totalBytes = computed(() => selectedFiles.value.reduce((sum, file) => sum + file.size, 0))

/** 本班已有提交时的提醒文案 */
const duplicateHint = computed(() => {
  const first = status.value?.first_submission
  if (!first) return ''
  return `本节课本班级已有 ${status.value?.total} 人提交，最早由「${first.student_name}」于 ${first.created_at} 提交。`
})

/** 打开弹窗时刷新状态并恢复姓名 */
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    studentName.value = localStorage.getItem(NAME_KEY) ?? ''
    note.value = ''
    fileList.value = []
    progress.value = 0
    await loadStatus()
  },
)

async function loadStatus() {
  if (props.lessonId === null) return
  statusLoading.value = true
  try {
    status.value = await api.lessonSubmissionStatus(props.lessonId, props.classId ?? null)
  } catch {
    // 状态查询失败不阻断提交，重复检测仍在服务端执行
    status.value = null
  } finally {
    statusLoading.value = false
  }
}

/** el-upload 的变更回调：保留完整文件列表 */
function onFilesChange(files: UploadFile[], list: UploadUserFile[]) {
  fileList.value = list
  // 超过服务端上限时提前提示，避免上传到一半才失败
  if (files.length > 10) {
    ElMessage.warning('一次最多提交 10 个文件')
  }
}

function removeFile(index: number) {
  fileList.value = fileList.value.filter((_, i) => i !== index)
}

/** 单个文件大小上限（与服务端 storage.max_file_bytes 默认值一致） */
const MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024

async function submit() {
  const name = studentName.value.trim()
  if (!name) {
    ElMessage.warning('请填写提交人姓名')
    return
  }
  if (props.lessonId === null) {
    ElMessage.warning('未选择课时，无法提交')
    return
  }
  if (selectedFiles.value.length === 0) {
    ElMessage.warning('请至少选择一个文件')
    return
  }
  if (selectedFiles.value.length > 10) {
    ElMessage.warning('一次最多提交 10 个文件')
    return
  }
  const oversized = selectedFiles.value.find((file) => file.size > MAX_FILE_BYTES)
  if (oversized) {
    ElMessage.warning(`文件「${oversized.name}」超出大小上限`)
    return
  }

  uploading.value = true
  progress.value = 0
  try {
    const result = await api.submitHomework(
      {
        studentName: name,
        lessonId: props.lessonId,
        classId: props.classId ?? null,
        note: note.value.trim(),
        files: selectedFiles.value,
      },
      (percent) => {
        progress.value = percent
      },
    )

    localStorage.setItem(NAME_KEY, name)

    if (result.duplicate_warning) {
      ElMessage.warning(result.duplicate_warning)
    } else {
      ElMessage.success('作业提交成功')
    }

    visible.value = false
    emit('submitted', result)
    await loadStatus()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '提交失败')
  } finally {
    uploading.value = false
  }
}

function close() {
  if (uploading.value) return
  visible.value = false
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="提交作业"
    width="620px"
    :close-on-click-modal="false"
    :show-close="!uploading"
    @close="close"
  >
    <div class="submit-form">
      <!-- 重复提交提醒 -->
      <el-alert
        v-if="duplicateHint"
        type="warning"
        :closable="false"
        show-icon
        class="submit-form__alert"
      >
        <template #title>本班已有人提交本节课作业</template>
        {{ duplicateHint }}继续提交仍会保存，但会被标记为重复提交，教师可在后台查看。
      </el-alert>

      <p class="submit-form__lesson">
        课时：<strong>{{ lessonTitle || '未选择' }}</strong>
      </p>

      <el-form label-width="88px" label-position="left">
        <el-form-item label="姓名" required>
          <el-input
            v-model="studentName"
            placeholder="请输入你的姓名"
            maxlength="40"
            show-word-limit
            :disabled="uploading"
          />
        </el-form-item>

        <el-form-item label="作业文件" required>
          <el-upload
            v-model:file-list="fileList"
            :auto-upload="false"
            multiple
            :disabled="uploading"
            :on-change="onFilesChange"
            :show-file-list="false"
          >
            <el-button :disabled="uploading">选择文件</el-button>
            <template #tip>
              <div class="submit-form__tip">
                可一次选择多个文件，支持视频、图片、文档、压缩包等；单文件最大 20 GiB。
              </div>
            </template>
          </el-upload>
        </el-form-item>

        <!-- 已选文件列表 -->
        <el-form-item v-if="fileList.length > 0" label="已选择">
          <div class="submit-form__files">
            <div v-for="(item, index) in fileList" :key="`${item.name}-${index}`" class="submit-form__file">
              <span class="submit-form__file-name" :title="item.name">{{ item.name }}</span>
              <span class="submit-form__file-size">{{ formatBytes(item.size ?? 0) }}</span>
              <el-button
                link
                size="small"
                type="danger"
                :disabled="uploading"
                @click="removeFile(index)"
              >
                移除
              </el-button>
            </div>
            <div class="submit-form__total">
              共 {{ fileList.length }} 个文件，合计 {{ formatBytes(totalBytes) }}
            </div>
          </div>
        </el-form-item>

        <el-form-item label="备注">
          <el-input
            v-model="note"
            type="textarea"
            :rows="2"
            maxlength="500"
            show-word-limit
            placeholder="选填，例如说明文件内容或遇到的问题"
            :disabled="uploading"
          />
        </el-form-item>

        <el-form-item v-if="uploading" label="进度">
          <el-progress :percentage="progress" :stroke-width="14" style="width: 100%" />
        </el-form-item>
      </el-form>

      <p class="submit-form__privacy">
        提交时系统会记录你的来源 IP 与提交时间，仅用于教师核对作业归属。
      </p>
    </div>

    <template #footer>
      <el-button :disabled="uploading" @click="close">取消</el-button>
      <el-button type="primary" :loading="uploading" @click="submit">
        {{ uploading ? '正在提交…' : '确认提交' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.submit-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.submit-form__alert {
  margin-bottom: 8px;
}

.submit-form__lesson {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--text-sub);
}

.submit-form__tip {
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
  margin-top: 4px;
}

.submit-form__files {
  width: 100%;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px 10px;
  background: #fafbfc;
}

.submit-form__file {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  font-size: 13px;
}

.submit-form__file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.submit-form__file-size {
  flex: none;
  color: var(--text-sub);
  font-size: 12px;
}

.submit-form__total {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--border-color);
  font-size: 12px;
  color: var(--text-sub);
}

.submit-form__privacy {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
}
</style>
