<script setup lang="ts">
/**
 * 课时编辑器：课时排序、结构化内容编辑与资源关联。
 * 对应建设方案 5.2「课时编辑器」。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, type Course, type Lesson, type Resource } from '@/api'
import { formatBytes } from '@/utils/format'

const props = defineProps<{ courseId: string }>()
const router = useRouter()

const course = ref<Course | null>(null)
const lessons = ref<Lesson[]>([])
const active = ref<Lesson | null>(null)
const resources = ref<Resource[]>([])
const allResources = ref<Resource[]>([])
const loading = ref(true)
const saving = ref(false)

/** 结构化内容字段，与建设方案 4.2 的课时组成对应 */
const fields = [
  { key: 'goal', label: '学习目标' },
  { key: 'intro', label: '教学说明' },
  { key: 'steps', label: '操作步骤' },
  { key: 'notes', label: '注意事项' },
  { key: 'task', label: '练习任务' },
  { key: 'criteria', label: '完成标准' },
]

const content = ref<Record<string, string>>({})

const courseId = computed(() => Number(props.courseId))

onMounted(async () => {
  try {
    course.value = await api.course(courseId.value)
    lessons.value = (await api.lessons(courseId.value)).items
    allResources.value = (await api.resources()).items
    if (lessons.value.length > 0) await select(lessons.value[0])
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '加载失败')
  } finally {
    loading.value = false
  }
})

async function select(lesson: Lesson) {
  active.value = lesson
  resources.value = (await api.lessonResources(lesson.id)).items
  try {
    const parsed = JSON.parse(lesson.content_json) as Record<string, string>
    content.value = Object.fromEntries(fields.map((f) => [f.key, parsed[f.key] ?? '']))
  } catch {
    content.value = Object.fromEntries(fields.map((f) => [f.key, '']))
  }
}

async function addLesson() {
  try {
    const { value } = await ElMessageBox.prompt('请输入课时标题', '新建课时', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
    })
    if (!value?.trim()) return
    await api.createLesson(courseId.value, { title: value.trim() })
    lessons.value = (await api.lessons(courseId.value)).items
    ElMessage.success('课时已创建')
  } catch (err) {
    if (err instanceof Error) ElMessage.error(err.message)
  }
}

async function save() {
  if (!active.value) return
  saving.value = true
  try {
    const payload = Object.fromEntries(
      Object.entries(content.value).filter(([, value]) => value.trim() !== ''),
    )
    const updated = await api.updateLesson(active.value.id, {
      content_json: JSON.stringify(payload),
    })
    active.value = updated
    lessons.value = (await api.lessons(courseId.value)).items
    ElMessage.success('课时内容已保存')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function removeLesson(lesson: Lesson) {
  try {
    await ElMessageBox.confirm(`确认删除课时「${lesson.title}」？`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }

  try {
    await api.deleteLesson(lesson.id)
    lessons.value = (await api.lessons(courseId.value)).items
    active.value = null
    ElMessage.success('课时已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

/** 调整课时顺序 */
async function move(lesson: Lesson, direction: -1 | 1) {
  const index = lessons.value.findIndex((l) => l.id === lesson.id)
  const target = lessons.value[index + direction]
  if (!target) return

  try {
    await api.updateLesson(lesson.id, { sort_order: target.sort_order })
    await api.updateLesson(target.id, { sort_order: lesson.sort_order })
    lessons.value = (await api.lessons(courseId.value)).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '排序失败')
  }
}

async function attach(resourceId: number) {
  if (!active.value) return
  try {
    await api.attachResource(active.value.id, resourceId)
    resources.value = (await api.lessonResources(active.value.id)).items
    ElMessage.success('已关联资源')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '关联失败')
  }
}

async function detach(resourceId: number) {
  if (!active.value) return
  try {
    await api.detachResource(active.value.id, resourceId)
    resources.value = (await api.lessonResources(active.value.id)).items
    ElMessage.success('已解除关联')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
  }
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
          暂无课时
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
            <el-button link size="small" @click="move(lesson, -1)">↑</el-button>
            <el-button link size="small" @click="move(lesson, 1)">↓</el-button>
            <el-button link size="small" type="danger" @click="removeLesson(lesson)">删</el-button>
          </span>
        </div>
      </aside>

      <!-- 课时内容 -->
      <section class="card">
        <template v-if="active">
          <el-form label-position="top">
            <el-form-item v-for="field in fields" :key="field.key" :label="field.label">
              <el-input
                v-model="content[field.key]"
                type="textarea"
                :rows="field.key === 'steps' ? 5 : 3"
                :placeholder="`请输入${field.label}（选填）`"
              />
            </el-form-item>
          </el-form>

          <el-button type="primary" :loading="saving" @click="save">保存课时内容</el-button>

          <h3 class="section-title">关联资源</h3>
          <div v-if="resources.length === 0" class="empty-state">尚未关联资源。</div>
          <div v-for="resource in resources" :key="resource.id" class="resource-item">
            <span class="resource-item__name">{{ resource.name }}</span>
            <span class="resource-item__size">{{ formatBytes(resource.size_bytes) }}</span>
            <el-button size="small" type="danger" plain @click="detach(resource.id)">
              解除关联
            </el-button>
          </div>

          <el-select
            placeholder="从资源库选择并关联"
            style="width: 100%; margin-top: 12px"
            :model-value="null"
            @change="attach"
          >
            <el-option
              v-for="resource in allResources.filter(
                (r) => !resources.some((x) => x.id === r.id),
              )"
              :key="resource.id"
              :label="`${resource.name}（${formatBytes(resource.size_bytes)}）`"
              :value="resource.id"
            />
          </el-select>
        </template>

        <div v-else class="empty-state">请从左侧选择一个课时，或先新增课时。</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.editor-layout {
  display: grid;
  grid-template-columns: 300px 1fr;
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

@media (max-width: 900px) {
  .editor-layout {
    grid-template-columns: 1fr;
  }
}
</style>
