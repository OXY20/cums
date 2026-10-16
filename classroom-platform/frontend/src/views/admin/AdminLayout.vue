<script setup lang="ts">
/**
 * 教师端布局：左侧导航 + 内容区。
 * 窄屏时导航折叠为图标条。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()

const navItems = [
  { path: '/admin/console', label: '课堂控制台', icon: 'console' },
  { path: '/admin/courses', label: '课程管理', icon: 'course' },
  { path: '/admin/resources', label: '资源库', icon: 'resource' },
  { path: '/admin/system', label: '系统状态', icon: 'system' },
]

const displayName = computed(() => auth.displayName)

function logout() {
  auth.logout()
  router.push('/student')
}
</script>

<template>
  <div class="admin-layout">
    <aside class="admin-sidebar">
      <nav>
        <RouterLink
          v-for="item in navItems"
          :key="item.path"
          :to="item.path"
          class="admin-nav-item"
        >
          <span class="admin-nav-item__label">{{ item.label }}</span>
        </RouterLink>
      </nav>
    </aside>

    <section class="admin-content">
      <div class="admin-topbar">
        <span class="admin-topbar__user">{{ displayName }}</span>
        <el-button link @click="logout">退出登录</el-button>
      </div>
      <RouterView />
    </section>
  </div>
</template>

<style scoped>
.admin-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 20px;
  max-width: 1320px;
  margin: 0 auto;
  padding: 20px;
  align-items: start;
}

.admin-sidebar {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  padding: 10px;
  position: sticky;
  top: 76px;
}

.admin-nav-item {
  display: block;
  padding: 9px 12px;
  border-radius: 6px;
  color: var(--text-main);
  text-decoration: none;
  font-size: 14px;
  margin-bottom: 2px;
}

.admin-nav-item:hover {
  background: var(--brand-soft);
  color: var(--brand);
}

.admin-nav-item.router-link-active {
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 600;
}

.admin-topbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-bottom: 14px;
  color: var(--text-sub);
  font-size: 13px;
}

@media (max-width: 900px) {
  .admin-layout {
    grid-template-columns: 1fr;
  }

  .admin-sidebar {
    position: static;
  }

  .admin-sidebar nav {
    display: flex;
    gap: 6px;
    overflow-x: auto;
  }

  .admin-nav-item {
    white-space: nowrap;
  }
}
</style>
