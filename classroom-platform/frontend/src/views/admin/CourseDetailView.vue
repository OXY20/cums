<script setup lang="ts">
/**
 * 课时编辑器：正文块编辑 + 课时内直接上传。
 *
 * 设计要点（对应反馈「应该能直接编辑上传图片、视频、附件，而不是分开添加」）：
 * - 上传入口就在课时正文里，选完文件即上传并插入，无需先去资源库再回来关联；
 * - 图片与视频上传后直接内嵌预览，附件以列表形式提供下载；
 * - 正文块支持文字、图片、视频混排，并可上下调整顺序。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  api,
  fileUrl,
  isImageFile,
  isVideoFile,
  type Course,
  type Lesson,
  type LessonBlock,
  type LessonResource,
} from '@/api'
import { formatBytes } from '@/utils/format'

const props = defineProps<{ courseId: string }>()
const router = useRouter()

const course = ref<Course | null>(null)
const lessons = ref<Lesson[]>([])
const active = ref<Lesson | null>(null)
const blocks = ref<LessonBlock[]>([])
const resources = ref<LessonResource[]>([])
const loading = ref(true)
const saving = ref(false)

/** 上传进度：0-100，-1 表示未在上传 */
const uploadProgress = ref(-1)
const uploading = computed(() => uploadProgress.value >= 0)

const courseId = computed(() => Number(props.courseId))

/** 附件（非图片非视频的资源） */
const attachments = computed(() => resources.value.filter((r) => r.purpose === 'attachment'))

/** 尚未插入正文的媒体资源，供「插入到正文」下拉使用 */
const insertableMedia = computed(() =>
  resources.value.filter(
    (r) =>
      (r.purpose === 'image' || r.purpose === 'video') &&
      !blocks.value.some((b) => b.resource_id === r.id),
  ),
)

onMounted(async () => {
  try {
    course.value = await api.course(courseId.value)
    lessons.value = (await api.lessons(courseId.value)).items
    if (lessons.value.length > 0) await select(lessons.value[0])
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '加载失败')
  } finally {
    loading.value = false
  }
})

/** 选中课时：一次加载正文块与资源 */
async function select(lesson: Lesson) {
  active.value = lesson
  try {
    const detail = await api.lesson(lesson.id)
    blocks.value = detail.blocks
    resources.value = detail.resources
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '课时内容加载失败')
  }
}

async function refreshLessons() {
  lessons.value = (await api.lessons(courseId.value)).items
  if (active.value) {
    const found = lessons.value.find((l) => l.id === active.value?.id)
    if (found) active.value = found
  }
}

async function addLesson() {
  try {
    const { value } = await ElMessageBox.prompt('请输入课时标题', '新建课时', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    })
    if (!value?.trim()) return
    const created = await api.createLesson(courseId.value, { title: value.trim() })
    await refreshLessons()
    const found = lessons.value.find((l) => l.id === created.id)
    if (found) await select(found)
    ElMessage.success('课时已创建')
  } catch (err) {
    if (err instanceof Error) ElMessage.error(err.message)
  }
}

