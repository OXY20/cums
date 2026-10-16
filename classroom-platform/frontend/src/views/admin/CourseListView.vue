<script setup lang="ts">
/**
 * 课程管理：列表、创建、复制、停用与删除。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, type Course } from '@/api'
import { courseStatusText, formatTime } from '@/utils/format'

const router = useRouter()
const courses = ref<Course[]>([])
const loading = ref(true)

const dialogVisible = ref(false)
const form = ref({ title: '', description: '' })
const saving = ref(false)

onMounted(load)

async function load() {
  loading.value = true
  try {
    courses.value = (await api.courses()).items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '课程加载失败')
  } finally {
    loading.value = false
  }
}

async function create() {
  if (!form.value.title.trim()) {
    ElMessage.warning('请输入课程名称')
    return
  }

  saving.value = true
  try {
    await api.createCourse({ title: form.value.title.trim(), description: form.value.description })
    ElMessage.success('课程已创建')
    dialogVisible.value = false
    form.value = { title: '', description: '' }
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '创建失败')
  } finally {
    saving.value = false
  }
}

async function copy(course: Course) {
  try {
    await api.copyCourse(course.id)
    ElMessage.success('已复制课程模板')
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '复制失败')
  }
}

async function toggleStatus(course: Course) {
  const next = course.status === 'published' ? 'archived' : 'published'
  const label = next === 'published' ? '发布' : '停用'
  try {
    await api.updateCourse(course.id, { status: next })
    ElMessage.success(`已${label}课程`)
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : `${label}失败`)
  }
}

async function remove(course: Course) {
  try {
    await ElMessageBox.confirm(
      `确认删除课程「${course.title}」？该操作会同时删除其课时。`,
      '确认删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  try {
    await api.deleteCourse(course.id)
    ElMessage.success('课程已删除')
    await load()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}
</script>

<template>
  <div>
    <div style="display: flex; align-items: center; justify-content: space-between">
      <div>
        <h1 class="page-title">课程管理</h1>
        <p class="page-subtitle">课程是可复用的教学模板，修改不会影响已结束的历史课堂。</p>
      </div>
      <el-button type="primary" @click="dialogVisible = true">新建课程</el-button>
    </div>

    <div class="card">
      <el-table v-loading="loading" :data="courses" empty-text="暂无课程">
        <el-table-column prop="title" label="课程名称" min-width="160" />
        <el-table-column prop="description" label="简介" min-width="200" show-overflow-tooltip />
        <el-table-column prop="lesson_count" label="课时数" width="90" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.status === 'published' ? 'success' : row.status === 'draft' ? 'info' : 'warning'"
            >
              {{ courseStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">{{ formatTime(row.updated_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="290" fixed="right">
          <template #default="{ row }">
            <el-button size="small" @click="router.push(`/admin/courses/${row.id}`)">编辑</el-button>
            <el-button size="small" @click="copy(row)">复制</el-button>
            <el-button size="small" @click="toggleStatus(row)">
              {{ row.status === 'published' ? '停用' : '发布' }}
            </el-button>
            <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog v-model="dialogVisible" title="新建课程" width="480px">
      <el-form label-width="80px">
        <el-form-item label="课程名称">
          <el-input v-model="form.title" placeholder="例如：文字处理" />
        </el-form-item>
        <el-form-item label="课程简介">
          <el-input v-model="form.description" type="textarea" :rows="3" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="create">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>
