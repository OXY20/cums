<script setup lang="ts">
/**
 * 首次安装向导：创建管理员账号并确认基础配置。
 *
 * 未完成安装时，服务端只开放 `/api/setup/*`；其余业务接口一律拒绝，
 * 因此本页是唯一的入口，完成后跳转登录页。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, type SetupInstallResult, type SetupStatus } from '@/api'
import { markInstalled } from '@/utils/installState'

const router = useRouter()

/** 当前步骤：0 管理员账号，1 基础配置，2 完成 */
const step = ref(0)

const loading = ref(true)
const submitting = ref(false)
const status = ref<SetupStatus | null>(null)
const result = ref<SetupInstallResult | null>(null)

/** 管理员账号表单 */
const username = ref('')
const displayName = ref('')
const password = ref('')
const passwordConfirm = ref('')

/** 基础配置表单 */
const bind = ref('0.0.0.0:8080')
const databasePath = ref('data/classroom.db')
const storageDir = ref('storage/objects')
const tokenTtlHours = ref(12)

/** 表单校验错误 */
const errors = ref<Record<string, string>>({})

const isAdminStep = computed(() => step.value === 0)
const isConfigStep = computed(() => step.value === 1)
const isDoneStep = computed(() => step.value === 2)

onMounted(async () => {
  try {
    const info = await api.setupStatus()
    status.value = info

    if (info.installed) {
      // 已安装：直接跳登录页，不展示向导。
      router.replace('/login')
      return
    }

    if (info.defaults) {
      bind.value = info.defaults.bind
      databasePath.value = info.defaults.database_path
      storageDir.value = info.defaults.storage_dir
      tokenTtlHours.value = info.defaults.token_ttl_hours
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '无法读取安装状态')
  } finally {
    loading.value = false
  }
})

/** 校验管理员账号表单 */
function validateAdmin(): boolean {
  const next: Record<string, string> = {}

  const name = username.value.trim()
  if (!name) {
    next.username = '请输入管理员用户名'
  } else if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    next.username = '只能包含字母、数字、下划线、中划线和点'
  } else if (name.length > 64) {
    next.username = '用户名过长（最多 64 个字符）'
  }

  if (password.value.length < 8) {
    next.password = '口令至少 8 位'
  }

  if (password.value !== passwordConfirm.value) {
    next.passwordConfirm = '两次输入的口令不一致'
  }

  errors.value = next
  return Object.keys(next).length === 0
}

/** 校验基础配置表单 */
function validateConfig(): boolean {
  const next: Record<string, string> = {}

  const address = bind.value.trim()
  if (address) {
    // 允许只填端口，或 host:port 形式。
    if (!/^\d+$/.test(address)) {
      const parts = address.split(':')
      if (parts.length !== 2 || !parts[0] || !/^\d+$/.test(parts[1])) {
        next.bind = '格式应为 8080 或 0.0.0.0:8080'
      }
    } else if (Number(address) < 1 || Number(address) > 65535) {
      next.bind = '端口号需在 1–65535 之间'
    }
  }

  for (const [key, label] of [
    ['databasePath', '数据库路径'],
    ['storageDir', '资源目录'],
  ] as const) {
    const value = key === 'databasePath' ? databasePath.value : storageDir.value
    const trimmed = value.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
      next[key] = `${label}需为相对于数据根目录的路径`
    } else if (trimmed.split(/[\\/]/).includes('..')) {
      next[key] = `${label}不能包含上级目录跳转`
    }
  }

  if (tokenTtlHours.value < 1 || tokenTtlHours.value > 720) {
    next.tokenTtlHours = '令牌有效期需在 1–720 小时之间'
  }

  errors.value = next
  return Object.keys(next).length === 0
}

/** 下一步：校验通过后进入基础配置步骤 */
function nextStep() {
  if (!validateAdmin()) return
  errors.value = {}
  step.value = 1
}

/** 上一步 */
function prevStep() {
  errors.value = {}
  step.value = 0
}

/** 提交安装 */
async function submit() {
  if (!validateConfig()) return

  submitting.value = true
  try {
    result.value = await api.setupInstall({
      username: username.value.trim(),
      display_name: displayName.value.trim(),
      password: password.value,
      password_confirm: passwordConfirm.value,
      bind: bind.value.trim(),
      database_path: databasePath.value.trim(),
      storage_dir: storageDir.value.trim(),
      token_ttl_hours: tokenTtlHours.value,
    })
    // 同步路由守卫的安装状态缓存，避免完成后仍被弹回向导。
    markInstalled()
    step.value = 2
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '安装失败')
  } finally {
    submitting.value = false
  }
}

