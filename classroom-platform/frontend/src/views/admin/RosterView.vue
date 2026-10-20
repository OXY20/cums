<script setup lang="ts">
/**
 * 班级学生名单管理。
 *
 * 名单是「谁没交作业」的前提：没有名单就无从判断应缴人数。
 * 教师实际使用场景是从教务系统或 Excel 复制两列粘贴进来，
 * 因此这里以「粘贴导入」为主入口，而不是逐条手工添加。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, type ClassInfo, type ClassStudent, type ImportStudentsResult } from '@/api'
import { formatTime } from '@/utils/format'

const classes = ref<ClassInfo[]>([])
const selectedClassId = ref<number | null>(null)
const students = ref<ClassStudent[]>([])
const loading = ref(false)

/** 导入对话框 */
const importVisible = ref(false)
const importText = ref('')
const importReplace = ref(false)
const importing = ref(false)
/** 上次导入结果，用于展示哪些行失败 */
const lastResult = ref<ImportStudentsResult | null>(null)

/** 搜索过滤 */
const keyword = ref('')

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return students.value
  return students.value.filter(
    (s) => s.student_no.toLowerCase().includes(q) || s.student_name.toLowerCase().includes(q),
  )
})

onMounted(async () => {
  await loadClasses()
})

async function loadClasses() {
  try {
    const result = await api.classes()
    classes.value = result.items
    if (classes.value.length > 0 && selectedClassId.value === null) {
      selectedClassId.value = classes.value[0].id
      await loadStudents()
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '班级加载失败')
  }
}

async function loadStudents() {
  if (!selectedClassId.value) {
    students.value = []
    return
  }
  loading.value = true
  try {
    const result = await api.classStudents(selectedClassId.value)
    students.value = result.items
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '名单加载失败')
    students.value = []
  } finally {
    loading.value = false
  }
}

/** 切换班级时重新加载 */
function onClassChange() {
  keyword.value = ''
  lastResult.value = null
  loadStudents()
}

/** 打开导入对话框 */
function openImport() {
  importText.value = ''
  importReplace.value = false
  lastResult.value = null
  importVisible.value = true
}

