<script setup lang="ts">
/**
 * 课时编辑器：富媒体正文编辑 + 附件管理。
 *
 * 正文使用论坛式富文本编辑器（字号、颜色、对齐、列表、引用、链接、
 * 图片与视频内嵌），教师直接在正文中排版，无需分块添加。
 *
 * 图片/视频上传后插入正文，服务端会按白名单清洗 HTML 并同步资源关联；
 * 附件上传后以列表形式展示，也可插入正文作为下载链接。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, fileUrl, type Course, type Lesson, type LessonResource } from '@/api'
import { formatBytes } from '@/utils/format'
import RichTextEditor from '@/components/RichTextEditor.vue'
import CourseHomeworkPanel from '@/components/CourseHomeworkPanel.vue'

const props = defineProps<{ courseId: string }>()
const router = useRouter()

const course = ref<Course | null>(null)
const lessons = ref<Lesson[]>([])
const active = ref<Lesson | null>(null)
const resources = ref<LessonResource[]>([])
const loading = ref(true)
const saving = ref(false)

/** 当前标签页：编辑内容 / 查看作业统计 */
const activeTab = ref<'content' | 'homework'>('content')

/** 正文 HTML，双向绑定到编辑器 */
const contentHtml = ref('')

/** 上传进度：-1 表示未在上传 */
const uploadProgress = ref(-1)
const uploading = computed(() => uploadProgress.value >= 0)

const editorRef = ref<InstanceType<typeof RichTextEditor> | null>(null)

const courseId = computed(() => Number(props.courseId))

/** 附件（非正文内嵌的资源） */
const attachments = computed(() => resources.value.filter((r) => r.purpose === 'attachment'))

/** 正文是否有未保存的修改 */
const dirty = ref(false)

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

