import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 构建产物由后端 static_dir 托管，因此输出到 backend 可直接读取的位置。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // 开发时把 API 与文件请求代理到后端，避免跨域配置。
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/files': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: '../app/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
})
