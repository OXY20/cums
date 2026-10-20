<script setup lang="ts">
/**
 * 作业上传弹窗。
 *
 * 流程：
 * 1. 打开时查询「当前这台设备是否已提交过本节课作业」，有则提醒；
 * 2. 学生填写姓名、选择多个文件，选中后立即在弹窗内预览内容；
 * 3. 上传中显示进度、实时速度与预计剩余时间，上传成功后关闭本弹窗并交由父组件弹出预览。
 *
 * 提示语义是「当前设备已提交」而不是「班里谁最早交」：
 * 机房电脑多人轮用，按设备判断才能让学生确认自己是否已交；
 * 班里其他人的提交情况属于教师视角，学生端不指名展示。
 *
 * 姓名与设备标识都保存在 localStorage，同一台机器下次无需重复输入。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { ElMessage, type UploadFile, type UploadUserFile } from 'element-plus'
import {
  api,
  type ClassStudent,
  type CreateSubmissionResponse,
  type LessonSubmissionStatus,
  type UploadProgress,
} from '@/api'
import { formatBytes, formatRemaining, formatSpeed, formatTime } from '@/utils/format'

const props = defineProps<{
  modelValue: boolean
  lessonId: number | null
  lessonTitle: string
  /** 班级 ID：有活动课堂时由父组件传入，用于区分班内提交 */
  classId?: number | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 提交成功，父组件据此弹出预览 */
  submitted: [payload: CreateSubmissionResponse]
}>()

/** 姓名持久化键：机房电脑多人共用，仍按姓名区分提交 */
const NAME_KEY = 'classroom.student.name'
/** 学号持久化键：与姓名一起记住，下次自动带出 */
const NO_KEY = 'classroom.student.no'
/** 设备标识持久化键：用于识别「这台机器」是否已提交 */
const DEVICE_KEY = 'classroom.device.id'

/**
 * 取得本机设备标识。
 *
 * 首次访问时生成随机串并持久化，之后同一浏览器的所有提交都带同一标识。
 * localStorage 不可用（隐私模式）时退化为每次生成新值，
 * 此时服务端仍会按 IP 识别设备。
 */
function resolveDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY)
    if (existing) return existing
    const generated =
      globalThis.crypto?.randomUUID?.() ??
      `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(DEVICE_KEY, generated)
    return generated
  } catch {
    return ''
  }
}

const deviceId = ref(resolveDeviceId())
const studentName = ref(localStorage.getItem(NAME_KEY) ?? '')
const studentNo = ref(localStorage.getItem(NO_KEY) ?? '')
const note = ref('')
const fileList = ref<UploadUserFile[]>([])
const uploading = ref(false)
const progress = ref(0)
const status = ref<LessonSubmissionStatus | null>(null)
const statusLoading = ref(false)

// ---------------------------------------------------------------------------
// 班级名单：有名单时让学生选自己，避免姓名手误导致教师无法统计
// ---------------------------------------------------------------------------

/** 当前班级的名单 */
const roster = ref<ClassStudent[]>([])
const rosterLoading = ref(false)

/** 有活动课堂且班级有名单时，才提供下拉选择 */
const hasRoster = computed(() => roster.value.length > 0)

/** 按学号或姓名过滤名单 */
function filterRoster(query: string, item: ClassStudent): boolean {
  if (!query) return true
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    item.student_no.toLowerCase().includes(q) || item.student_name.toLowerCase().includes(q)
  )
}

/** 选中名单中的学生后回填学号与姓名 */
function onPickStudent(value: string) {
  const found = roster.value.find((item) => item.student_no === value)
  if (!found) return
  studentNo.value = found.student_no
  studentName.value = found.student_name
}

/** 加载班级名单；没有班级或没有名单时静默降级为手填 */
async function loadRoster() {
  roster.value = []
  if (!props.classId) return
  rosterLoading.value = true
  try {
    const result = await api.classStudents(props.classId)
    roster.value = result.items
    // 记住的学号若不在本班名单里，说明换了班级或名单已变更。
    // 此时学号与姓名都要清掉：姓名往往是从上一个班的名单带出来的，
    // 留着会让下一个班的学生以别人的身份提交。
    if (studentNo.value && !roster.value.some((s) => s.student_no === studentNo.value)) {
      studentNo.value = ''
      studentName.value = ''
    }
  } catch {
    // 名单加载失败不阻断提交：学生仍可手填姓名
    roster.value = []
  } finally {
    rosterLoading.value = false
  }
}

// ---------------------------------------------------------------------------
// 上传速度与剩余时间
// ---------------------------------------------------------------------------
//
// 进度事件只给出「已传多少字节」，速度需要自己按时间窗口算。
// 这里用最近 3 秒的滑动窗口而不是「总字节 / 总耗时」：
// 后者会把开头的握手延迟摊到整个传输上，速度显示偏低且几乎不动，
// 学生看不出网络是在正常跑还是卡住了。

/** 已上传字节数 */
const uploadedBytes = ref(0)
/** 总字节数 */
const totalUploadBytes = ref(0)
/** 当前速度（字节/秒） */
const bytesPerSecond = ref(0)
/** 预计剩余秒数；null 表示暂时无法估算 */
const remainingSeconds = ref<number | null>(null)

/** 速度采样点：{ 时间戳, 累计字节 } */
interface SpeedSample {
  at: number
  loaded: number
}

const SAMPLES: SpeedSample[] = []
/** 滑动窗口长度：3 秒足够平滑，又不会迟钝到看不出变化 */
const WINDOW_MS = 3000

/** 重置速度统计 */
function resetSpeed() {
  SAMPLES.length = 0
  uploadedBytes.value = 0
  totalUploadBytes.value = 0
  bytesPerSecond.value = 0
  remainingSeconds.value = null
}

/**
 * 记录一次进度并更新速度与剩余时间。
 *
 * 采样点按时间窗口裁剪，速度取窗口首尾的差值，
 * 而不是相邻两次事件——后者在小分块传输时会剧烈跳动。
 */
function updateSpeed(progressInfo: UploadProgress) {
  const { loaded, total } = progressInfo
  uploadedBytes.value = loaded
  totalUploadBytes.value = total

  const now = performance.now()
  SAMPLES.push({ at: now, loaded })

  // 丢掉窗口外的旧采样点，但保留窗口外的最后一个作为窗口起点，
  // 否则刚裁剪完就没有基准点，速度会瞬间变成 0。
  while (SAMPLES.length > 2 && now - SAMPLES[1].at > WINDOW_MS) {
    SAMPLES.shift()
  }

  const first = SAMPLES[0]
  const elapsedMs = now - first.at
  const deltaBytes = loaded - first.loaded

  if (elapsedMs < 300 || deltaBytes <= 0) {
    // 刚开始或数据还没攒够，先不给速度，避免显示夸张的数字
    return
  }

  const speed = (deltaBytes / elapsedMs) * 1000
  bytesPerSecond.value = speed

  const rest = total - loaded
  remainingSeconds.value = speed > 0 ? rest / speed : null
}

/** 速度展示文案 */
const speedText = computed(() => formatSpeed(bytesPerSecond.value))

/** 剩余时间展示文案 */
const remainingText = computed(() => {
  // 上传已完成时不再显示倒计时
  if (progress.value >= 100) return '即将完成'
  if (remainingSeconds.value === null) return '计算中…'
  return formatRemaining(remainingSeconds.value)
})

/** 已传 / 总量文案 */
const transferredText = computed(() => {
  if (totalUploadBytes.value <= 0) return ''
  return `${formatBytes(uploadedBytes.value)} / ${formatBytes(totalUploadBytes.value)}`
})

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

/** 本设备已提交时的提醒文案 */
const deviceHint = computed(() => {
  const device = status.value?.device
  if (!device) return ''
  const latest = device.latest
  const times = device.total > 1 ? `（共 ${device.total} 次）` : ''
  return `当前这台设备已提交过本节课作业：${latest.student_name}，${formatTime(latest.created_at)}${times}。`
})

/** 本班提交人数，仅作背景参考，不含姓名 */
const classHint = computed(() => {
  const total = status.value?.class_total ?? 0
  if (total === 0) return ''
  return `本班已有 ${total} 份提交。`
})

// ---------------------------------------------------------------------------
// 选中文件后即时本地预览
// ---------------------------------------------------------------------------

/** 每个已选文件的本地预览信息 */
interface LocalPreivew {
  /** 选择时的稳定键，用于列表渲染 */
  key: string
  file: File
  /** 按 MIME 与扩展名判定的预览类型 */
  kind: 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other'
  /** object URL；非图片/视频/音频时为空 */
  url: string
  /** 文本文件的首段内容 */
  text?: string
  /** 是否读取失败 */
  failed?: boolean
}

const previews = ref<LocalPreivew[]>([])
/** 当前预览的文件键 */
const activePreviewKey = ref<string>('')

const activePreview = computed(
  () => previews.value.find((item) => item.key === activePreviewKey.value) ?? previews.value[0] ?? null,
)

/** 按文件类型判定预览方式 */
function detectKind(file: File): LocalPreivew['kind'] {
  const type = file.type
  const name = file.name.toLowerCase()
  if (type.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|svg|avif)$/.test(name)) return 'image'
  if (type.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/.test(name)) return 'video'
  if (type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac)$/.test(name)) return 'audio'
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (type.startsWith('text/') || /\.(txt|log|md|csv|json|xml|yml|yaml)$/.test(name)) return 'text'
  return 'other'
}

/** 释放已创建的 object URL，避免内存泄漏 */
function revokeUrls(items: LocalPreivew[]) {
  for (const item of items) {
    if (item.url) URL.revokeObjectURL(item.url)
  }
}

/** 重建本地预览：文件列表变化时整体重建，逻辑简单且不会残留旧 URL */
async function rebuildPreviews() {
  const files = selectedFiles.value
  const keys = new Set(files.map((file) => fileKey(file)))

  // 只保留仍存在的文件预览，避免重复读盘
  const kept = previews.value.filter((item) => keys.has(item.key))
  const removed = previews.value.filter((item) => !keys.has(item.key))
  revokeUrls(removed)

  const existing = new Map(kept.map((item) => [item.key, item]))
  const next: LocalPreivew[] = []

  for (const file of files) {
    const key = fileKey(file)
    const cached = existing.get(key)
    if (cached) {
      next.push(cached)
      continue
    }

    const kind = detectKind(file)
    const item: LocalPreivew = { key, file, kind, url: '' }

    // 图片、视频、音频直接用 object URL，浏览器原生渲染
    if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') {
      item.url = URL.createObjectURL(file)
    }

    // 文本类读取前 4000 字符做纯文本预览
    if (kind === 'text') {
      try {
        const text = await file.slice(0, 8000).text()
        item.text = text.slice(0, 4000)
      } catch {
        item.failed = true
      }
    }

    next.push(item)
  }

  previews.value = next

  // 当前预览项被删除时，自动切到第一项
  if (!next.some((item) => item.key === activePreviewKey.value)) {
    activePreviewKey.value = next[0]?.key ?? ''
  }
}

/** 文件键：同名同大小同修改时间的文件视为同一个 */
function fileKey(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}`
}