/** 选中课时：加载正文与资源 */
async function select(lesson: Lesson) {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('当前课时有未保存的修改，切换后将丢失。是否继续？', '提示', {
        confirmButtonText: '继续切换',
        cancelButtonText: '留在本页',
        type: 'warning',
      })
    } catch {
      return
    }
  }

  active.value = lesson
  try {
    const detail = await api.lesson(lesson.id)
    // 新课时用富文本；旧数据若只有块结构，给出提示
    contentHtml.value = detail.content_html || ''
    resources.value = detail.resources
    dirty.value = false

    if (!detail.content_html && (detail.blocks?.length ?? 0) > 0) {
      ElMessage.info('该课时仍为旧版块内容，保存后将切换为富文本格式')
    }
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
    contentHtml.value = ''
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
// 保存
// ---------------------------------------------------------------------------

async function save() {
  if (!active.value) return
  saving.value = true
  try {
    const updated = await api.updateLesson(active.value.id, {
      content_html: contentHtml.value,
    })
    active.value = updated
    await refreshLessons()

    // 正文引用的资源会在保存时同步为关联记录，刷新一次拿到最新列表
    const detail = await api.lesson(active.value.id)
    resources.value = detail.resources
    dirty.value = false

    ElMessage.success('课时内容已保存')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    saving.value = false
  }
}

/** 编辑器内容变化 */
function onContentChange(value: string) {
  contentHtml.value = value
  dirty.value = true
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

/** 编辑器内上传图片/视频：上传后返回站内 URL 供插入 */
async function uploadForEditor(file: File): Promise<string> {
  if (!active.value) throw new Error('请先选择一个课时')

  uploadProgress.value = 0
  try {
    const resource = await api.uploadLessonResource(active.value.id, file, (info) => {
      uploadProgress.value = info.percent
    })
    resources.value.push(resource)
    dirty.value = true
    return fileUrl(resource.id)
  } finally {
    uploadProgress.value = -1
  }
}

/** 上传附件：插入正文链接并加入附件列表 */
async function uploadAttachmentFile(file: File): Promise<string> {
  return uploadForEditor(file)
}

/** 单独上传附件（不进正文） */
function pickAttachment() {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.onchange = async () => {
    const files = Array.from(input.files ?? [])
    if (files.length === 0) return

    for (const file of files) {
      if (!active.value) return
      uploadProgress.value = 0
      try {
        const resource = await api.uploadLessonResource(active.value.id, file, (info) => {
          uploadProgress.value = info.percent
        })
        resources.value.push(resource)
        ElMessage.success(`${file.name} 已上传为附件`)
      } catch (err) {
        ElMessage.error(`${file.name} 上传失败：${err instanceof Error ? err.message : '未知错误'}`)
      } finally {
        uploadProgress.value = -1
      }
    }
  }
  input.click()
}

/** 把附件插入正文作为下载链接 */
function insertAttachmentLink(resource: LessonResource) {
  editorRef.value?.insertAttachment(resource.name, fileUrl(resource.id))
  dirty.value = true
}

async function detachAttachment(resource: LessonResource) {
  if (!active.value) return
  try {
    await api.detachResource(active.value.id, resource.id)
    resources.value = resources.value.filter((r) => r.id !== resource.id)
    ElMessage.success('已从课时移除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  }
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
    <!-- 标题体现「课程 · 课时」层级，与学生端保持一致 -->
    <h1 class="page-title">
      {{ course?.title || '课程' }}
      <template v-if="active">
        <span class="title-sep">·</span>
        <span class="title-lesson">{{ active.title }}</span>
      </template>
    </h1>
    <p class="page-subtitle">
      <template v-if="active">
        第 {{ active.sort_order }} 课时
        <span class="subtitle-sep">｜</span>
      </template>
      {{ course?.description || '暂无课程简介' }}
    </p>

    <div v-if="loading" class="card empty-state">正在加载…</div>

    <!--
      两个视角：编辑课时内容 / 查看作业提交情况。
      课程详情是教师进入某门课的入口，既可能来改内容，也可能来查作业收齐没，
      因此用标签页分开，避免作业统计挤占编辑区。
    -->
    <el-tabs v-if="!loading" v-model="activeTab" class="course-tabs">
      <el-tab-pane label="课时内容" name="content">
        <div class="editor-layout">
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
          <!-- 课时名已提升到页面顶部，这里只保留序号与保存操作 -->
          <div class="editor-head">
            <span class="editor-head__label">第 {{ active.sort_order }} 课时</span>
            <div>
              <el-tag v-if="dirty" size="small" type="warning" style="margin-right: 8px">
                未保存
              </el-tag>
              <el-button size="small" type="primary" :loading="saving" @click="save">
                保存正文
              </el-button>
            </div>
          </div>

          <el-progress
            v-if="uploading"
            :percentage="uploadProgress"
            :stroke-width="10"
            style="margin-bottom: 10px"
          />

          <!-- 富媒体正文编辑器 -->
          <RichTextEditor
            ref="editorRef"
            :model-value="contentHtml"
            :on-upload="uploadForEditor"
            :on-upload-attachment="uploadAttachmentFile"
            :min-height="380"
            placeholder="在此输入教学内容：可设置字号与颜色、插入链接、图片和视频…"
            @update:model-value="onContentChange"
          />

          <p class="editor-hint">
            提示：工具栏可设置字号、颜色、对齐与列表；点击图片/视频按钮可直接上传插入；
            链接按钮支持站内与站外地址。
          </p>

          <!-- 附件 -->
          <div class="attachment-head">
            <h3 class="section-title" style="margin: 0">
              课时附件
              <span class="hint">（文档、压缩包等，学生可直接下载）</span>
            </h3>
            <el-button size="small" @click="pickAttachment">上传附件</el-button>
          </div>

          <div v-if="attachments.length === 0" class="empty-state" style="padding: 18px">
            暂无附件。上传的文档、压缩包等会出现在这里。
          </div>

          <div v-for="item in attachments" :key="item.id" class="resource-item">
            <span class="resource-item__name">{{ item.name }}</span>
            <span class="resource-item__size">{{ formatBytes(item.size_bytes) }}</span>
            <el-button size="small" @click="insertAttachmentLink(item)">插入正文</el-button>
            <el-button size="small" @click="openFile(item.id)">下载</el-button>
            <el-button size="small" type="danger" plain @click="detachAttachment(item)">
              移除
            </el-button>
          </div>
        </template>

        <div v-else class="empty-state">请从左侧选择一个课时，或先新增课时。</div>
      </section>
        </div>
      </el-tab-pane>

      <el-tab-pane label="作业统计" name="homework">
        <div class="card">
          <CourseHomeworkPanel v-if="courseId" :course-id="courseId" />
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.course-tabs {
  margin-top: 8px;
}

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

.editor-head__label {
  font-size: 12px;
  color: var(--brand);
  background: var(--brand-soft);
  border-radius: 4px;
  padding: 2px 8px;
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

.editor-hint {
  margin: 8px 0 18px;
  font-size: 12px;
  color: var(--text-sub);
}

.attachment-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
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