/** 执行导入 */
async function doImport() {
  if (!selectedClassId.value) return
  const text = importText.value.trim()
  if (!text) {
    ElMessage.warning('请粘贴名单内容')
    return
  }

  // 整班替换是破坏性操作，先确认
  if (importReplace.value && students.value.length > 0) {
    try {
      await ElMessageBox.confirm(
        `将清空当前 ${students.value.length} 人名单后重新导入，确定继续？`,
        '确认替换名单',
        { type: 'warning', confirmButtonText: '确定替换', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }

  importing.value = true
  try {
    const result = await api.importClassStudents(
      selectedClassId.value,
      text,
      importReplace.value,
    )
    lastResult.value = result
    const parts = [`新增 ${result.inserted} 人`]
    if (result.updated > 0) parts.push(`更新 ${result.updated} 人`)
    if (result.invalid.length > 0) parts.push(`${result.invalid.length} 行有问题`)
    ElMessage.success(`导入完成：${parts.join('，')}，当前名单 ${result.total} 人`)
    await loadStudents()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '导入失败')
  } finally {
    importing.value = false
  }
}

/** 删除单个学生 */
async function removeStudent(student: ClassStudent) {
  if (!selectedClassId.value) return
  try {
    await ElMessageBox.confirm(
      `确定把「${student.student_no} ${student.student_name}」从名单中移除？`,
      '移除学生',
      { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await api.removeClassStudent(selectedClassId.value, student.id)
    ElMessage.success('已移除')
    await loadStudents()
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '移除失败')
  }
}

/** 当前班级名 */
const currentClassName = computed(
  () => classes.value.find((c) => c.id === selectedClassId.value)?.name ?? '',
)
</script>

<template>
  <div class="roster">
    <div class="roster__head">
      <div class="roster__head-left">
        <span class="roster__label">班级</span>
        <el-select
          v-model="selectedClassId"
          placeholder="选择班级"
          style="width: 200px"
          @change="onClassChange"
        >
          <el-option v-for="c in classes" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
        <el-input
          v-model="keyword"
          placeholder="搜索学号或姓名"
          clearable
          style="width: 200px"
          :disabled="students.length === 0"
        />
        <span class="roster__count">
          共 {{ filtered.length }} 人{{ keyword ? ` / ${students.length}` : '' }}
        </span>
      </div>
      <div class="roster__head-right">
        <el-button type="primary" :disabled="!selectedClassId" @click="openImport">
          导入名单
        </el-button>
      </div>
    </div>

    <div v-if="loading" class="empty-state">正在加载…</div>

    <template v-else>
      <div v-if="!selectedClassId" class="empty-state">
        请先选择班级。名单按班级维护，同一门课在不同班级的应缴人数不同。
      </div>

      <div v-else-if="students.length === 0" class="roster__empty">
        <p>「{{ currentClassName }}」还没有学生名单。</p>
        <p class="roster__empty-hint">
          导入名单后，课程详情里就能看到每节课「谁没交作业」。<br />
          支持从 Excel 复制两列直接粘贴，每行「学号 姓名」。
        </p>
        <el-button type="primary" @click="openImport">导入名单</el-button>
      </div>

      <el-table v-else :data="filtered" size="small" max-height="520">
        <el-table-column type="index" label="#" width="56" />
        <el-table-column prop="student_no" label="学号" width="140" />
        <el-table-column prop="student_name" label="姓名" width="120" />
        <el-table-column label="加入时间" width="170">
          <template #default="{ row }">{{ formatTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button link type="danger" size="small" @click="removeStudent(row)">
              移除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <!-- 导入对话框 -->
    <el-dialog v-model="importVisible" title="导入学生名单" width="600px">
      <div class="import">
        <p class="import__tip">
          每行一位学生，格式为「学号 姓名」，可用空格、Tab 或逗号分隔。<br />
          可直接从 Excel 复制两列粘贴，表头会自动跳过。
        </p>

        <el-input
          v-model="importText"
          type="textarea"
          :rows="10"
          placeholder="20240101 张三&#10;20240102 李四&#10;20240103 王五"
          class="import__input"
        />

        <el-checkbox v-model="importReplace" class="import__replace">
          清空原名单后重新导入（整班替换）
        </el-checkbox>

        <!-- 导入结果：把有问题的行明确列出来，方便教师修正 -->
        <div v-if="lastResult" class="import__result">
          <div class="import__result-summary">
            <el-tag type="success" size="small">新增 {{ lastResult.inserted }}</el-tag>
            <el-tag v-if="lastResult.updated > 0" type="info" size="small">
              更新 {{ lastResult.updated }}
            </el-tag>
            <el-tag v-if="lastResult.invalid.length > 0" type="warning" size="small">
              异常 {{ lastResult.invalid.length }}
            </el-tag>
            <span class="import__result-total">名单共 {{ lastResult.total }} 人</span>
          </div>
          <div v-if="lastResult.invalid.length > 0" class="import__invalid">
            <div v-for="item in lastResult.invalid" :key="`${item.line}-${item.raw}`" class="import__invalid-row">
              <span class="import__invalid-line">第 {{ item.line }} 行</span>
              <span class="import__invalid-raw">{{ item.raw || '（空）' }}</span>
              <span class="import__invalid-reason">{{ item.reason }}</span>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <el-button :disabled="importing" @click="importVisible = false">关闭</el-button>
        <el-button type="primary" :loading="importing" @click="doImport">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.roster {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.roster__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.roster__head-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.roster__label {
  font-size: 13px;
  color: var(--text-sub);
}

.roster__count {
  font-size: 13px;
  color: var(--text-sub);
}

.roster__empty {
  text-align: center;
  padding: 48px 20px;
  color: var(--text-sub);
}

.roster__empty p {
  margin: 0 0 10px;
}

.roster__empty-hint {
  font-size: 13px;
  line-height: 1.8;
  margin-bottom: 20px !important;
}

.import__tip {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-sub);
  line-height: 1.7;
}

.import__input {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.import__replace {
  margin-top: 10px;
}

.import__result {
  margin-top: 14px;
  padding: 12px;
  background: #f7f8fa;
  border-radius: 6px;
}

.import__result-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.import__result-total {
  font-size: 13px;
  color: var(--text-sub);
  margin-left: auto;
}

.import__invalid {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
}

.import__invalid-row {
  display: flex;
  gap: 10px;
  font-size: 12px;
  align-items: baseline;
}

.import__invalid-line {
  flex: none;
  color: var(--text-sub);
  font-variant-numeric: tabular-nums;
}

.import__invalid-raw {
  flex: none;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.import__invalid-reason {
  color: #e6a23c;
}
</style>
