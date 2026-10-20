<script setup lang="ts">
/**
 * 应用外壳：顶部导航 + 路由出口。
 * 导航逻辑依据建设方案：未登录仅显示 [登录]；已登录显示 [全部课程] [我的课程] [用户]。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/api'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const version = ref('')

/** 教师端入口仅对已登录用户显示 */
const showAdminEntry = computed(() => auth.isLoggedIn)

const isAdminArea = computed(() => route.path.startsWith('/admin'))

onMounted(async () => {
  await auth.restore()
  try {
    // 公开接口，学生端未登录也能展示版本号。
    const info = await api.version()
    version.value = info.version
  } catch {
    version.value = ''
  }
})

function handleLogout() {
  auth.logout()
  router.push('/student')
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-header__inner">
        <div class="app-header__brand" @click="router.push('/student')">
          <svg class="app-header__brand-logo" viewBox="0 0 256 256" aria-hidden="true">
            <path fill="#7c8bf8" d="M128 40L172 88L146 88L146 122L110 122L110 88L84 88ZM46 118L210 118L210 210Q178 220 128 220Q78 220 46 210Z"/>
          </svg>
          <span>机房教学资源平台</span>
        </div>

        <nav class="app-header__nav">
          <RouterLink to="/student" class="nav-link">全部课程</RouterLink>

          <template v-if="auth.isLoggedIn">
            <RouterLink to="/student/downloads" class="nav-link">下载中心</RouterLink>
            <RouterLink v-if="showAdminEntry" to="/admin/console" class="nav-link">教师端</RouterLink>
            <el-dropdown>
              <span class="nav-user">
                {{ auth.displayName }}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="m6 9 6 6 6-6"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="router.push('/student/downloads')">下载中心</el-dropdown-item>
                  <el-dropdown-item divided @click="handleLogout">退出登录</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>

          <RouterLink v-else to="/login" class="nav-link nav-link--primary">登录</RouterLink>
        </nav>
      </div>
    </header>

    <main class="app-main" :class="{ 'app-main--admin': isAdminArea }">
      <RouterView />
    </main>

    <footer class="app-footer">
      机房教学资源平台<span v-if="version"> · v{{ version }}</span>
    </footer>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.app-header {
  background: #fff;
  border-bottom: 1px solid var(--border-color);
  position: sticky;
  top: 0;
  z-index: 10;
}

.app-header__inner {
  max-width: 1180px;
  margin: 0 auto;
  padding: 0 20px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.app-header__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--brand);
  cursor: pointer;
}

.app-header__brand-logo {
  width: 26px;
  height: 26px;
  display: block;
}

.app-header__nav {
  display: flex;
  align-items: center;
  gap: 18px;
}

.nav-link {
  color: var(--text-main);
  text-decoration: none;
  font-size: 14px;
}

.nav-link:hover {
  color: var(--brand);
}

.nav-link.router-link-active {
  color: var(--brand);
  font-weight: 600;
}

.nav-link--primary {
  color: var(--brand);
  font-weight: 600;
}

.nav-user {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  color: var(--text-main);
  outline: none;
}

.app-main {
  flex: 1 1 auto;
}

.app-footer {
  padding: 18px 0 26px;
  text-align: center;
  color: var(--text-sub);
  font-size: 12px;
}
</style>