/** el-upload 的变更回调：保留完整文件列表并刷新预览 */
async function onFilesChange(files: UploadFile[], list: UploadUserFile[]) {
  fileList.value = list
  if (files.length > 10) ElMessage.warning('一次最多提交 10 个文件')
  await rebuildPreviews()
}

function removeFile(index: number) {
  fileList.value = fileList.value.filter((_, i) => i !== index)
  void rebuildPreviews()
}

function selectPreview(key: string) {
  activePreviewKey.value = key
}

// 弹窗关闭时释放 object URL
function releaseAll() {
  revokeUrls(previews.value)
  previews.value = []
  activePreviewKey.value = ''
}

onUnmounted(releaseAll)

/** 打开弹窗时刷新状态并重置表单 */
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) {
      releaseAll()
      return
    }
    deviceId.value = resolveDeviceId()
    studentName.value = localStorage.getItem(NAME_KEY) ?? ''
    studentNo.value = localStorage.getItem(NO_KEY) ?? ''
    note.value = ''
    fileList.value = []
    progress.value = 0
    resetSpeed()
    // 名单与提交状态并行加载：两者互不依赖，串行会多等一个往返
    await Promise.all([loadStatus(), loadRoster()])
  },
)

async function loadStatus() {
  if (props.lessonId === null) return
  statusLoading.value = true
  try {
    status.value = await api.lessonSubmissionStatus(props.lessonId, {
      classId: props.classId ?? null,
      deviceId: deviceId.value,
    })
  } catch {
    // 状态查询失败不阻断提交，重复检测仍在服务端执行
    status.value = null
  } finally {
    statusLoading.value = false
  }
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
  resetSpeed()
  try {
    const result = await api.submitHomework(
      {
        studentName: name,
        studentNo: studentNo.value.trim() || undefined,
        lessonId: props.lessonId,
        classId: props.classId ?? null,
        note: note.value.trim(),
        deviceId: deviceId.value,
        files: selectedFiles.value,
      },
      (progressInfo) => {
        progress.value = progressInfo.percent
        updateSpeed(progressInfo)
      },
    )

    localStorage.setItem(NAME_KEY, name)
    if (studentNo.value.trim()) localStorage.setItem(NO_KEY, studentNo.value.trim())

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

/** 预览类型的中文标签 */
const KIND_LABELS: Record<LocalPreivew['kind'], string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  pdf: 'PDF',
  text: '文本',
  other: '文件',
}

function kindLabel(kind: LocalPreivew['kind']): string {
  return KIND_LABELS[kind] ?? '文件'
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="提交作业"
    width="720px"
    top="6vh"
    :close-on-click-modal="false"
    :show-close="!uploading"
    @close="close"
  >
    <div class="submit-form">
      <!-- 当前设备已提交的提醒 -->
      <el-alert
        v-if="deviceHint"
        type="warning"
        :closable="false"
        show-icon
        class="submit-form__alert"
      >
        <template #title>当前设备已提交过本节课作业</template>
        {{ deviceHint }}如需修改请直接再次提交，教师可在后台核对每次记录。
      </el-alert>

      <p class="submit-form__lesson">
        课时：<strong>{{ lessonTitle || '未选择' }}</strong>
        <span v-if="classHint" class="submit-form__class-hint">{{ classHint }}</span>
      </p>

      <el-form label-width="76px" label-position="left">
        <!--
          有班级名单时优先让学生从名单里选自己：
          手打姓名容易写错字或加空格，教师端就统计不出「谁没交」。
          名单加载失败或班级无名单时退化为手填，不阻断提交。
        -->
        <el-form-item v-if="hasRoster" label="选择姓名" required>
          <div class="roster-pick">
            <el-select
              :model-value="studentNo"
              filterable
              clearable
              placeholder="输入学号或姓名搜索"
              :disabled="uploading"
              :loading="rosterLoading"
              class="roster-pick__select"
              @update:model-value="onPickStudent"
            >
              <el-option
                v-for="item in roster"
                :key="item.student_no"
                :label="`${item.student_no} ${item.student_name}`"
                :value="item.student_no"
              />
            </el-select>
            <span v-if="studentNo" class="roster-pick__picked">
              已选：{{ studentNo }} {{ studentName }}
            </span>
            <span v-else class="roster-pick__hint">从班级名单中选择你自己</span>
          </div>
        </el-form-item>

        <el-form-item :label="hasRoster ? '姓名' : '姓名'" :required="!hasRoster">
          <el-input
            v-model="studentName"
            :placeholder="hasRoster ? '从名单选择后自动填入，也可直接修改' : '请输入你的姓名'"
            maxlength="40"
            show-word-limit
            :disabled="uploading"
          />
        </el-form-item>

        <el-form-item v-if="hasRoster" label="学号">
          <el-input
            v-model="studentNo"
            placeholder="从名单选择后自动填入"
            maxlength="32"
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

        <!-- 已选文件：列表 + 即时预览 -->
        <el-form-item v-if="previews.length > 0" label="预览">
          <div class="local-preview">
            <!-- 文件切换条 -->
            <div class="local-preview__tabs">
              <button
                v-for="item in previews"
                :key="item.key"
                type="button"
                class="local-preview__tab"
                :class="{ 'local-preview__tab--active': item.key === activePreview?.key }"
                :title="item.file.name"
                @click="selectPreview(item.key)"
              >
                <span class="local-preview__tab-kind">{{ kindLabel(item.kind) }}</span>
                <span class="local-preview__tab-name">{{ item.file.name }}</span>
                <span class="local-preview__tab-size">{{ formatBytes(item.file.size) }}</span>
              </button>
            </div>

            <!-- 预览主体 -->
            <div v-if="activePreview" class="local-preview__body">
              <img
                v-if="activePreview.kind === 'image'"
                :src="activePreview.url"
                :alt="activePreview.file.name"
                class="local-preview__image"
              />

              <video
                v-else-if="activePreview.kind === 'video'"
                :src="activePreview.url"
                controls
                preload="metadata"
                class="local-preview__video"
              />

              <audio
                v-else-if="activePreview.kind === 'audio'"
                :src="activePreview.url"
                controls
                class="local-preview__audio"
              />

              <iframe
                v-else-if="activePreview.kind === 'pdf'"
                :src="activePreview.url"
                class="local-preview__frame"
                title="PDF 预览"
              />

              <pre v-else-if="activePreview.kind === 'text'" class="local-preview__text">{{
                activePreview.failed ? '文本读取失败，提交后可在预览窗口查看。' : activePreview.text
              }}</pre>

              <div v-else class="local-preview__other">
                <div class="local-preview__other-icon">📄</div>
                <div class="local-preview__other-name">{{ activePreview.file.name }}</div>
                <div class="local-preview__other-meta">
                  {{ formatBytes(activePreview.file.size) }} ·
                  {{ activePreview.file.type || '未知类型' }}
                </div>
                <p class="local-preview__other-hint">
                  该类型无法在浏览器内预览，提交后可由教师下载查看。
                </p>
              </div>
            </div>

            <!-- 移除按钮 -->
            <div v-if="activePreview" class="local-preview__actions">
              <span class="local-preview__actions-info">
                共 {{ previews.length }} 个文件，合计 {{ formatBytes(totalBytes) }}
              </span>
              <el-button
                link
                type="danger"
                size="small"
                :disabled="uploading"
                @click="removeFile(previews.indexOf(activePreview))"
              >
                移除当前文件
              </el-button>
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

        <el-form-item v-if="uploading" label="上传">
          <div class="upload-progress">
            <el-progress :percentage="progress" :stroke-width="14" style="width: 100%" />
            <!-- 速度、剩余时间与已传/总量：大文件上传时学生需要知道还要等多久 -->
            <div class="upload-progress__stats">
              <span class="upload-progress__speed">{{ speedText }}</span>
              <span class="upload-progress__sep">·</span>
              <span class="upload-progress__remaining">预计还需 {{ remainingText }}</span>
              <span v-if="transferredText" class="upload-progress__bytes">
                {{ transferredText }}
              </span>
            </div>
          </div>
        </el-form-item>
      </el-form>

      <p class="submit-form__privacy">
        提交时系统会记录来源 IP、设备标识与提交时间，仅用于教师核对作业归属。
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

.submit-form__class-hint {
  margin-left: 10px;
  color: var(--text-sub);
}

/* 名单选择 */
.roster-pick {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.roster-pick__select {
  width: 100%;
}

.roster-pick__picked {
  font-size: 12px;
  color: var(--brand);
}

.roster-pick__hint {
  font-size: 12px;
  color: var(--text-sub);
}

.submit-form__tip {
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
  margin-top: 4px;
}

/* 本地预览 */
.local-preview {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.local-preview__tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.local-preview__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 5px 9px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-sub);
}

.local-preview__tab:hover {
  border-color: var(--brand);
  color: var(--brand);
}

.local-preview__tab--active {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 600;
}

.local-preview__tab-kind {
  flex: none;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.06);
}

.local-preview__tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.local-preview__tab-size {
  flex: none;
  opacity: 0.7;
}

.local-preview__body {
  min-height: 200px;
  max-height: 46vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f7f8fa;
  border-radius: 8px;
  overflow: auto;
  padding: 10px;
}

.local-preview__image {
  max-width: 100%;
  max-height: 44vh;
  border-radius: 6px;
  display: block;
}

.local-preview__video {
  width: 100%;
  max-height: 44vh;
  border-radius: 6px;
  background: #000;
  display: block;
}

.local-preview__audio {
  width: 100%;
}

.local-preview__frame {
  width: 100%;
  height: 44vh;
  border: none;
  border-radius: 6px;
  background: #fff;
}

.local-preview__text {
  width: 100%;
  margin: 0;
  padding: 12px;
  background: #fff;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 44vh;
  overflow: auto;
  text-align: left;
}

.local-preview__other {
  text-align: center;
  padding: 16px;
}

.local-preview__other-icon {
  font-size: 34px;
  margin-bottom: 8px;
}

.local-preview__other-name {
  font-weight: 600;
  margin-bottom: 4px;
  word-break: break-all;
}

.local-preview__other-meta {
  font-size: 12px;
  color: var(--text-sub);
  margin-bottom: 8px;
}

.local-preview__other-hint {
  font-size: 12px;
  color: var(--text-sub);
  margin: 0;
}

.local-preview__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--text-sub);
}

.local-preview__actions-info {
  flex: 1;
}

/* 上传进度：进度条 + 速度 / 剩余时间 / 已传字节 */
.upload-progress {
  width: 100%;
}

.upload-progress__stats {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.5;
  flex-wrap: wrap;
}

.upload-progress__speed {
  font-weight: 600;
  color: var(--brand);
  font-variant-numeric: tabular-nums;
}

.upload-progress__sep {
  color: var(--border-color);
}

.upload-progress__remaining {
  font-variant-numeric: tabular-nums;
}

.upload-progress__bytes {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.submit-form__privacy {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.6;
}
</style>
