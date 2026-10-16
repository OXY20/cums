/**
 * 认证状态：令牌持久化与当前用户信息。
 */
import { defineStore } from 'pinia'
import { api, getToken, setToken, type UserInfo } from '@/api'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as UserInfo | null,
    /** 是否已完成首次身份恢复，避免刷新时闪烁 */
    ready: false,
  }),

  getters: {
    isLoggedIn: (state) => state.user !== null,
    isAdmin: (state) => state.user?.role === 'admin',
    displayName: (state) => state.user?.display_name || state.user?.username || '',
  },

  actions: {
    /** 登录并保存令牌 */
    async login(username: string, password: string) {
      const result = await api.login(username, password)
      setToken(result.token)
      this.user = result.user
      this.ready = true
      return result.user
    },

    /** 退出登录 */
    logout() {
      setToken(null)
      this.user = null
    },

    /** 页面刷新后恢复登录状态 */
    async restore() {
      if (!getToken()) {
        this.ready = true
        return
      }
      try {
        this.user = await api.me()
      } catch {
        // 令牌过期或无效时静默清理
        setToken(null)
        this.user = null
      } finally {
        this.ready = true
      }
    },
  },
})