/** 安装完成后进入登录页 */
function goLogin() {
  router.push('/login')
}
</script>

<template>
  <div class="setup-page">
    <div class="setup-card">
      <div class="setup-logo">
        <svg class="setup-logo__svg" viewBox="0 0 256 256" aria-hidden="true">
          <path fill="#7c8bf8" d="M128 40L172 88L146 88L146 122L110 122L110 88L84 88ZM46 118L210 118L210 210Q178 220 128 220Q78 220 46 210Z" />
        </svg>
      </div>

      <h1 class="setup-title">安装向导</h1>
      <p class="setup-subtitle">机房教学资源平台首次使用，请完成以下配置</p>

      <el-steps :active="step" align-center finish-status="success" class="setup-steps">
        <el-step title="管理员账号" />
        <el-step title="基础配置" />
        <el-step title="完成" />
      </el-steps>

      <div v-if="loading" class="setup-loading">正在检查安装状态…</div>

      <!-- 第 1 步：管理员账号 -->
      <el-form v-else-if="isAdminStep" label-position="top" @submit.prevent="nextStep">
        <el-form-item label="管理员用户名" :error="errors.username">
          <el-input
            v-model="username"
            placeholder="用于登录教师端，例如 admin"
            autocomplete="username"
          />
        </el-form-item>

        <el-form-item label="显示名称" help="留空时显示为「系统管理员」">
          <el-input v-model="displayName" placeholder="系统管理员" />
        </el-form-item>

        <el-form-item label="登录口令" :error="errors.password">
          <el-input
            v-model="password"
            type="password"
            placeholder="至少 8 位"
            show-password
            autocomplete="new-password"
          />
        </el-form-item>

        <el-form-item label="确认口令" :error="errors.passwordConfirm">
          <el-input
            v-model="passwordConfirm"
            type="password"
            placeholder="再次输入口令"
            show-password
            autocomplete="new-password"
            @keyup.enter="nextStep"
          />
        </el-form-item>

        <el-button type="primary" style="width: 100%" @click="nextStep">下一步</el-button>
      </el-form>

      <!-- 第 2 步：基础配置 -->
      <el-form v-else-if="isConfigStep" label-position="top" @submit.prevent="submit">
        <el-form-item label="服务监听地址" :error="errors.bind" help="修改后需重启服务生效">
          <el-input v-model="bind" placeholder="0.0.0.0:8080" />
        </el-form-item>

        <el-form-item label="数据库路径" :error="errors.databasePath" help="相对于数据根目录">
          <el-input v-model="databasePath" placeholder="data/classroom.db" />
        </el-form-item>

        <el-form-item label="资源目录" :error="errors.storageDir" help="相对于数据根目录">
          <el-input v-model="storageDir" placeholder="storage/objects" />
        </el-form-item>

        <el-form-item label="登录令牌有效期（小时）" :error="errors.tokenTtlHours">
          <el-input-number v-model="tokenTtlHours" :min="1" :max="720" style="width: 100%" />
        </el-form-item>

        <div class="setup-actions">
          <el-button @click="prevStep">上一步</el-button>
          <el-button type="primary" :loading="submitting" @click="submit">完成安装</el-button>
        </div>
      </el-form>

      <!-- 第 3 步：完成 -->
      <div v-else-if="isDoneStep" class="setup-done">
        <el-result icon="success" title="安装完成" :sub-title="result?.message">
          <template #extra>
            <p class="setup-done__account">
              管理员账号：<strong>{{ result?.username }}</strong>
            </p>
            <el-button type="primary" @click="goLogin">前往登录</el-button>
          </template>
        </el-result>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setup-page {
  display: grid;
  place-items: center;
  padding: 40px 20px;
}

.setup-card {
  width: 100%;
  max-width: 480px;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  padding: 32px 30px;
}

.setup-logo {
  width: 72px;
  height: 72px;
  margin: 0 auto 16px;
  display: grid;
  place-items: center;
  background: var(--brand-soft);
  border-radius: 20px;
}

.setup-logo__svg {
  width: 44px;
  height: 44px;
  display: block;
}

.setup-title {
  margin: 0 0 2px;
  font-size: 20px;
  font-weight:600;
  text-align: center;
}

.setup-subtitle {
  margin: 0 0 24px;
  color: var(--text-sub);
  font-size: 13px;
  text-align: center;
}

.setup-steps {
  margin-bottom: 24px;
}

.setup-loading {
  padding: 40px 0;
  text-align: center;
  color: var(--text-sub);
}

.setup-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.setup-done__account {
  margin: 0 0 16px;
  color: var(--text-sub);
  font-size: 13px;
}
</style>
