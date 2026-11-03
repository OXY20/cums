<script setup lang="ts">
/**
 * 开发模式下的界面标注开关。
 *
 * AGENT-DECISION: 只在 vite dev（import.meta.env.DEV）下渲染，
 * 生产构建里 App.vue 的 v-if 恒为 false，本组件与标注集不会进入产物。
 *
 * 用法：顶栏点「标注」开关；也可用 URL 参数直接进入标注态，
 * 例如 /student/courses/4?annotate=student-course-detail。
 */
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { loadAnnotationSet, type AnnotationItem } from '@/utils/annotate'
import AnnotationOverlay from '@/components/AnnotationOverlay.vue'

const route = useRoute()
const router = useRouter()

/** 路由 → 标注集 */
const SET_BY_ROUTE: { pattern: RegExp; set: string }[] = [
  { pattern: /^\/student\/courses\//, set: 'student-course-detail' },
  { pattern: /^\/student\/sessions\//, set: 'student-session-detail' },
]

const enabled = ref(false)
const items = ref<AnnotationItem[]>([])
const setName = ref('')
const error = ref('')

/** 当前应使用的标注集：URL 参数优先，其次按路由推断 */
function currentSet(): string {
  const q = new URLSearchParams(window.location.search).get('annotate')
  if (q && q !== '1') return q
  for (const item of SET_BY_ROUTE) {
    if (item.pattern.test(route.path)) return item.set
  }
  return 'student-course-detail'
}

async function loadSet(name: string) {
  try {
    const set = await loadAnnotationSet(name)
    items.value = set.items
    error.value = ''
  } catch (err) {
    items.value = []
    error.value = err instanceof Error ? err.message : '标注集加载失败'
  }
}

onMounted(async () => {
  const q = new URLSearchParams(window.location.search)
  if (!q.get('annotate')) return
  enabled.value = true
  setName.value = currentSet()
  await loadSet(setName.value)
})

// 路由变化时切换到对应的标注集
watch(
  () => route.fullPath,
  async () => {
    if (!enabled.value) return
    const name = currentSet()
    if (name === setName.value) return
    setName.value = name
    await loadSet(name)
  },
)

async function toggle() {
  enabled.value = !enabled.value
  const query = { ...route.query }

  if (enabled.value) {
    setName.value = currentSet()
    await loadSet(setName.value)
    query.annotate = setName.value
  } else {
    delete query.annotate
  }

  await router.replace({ path: route.path, query })
}
</script>

<template>
  <button
    type="button"
    class="dev-anno-toggle"
    :class="{ 'dev-anno-toggle--on': enabled }"
    :title="error || '界面标注：给页面元素加带色方框与标签'"
    @click="toggle"
  >
    {{ enabled ? '关闭标注' : '标注' }}
  </button>

  <AnnotationOverlay v-if="enabled && items.length > 0" :items="items" @close="toggle" />
</template>

<style scoped>
.dev-anno-toggle {
  border: 1px dashed var(--brand, #7c8bf8);
  background: transparent;
  color: var(--brand, #7c8bf8);
  border-radius: 4px;
  font-size: 12px;
  line-height: 20px;
  padding: 0 8px;
  cursor: pointer;
}

.dev-anno-toggle--on {
  border-style: solid;
  background: var(--brand, #7c8bf8);
  color: #fff;
}
</style>