async function removeLesson(lesson: Lesson) {
  try {
    await ElMessageBox.confirm(`确认删除课时「${lesson.title}」？其正文内容会一并删除。`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }

  try {
    await api.deleteLesson(lesson.id)
    await refreshLessons()
    active.value = null
    blocks.value = []
    resources.value = []
    ElMessage.success('课时已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

/** 调整课时顺序 */
async function moveLesson(lesson: Lesson, direction: -1 | 1) {
  const index = lessons.value.findIndex((l) => l.id === lesson.id)
  const target = lessons.value[index + direction]
  if (!target) return

  try {
    await api.updateLesson(lesson.id, { sort_order: target.sort_order })
    await api.updateLesson(target.id, { sort_order: lesson.sort_order })
    await refreshLessons()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '排序失败')
  }
}

/** 重命名课时 */
async function renameLesson(lesson: Lesson) {
  try {
    const { value } = await ElMessageBox.prompt('课时标题', '重命名', {
      inputValue: lesson.title,
      confirmButtonText: '保存',
      cancelButtonText: '取消',
    })
    if (!value?.trim()) return
    await api.updateLesson(lesson.id, { title: value.trim() })
    await refreshLessons()
    ElMessage.success('已重命名')
  } catch (err) {
    if (err instanceof Error) ElMessage.error(err.message)
  }
}

// ---------------------------------------------------------------------------
// 正文块编辑
// ---------------------------------------------------------------------------

async function addTextBlock() {
  if (!active.value) return
  try {
    const block = await api.createBlock(active.value.id, {
      block_type: 'text',
      text_content: '在此输入教学内容…',
    })
    blocks.value.push(block)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '添加段落失败')
  }
}

async function saveBlock(block: LessonBlock) {
  try {
    const updated = await api.updateBlock(block.id, {
      text_content: block.text_content,
      title: block.title,
    })
    Object.assign(block, updated)
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  }
}

async function removeBlock(block: LessonBlock) {
  try {
    await api.deleteBlock(block.id)
    blocks.value = blocks.value.filter((b) => b.id !== block.id)
    ElMessage.success('已删除该块')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

/** 上下移动正文块 */
async function moveBlock(index: number, direction: -1 | 1) {
  if (!active.value) return
  const target = index + direction
  if (target < 0 || target >= blocks.value.length) return

  const ids = blocks.value.map((b) => b.id)
  ;[ids[index], ids[target]] = [ids[target], ids[index]]

  try {
    const result = await api.reorderBlocks(active.value.id, ids)
    blocks.value = result.items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '排序失败')
  }
}

/** 把已有媒体资源插入正文 */
async function insertMedia(resource: LessonResource) {
  if (!active.value) return
  try {
    const block = await api.createBlock(active.value.id, {
      block_type: resource.purpose === 'video' ? 'video' : 'image',
      title: resource.name,
      resource_id: resource.id,
    })
    blocks.value.push(block)
    ElMessage.success('已插入正文')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '插入失败')
  }
}

// ---------------------------------------------------------------------------
// 直接上传
// ---------------------------------------------------------------------------

/** 上传后按用途处理：图片/视频插入正文，其余作为附件 */
async function handleFiles(files: FileList | File[]) {
  if (!active.value) {
    ElMessage.warning('请先选择一个课时')
    return
  }

  const list = Array.from(files)
  if (list.length === 0) return

  for (const file of list) {
    uploadProgress.value = 0
    try {
      const resource = await api.uploadLessonResource(active.value.id, file, (percent) => {
        uploadProgress.value = percent
      })

      resources.value.push(resource)

      // 图片与视频自动插入正文，教师无需再手动操作一次。
      if (resource.purpose === 'image' || resource.purpose === 'video') {
        const block = await api.createBlock(active.value.id, {
          block_type: resource.purpose === 'video' ? 'video' : 'image',
          title: resource.name,
          resource_id: resource.id,
        })
        blocks.value.push(block)
        ElMessage.success(`${file.name} 已上传并插入正文`)
      } else {
        ElMessage.success(`${file.name} 已上传为附件`)
      }
    } catch (err) {
      ElMessage.error(
        `${file.name} 上传失败：${err instanceof Error ? err.message : '未知错误'}`,
      )
    } finally {
      uploadProgress.value = -1
    }
  }
}

/** el-upload 自定义上传 */
function customUpload(options: { file: File }) {
  handleFiles([options.file])
}

/** 从正文移除媒体块（资源仍保留在课时资源中） */
async function detachAttachment(resource: LessonResource) {
  if (!active.value) return
  try {
    await api.detachResource(active.value.id, resource.id)
    resources.value = resources.value.filter((r) => r.id !== resource.id)
    blocks.value = blocks.value.filter((b) => b.resource_id !== resource.id)
    ElMessage.success('已从课时移除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  }
}

/** 从正文块定位对应资源，用于展示文件大小 */
function resourceOf(block: LessonBlock): LessonResource | undefined {
  return resources.value.find((r) => r.id === block.resource_id)
}

/** 判断拖入的文件类型，用于提示文案 */
function dropHint(files: FileList): string {
  const first = files[0]
  if (!first) return ''
  if (isImageFile(first)) return '松开以插入图片'
  if (isVideoFile(first)) return '松开以插入视频'
  return '松开以上传附件'
}

/** 模板中不能直接访问全局 window，因此包一层 */
function openFile(resourceId: number | null) {
  if (resourceId === null) return
  window.open(fileUrl(resourceId), '_blank')
}
</script>

<template>
  <div>
    <el-button link @click="router.push('/admin/courses')">← 返回课程列表</el-button>
    <h1 class="page-title">{{ course?.title || '课程' }}</h1>
    <p class="page-subtitle">{{ course?.description || '暂无课程简介' }}</p>

    <div v-if="loading" class="card empty-state">正在加载…</div>

    <div v-else class="editor-layout">
      <!-- 课时列表 -->
      <aside class="card">
        <div style="display: flex; align-items: center; justify-content: space-between">
          <strong>课时列表</strong>
          <el-button size="small" type="primary" @click="addLesson">新增</el-button>
        </div>

        <div v-if="lessons.length === 0" class="empty-state" style="padding: 18px">
          暂无课时，点击「新增」开始。
        </div>

        <div
          v-for="lesson in lessons"
          :key="lesson.id"
          class="lesson-row"
          :class="{ 'lesson-row--active': active?.id === lesson.id }"
          @click="select(lesson)"
        >
          <span class="lesson-row__title">第 {{ lesson.sort_order }} 课时 · {{ lesson.title }}</span>
          <span class="lesson-row__actions" @click.stop>
            <el-button link size="small" title="上移" @click="moveLesson(lesson, -1)">↑</el-button>
            <el-button link size="small" title="下移" @click="moveLesson(lesson, 1)">↓</el-button>
            <el-button link size="small" title="重命名" @click="renameLesson(lesson)">改</el-button>
            <el-button link size="small" type="danger" title="删除" @click="removeLesson(lesson)">
              删
            </el-button>
          </span>
        </div>
      </aside>

      <!-- 课时内容 -->
      <section class="card">
        <template v-if="active">
          <div class="editor-head">
            <h2 style="margin: 0; font-size: 17px">{{ active.title }}</h2>
            <el-button size="small" @click="addTextBlock">+ 添加文字段落</el-button>
          </div>

          <!-- 直接上传区：拖拽或点击，上传后自动插入正文 -->
          <el-upload
            drag
            multiple
            :show-file-list="false"
            :http-request="customUpload"
            :disabled="uploading"
            class="inline-upload"
          >
            <div class="inline-upload__inner">
              <p class="inline-upload__title">拖入或点击上传图片、视频、附件</p>
              <p class="inline-upload__hint">
                图片与视频会自动插入下方正文并直接预览，其他文件作为附件列出。
              </p>
            </div>
          </el-upload>

          <el-progress
            v-if="uploading"
            :percentage="uploadProgress"
            :stroke-width="10"
            style="margin-bottom: 14px"
          />

          <!-- 正文块 -->
          <div v-if="blocks.length === 0" class="empty-state" style="padding: 24px">
            正文还是空的。可以「添加文字段落」，或直接上传图片/视频。
          </div>

          <div v-for="(block, index) in blocks" :key="block.id" class="block">
            <div class="block__bar">
              <span class="block__type">
                {{ block.block_type === 'text' ? '文字' : block.block_type === 'image' ? '图片' : block.block_type === 'video' ? '视频' : '文件' }}
              </span>
              <span class="block__actions">
                <el-button link size="small" :disabled="index === 0" @click="moveBlock(index, -1)">
                  ↑
                </el-button>
                <el-button
                  link
                  size="small"
                  :disabled="index === blocks.length - 1"
                  @click="moveBlock(index, 1)"
                >
                  ↓
                </el-button>
                <el-button link size="small" type="danger" @click="removeBlock(block)">删除</el-button>
              </span>
            </div>

            <!-- 文字块 -->
            <template v-if="block.block_type === 'text'">
              <el-input v-model="block.title" placeholder="小标题（选填）" size="small" style="margin-bottom: 6px" />
              <el-input
                v-model="block.text_content"
                type="textarea"
                :rows="4"
                placeholder="输入教学内容"
              />
              <el-button size="small" style="margin-top: 6px" @click="saveBlock(block)">保存</el-button>
            </template>

            <!-- 图片块：直接预览 -->
            <template v-else-if="block.block_type === 'image'">
              <div class="media">
                <img
                  v-if="block.resource_id"
                  :src="fileUrl(block.resource_id)"
                  :alt="block.title || '课时图片'"
                  class="media__image"
                />
                <div class="media__meta">
                  <span>{{ block.resource_name }}</span>
                  <span v-if="resourceOf(block)" class="media__size">
                    {{ formatBytes(resourceOf(block)!.size_bytes) }}
                  </span>
                  <el-button
                    v-if="block.resource_id"
                    link
                    size="small"
                    @click="openFile(block.resource_id)"
                  >
                    查看原图
                  </el-button>
                </div>
              </div>
            </template>

            <!-- 视频块：内嵌播放器 -->
            <template v-else-if="block.block_type === 'video'">
              <div class="media">
                <video
                  v-if="block.resource_id"
                  :src="fileUrl(block.resource_id)"
                  controls
                  preload="metadata"
                  class="media__video"
                />
                <div class="media__meta">
                  <span>{{ block.resource_name }}</span>
                  <span v-if="resourceOf(block)" class="media__size">
                    {{ formatBytes(resourceOf(block)!.size_bytes) }}
                  </span>
                </div>
              </div>
            </template>

            <!-- 其他文件块 -->
            <template v-else>
              <div class="media__meta">
                <span>{{ block.resource_name }}</span>
                <el-button
                  v-if="block.resource_id"
                  link
                  size="small"
                  @click="openFile(block.resource_id)"
                >
                  下载
                </el-button>
              </div>
            </template>
          </div>

          <!-- 附件列表 -->
          <h3 class="section-title">
            课时附件
            <span class="hint">（非图片、非视频的资源，学生可直接下载）</span>
          </h3>
          <div v-if="attachments.length === 0" class="empty-state" style="padding: 18px">
            暂无附件。上传的文档、压缩包等会出现在这里。
          </div>
          <div v-for="item in attachments" :key="item.id" class="resource-item">
            <span class="resource-item__name">{{ item.name }}</span>
            <span class="resource-item__size">{{ formatBytes(item.size_bytes) }}</span>
            <el-button size="small" @click="openFile(item.id)">下载</el-button>
            <el-button size="small" type="danger" plain @click="detachAttachment(item)">
              移除
            </el-button>
          </div>

          <!-- 已上传但未插入正文的媒体 -->
          <template v-if="insertableMedia.length > 0">
            <h3 class="section-title">未插入正文的媒体</h3>
            <div v-for="item in insertableMedia" :key="item.id" class="resource-item">
              <span class="resource-item__name">{{ item.name }}</span>
              <span class="resource-item__size">{{ formatBytes(item.size_bytes) }}</span>
              <el-button size="small" type="primary" plain @click="insertMedia(item)">
                插入正文
              </el-button>
              <el-button size="small" type="danger" plain @click="detachAttachment(item)">
                移除
              </el-button>
            </div>
          </template>
        </template>

        <div v-else class="empty-state">请从左侧选择一个课时，或先新增课时。</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.editor-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 16px;
  align-items: start;
}

.lesson-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  margin-top: 4px;
}

.lesson-row:hover {
  background: var(--brand-soft);
}

.lesson-row--active {
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 600;
}

.lesson-row__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lesson-row__actions {
  flex: none;
  display: inline-flex;
  gap: 2px;
}

.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

/* 直接上传区 */
.inline-upload {
  display: block;
  margin-bottom: 14px;
}

.inline-upload :deep(.el-upload-dragger) {
  padding: 14px;
  background: var(--brand-soft);
  border: 1px dashed var(--brand);
  border-radius: 8px;
}

.inline-upload__inner {
  text-align: center;
}

.inline-upload__title {
  margin: 0 0 4px;
  font-size: 14px;
  color: var(--brand);
  font-weight: 600;
}

.inline-upload__hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-sub);
}

/* 正文块 */
.block {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}

.block__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.block__type {
  font-size: 12px;
  color: var(--text-sub);
  background: var(--page-bg);
  border-radius: 4px;
  padding: 1px 8px;
}

.block__actions {
  display: inline-flex;
  gap: 2px;
}

.media__image {
  max-width: 100%;
  max-height: 320px;
  border-radius: 6px;
  display: block;
}

.media__video {
  width: 100%;
  max-height: 360px;
  border-radius: 6px;
  background: #000;
  display: block;
}

.media__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-sub);
}

.media__size {
  font-variant-numeric: tabular-nums;
}

.hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-sub);
}

@media (max-width: 900px) {
  .editor-layout {
    grid-template-columns: 1fr;
  }
}
</style>
