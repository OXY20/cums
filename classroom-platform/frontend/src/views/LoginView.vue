<script setup lang="ts">
/**
 * 登录页：教师与管理员共用入口。
 */
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const loading = ref(false)

async function submit() {
  if (!username.value || !password.value) {
    ElMessage.warning('请输入用户名和口令')
    return
  }

  loading.value = true
  try {
    await auth.login(username.value, password.value)
    ElMessage.success('登录成功')
    const redirect = route.query.redirect
    router.push(typeof redirect === 'string' ? redirect : '/admin/console')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-logo">
        <svg class="login-logo__svg" viewBox="0 0 256 256" aria-hidden="true">
          <path fill="#7c8bf8" d="M128 40L172 88L146 88L146 122L110 122L110 88L84 88ZM46 118L210 118L210 210Q178 220 128 220Q78 220 46 210Z"/>
        </svg>
      </div>
      <h1 class="login-title">教师端登录</h1>
      <p class="login-subtitle">机房教学资源平台</p>

      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="用户名">
          <el-input v-model="username" placeholder="请输入用户名" autocomplete="username" />
        </el-form-item>

        <el-form-item label="口令">
          <el-input
            v-model="password"
            type="password"
            placeholder="请输入口令"
            show-password
            autocomplete="current-password"
            @keyup.enter="submit"
          />
        </el-form-item>

        <el-button type="primary" style="width: 100%" :loading="loading" @click="submit">
          登录
        </el-button>
      </el-form>

      <p class="login-hint">初始管理员账号为 admin，首次登录后请立即修改口令。</p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: grid;
  place-items: center;
  padding: 60px 20px;
}

.login-card {
  width: 100%;
  max-width: 360px;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  padding: 28px 26px;
}

.login-title {
  margin: 0 0 2px;
  font-size: 20px;
  font-weight: 600;
}

.login-logo {
  width: 72px;
  height: 72px;
  margin: 0 auto 16px;
  display: grid;
  place-items: center;
  background: var(--brand-soft);
  border-radius: 20px;
}

.login-logo__svg {
  width: 44px;
  height: 44px;
  display: block;
}

.login-subtitle {
  margin: 0 0 22px;
  color: var(--text-sub);
  font-size: 13px;
}

.login-hint {
  margin: 16px 0 0;
  color: var(--text-sub);
  font-size: 12px;
}
</style>
