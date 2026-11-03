<script setup lang="ts">
/**
 * 标注覆盖层：在页面上画带色方框与标签，右下角给出标注清单。
 *
 * 仅供开发模式下的界面调整沟通使用，不参与生产构建。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { AnnotationLayer, type AnnotationItem } from '@/utils/annotate'

const props = defineProps<{ items: AnnotationItem[] }>()
const emit = defineEmits<{ close: [] }>()

const summary = ref<{ tag: string; note: string; color: string; count: number }[]>([])
/** 清单默认收起，避免挡住页面内容 */
const expanded = ref(false)
let layer: AnnotationLayer | null = null

onMounted(() => {
  // 回调里要用到实例本身，构造期间实例尚未赋值，这里用可空变量承接
  let instance: AnnotationLayer | null = null
  instance = new AnnotationLayer(props.items, () => {
    summary.value = instance ? instance.summary() : []
  })
  layer = instance
  summary.value = instance.summary()
})

onUnmounted(() => {
  layer?.destroy()
  layer = null
})
</script>

<template>
  <div class="anno-panel" :class="{ 'anno-panel--collapsed': !expanded }">
    <div class="anno-panel__head">
      <strong>标注清单 {{ summary.length }}</strong>
      <span class="anno-panel__actions">
        <button type="button" class="anno-panel__close" @click="expanded = !expanded">
          {{ expanded ? '收起' : '展开' }}
        </button>
        <button type="button" class="anno-panel__close" @click="emit('close')">关闭</button>
      </span>
    </div>
    <ul v-show="expanded" class="anno-panel__list">
      <li v-for="item in summary" :key="item.tag" class="anno-panel__row">
        <span class="anno-panel__tag" :style="{ background: item.color }">{{ item.tag }}</span>
        <span class="anno-panel__note">{{ item.note }}</span>
        <span class="anno-panel__count" :class="{ 'anno-panel__count--miss': item.count === 0 }">
          {{ item.count === 0 ? '未找到' : `${item.count} 处` }}
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.anno-panel {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483100;
  width: 300px;
  max-height: 60vh;
  overflow: auto;
  background: #fff;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
  font-size: 12px;
}

/* 收起时只留标题条，不挡页面内容 */
.anno-panel--collapsed {
  width: auto;
  max-height: none;
}

.anno-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}

.anno-panel--collapsed .anno-panel__head {
  border-bottom: none;
}

.anno-panel__actions {
  display: inline-flex;
  gap: 6px;
}

.anno-panel__close {
  border: 1px solid var(--border-color, #e5e7eb);
  background: #fff;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text-sub, #6b7280);
  cursor: pointer;
  padding: 1px 8px;
}

.anno-panel__list {
  margin: 0;
  padding: 6px 10px 10px;
  list-style: none;
}

.anno-panel__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.anno-panel__tag {
  flex: none;
  min-width: 30px;
  text-align: center;
  color: #fff;
  font-weight: 600;
  border-radius: 3px;
  padding: 0 4px;
  line-height: 18px;
}

.anno-panel__note {
  flex: 1;
  color: var(--text-main, #1f2937);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.anno-panel__count {
  flex: none;
  color: var(--text-sub, #6b7280);
}

.anno-panel__count--miss {
  color: #e5484d;
}
</style>
