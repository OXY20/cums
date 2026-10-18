<script setup lang="ts">
/**
 * 课程管理：列表、创建、封面图上传、复制、停用与删除。
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, fileUrl, isImageFile, type Course } from '@/api'
import { courseStatusText, formatTime } from '@/utils/format'

const router = useRouter()
const courses = ref<Course[]>([])
const loading = ref(true)

const dialogVisible = ref(false)
const form = ref({ title: '', description: '' })
const saving = ref(false)

/** 封面上传进度：-1 表示未在上传 */
const coverProgress = ref(-1)
const coverUploading = ref<number | null>(null)

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

/** 上传封面：只接受图片，选完立即上传 */
async function uploadCover(course: Course, options: { file: File }) {
  const file = options.file
  if (!isImageFile(file)) {
    ElMessage.warning('课程封面必须是图片（JPG / PNG / WebP 等）')
    return
  }

  coverUploading.value = course.id
  coverProgress.value = 0

  try {
    const updated = await api.uploadCourseCover(course.id, file, (percent) => {
      coverProgress.value = percent
    })
    // 直接更新列表中的该条记录，避免整表刷新导致滚动位置跳动
    const index = courses.value.findIndex((c) => c.id === course.id)
    if (index >= 0) courses.value[index] = updated
    ElMessage.success('封面已更新')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '封面上传失败')
  } finally {
    coverUploading.value = null
    coverProgress.value = -1
  }
}

/** el-upload 的 http-request 回调；单独声明以便在模板中绑定 */
type UploadRequest = { file: File }

/** 课程封面专用的 http-request 包装，返回一个与 course 绑定的回调 */
function coverRequest(course: Course) {
  return (options: UploadRequest) => uploadCover(course, options)
}

async function removeCover(course: Course) {
  try {
    const updated = await api.clearCourseCover(course.id)
    const index = courses.value.findIndex((c) => c.id === course.id)
    if (index >= 0) courses.value[index] = updated
    ElMessage.success('封面已移除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '操作失败')
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
        <p class="page-subtitle">
          课程是可复用的教学模板。点击封面区域即可上传图片，点击课程名进入课时编辑。
        </p>
      </div>
      <el-button type="primary" @click="dialogVisible = true">新建课程</el-button>
    </div>

    <div class="card">
      <el-table v-loading="loading" :data="courses" empty-text="暂无课程">
        <!-- 封面：点击即可上传 -->
        <el-table-column label="封面" width="130">
          <template #default="{ row }">
            <el-upload
              :show-file-list="false"
              :http-request="coverRequest(row)"
              :disabled="coverUploading === row.id"
              accept="image/*"
              class="cover-uploader"
            >
              <div class="cover-box">
                <img
                  v-if="row.cover_resource_id"
                  :src="fileUrl(row.cover_resource_id)"
                  :alt="`${row.title} 封面`"
                  class="cover-box__img"
                />
                <div v-else class="cover-box__placeholder">
                  <span>{{ row.title.slice(0, 2) }}</span>
                  <small>点击上传</small>
                </div>
                <div v-if="coverUploading === row.id" class="cover-box__mask">
                  {{ coverProgress }}%
                </div>
              </div>
            </el-upload>
            <el-button
              v-if="row.cover_resource_id"
              link
              size="small"
              style="margin-top: 4px"
              @click="removeCover(row)"
            >
              移除封面
            </el-button>
          </template>
        </el-table-column>

        <el-table-column label="课程名称" min-width="150">
          <template #default="{ row }">
            <el-button link type="primary" @click="router.push(`/admin/courses/${row.id}`)">
              {{ row.title }}
            </el-button>
          </template>
        </el-table-column>

        <el-table-column prop="description" label="简介" min-width="180" show-overflow-tooltip />
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

<style scoped>
.cover-uploader {
  cursor: pointer;
}

.cover-box {
  position: relative;
  width: 96px;
  height: 60px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  background: var(--brand-soft);
}

.cover-box__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-box__placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--brand);
  font-weight: 600;
  font-size: 14px;
}

.cover-box__placeholder small {
  font-weight: 400;
  font-size: 10px;
  color: var(--text-sub);
}

.cover-box__mask {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 45%);
  color: #fff;
  font-size: 12px;
}
</style>
