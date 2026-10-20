<script setup lang="ts">
/**
 * 富媒体编辑器：基于 Quill 2 的论坛式编辑器。
 *
 * 支持：
 * - 字号、标题、加粗/斜体/下划线/删除线、颜色、背景色、上下标
 * - 有序/无序列表、缩进、对齐、引用、代码块
 * - 插入链接
 * - 上传并插入图片、视频（上传到平台后以 /files/{id} 引用）
 * - 插入附件（以链接形式指向下载地址）
 *
 * 内容以 HTML 形式双向绑定；服务端会再次按白名单清洗，防止 XSS。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Quill from 'quill'
import 'quill/dist/quill.snow.css'
import { ElMessage } from 'element-plus'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    /** 上传图片/视频，返回可插入的 URL */
    onUpload?: (file: File) => Promise<string>
    /** 上传附件，返回可插入的 URL */
    onUploadAttachment?: (file: File) => Promise<string>
    readOnly?: boolean
    minHeight?: number
  }>(),
  {
    placeholder: '在此输入教学内容…',
    readOnly: false,
    minHeight: 320,
  },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const container = ref<HTMLDivElement | null>(null)
const uploading = ref(false)
let quill: Quill | null = null
/** 防止 watch 回写造成光标跳动 */
let internalChange = false

/** 工具栏：按论坛编辑器的常见布局分组 */
const TOOLBAR = [
  [{ size: ['small', false, 'large', 'huge'] }],
  [{ header: [1, 2, 3, 4, 5, 6, false] }],
  ['bold', 'italic', 'underline', 'strike'],
  [{ color: [] }, { background: [] }],
  [{ script: 'sub' }, { script: 'super' }],
  [{ list: 'ordered' }, { list: 'bullet' }, { indent: '-1' }, { indent: '+1' }],
  [{ align: [] }],
  ['blockquote', 'code-block'],
  ['link', 'image', 'video'],
  ['clean'],
]

onMounted(() => {
  if (!container.value) return

  quill = new Quill(container.value, {
    theme: 'snow',
    placeholder: props.placeholder,
    readOnly: props.readOnly,
    modules: {
      toolbar: {
        container: TOOLBAR,
        handlers: {
          image: () => pickAndUpload('image'),
          video: () => pickAndUpload('video'),
          link: insertLink,
        },
      },
    },
  })

  // 注意：不要为 table/tr/td/th 注册剪贴板 matcher。
  // Quill 的表格解析依赖内置规则，任何覆盖都会导致整张表在回填时被丢弃。
  // 表头样式改由以下方式处理：
  //   1. 服务端清洗时把表格首行还原为 <th>；
  //   2. 编辑器与学生端分别为首行补上背景样式（见 .ql-editor table tr:first-child）。
  // 把实例挂到编辑器根元素上，便于调试与自动化验证。
  // Quill 不暴露全局对象，且会重排 DOM，因此挂在 quill.root 最稳妥。
  ;(quill.root as unknown as { __quill: Quill }).__quill = quill

  // 初始内容
  if (props.modelValue) {
    quill.clipboard.dangerouslyPasteHTML(props.modelValue)
  }

  quill.on('text-change', () => {
    if (!quill) return
    internalChange = true
    // 编辑器为空时 Quill 返回 "<p><br></p>"，统一归一化为空串
    const html = quill.root.innerHTML
    emit('update:modelValue', html === '<p><br></p>' ? '' : html)
    internalChange = false
  })
})

// 外部值变化时同步到编辑器
watch(
  () => props.modelValue,
  (value) => {
    if (!quill || internalChange) return
    const current = quill.root.innerHTML
    const next = value || ''
    if (current === next || (next === '' && current === '<p><br></p>')) return

    const selection = quill.getSelection()
    quill.clipboard.dangerouslyPasteHTML(next)
    if (selection) quill.setSelection(selection)
  },
)

onBeforeUnmount(() => {
  quill = null
})

/** 弹出文件选择框并上传 */
function pickAndUpload(kind: 'image' | 'video') {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = kind === 'image' ? 'image/*' : 'video/*'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return

    if (!props.onUpload) {
      ElMessage.warning('当前不支持上传')
      return
    }

    uploading.value = true
    try {
      const url = await props.onUpload(file)
      insertEmbed(kind, url)
      ElMessage.success(kind === 'image' ? '图片已插入' : '视频已插入')
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : '上传失败')
    } finally {
      uploading.value = false
    }
  }
  input.click()
}

/** 在当前光标处插入图片或视频 */
function insertEmbed(kind: 'image' | 'video', url: string) {
  if (!quill) return
  const range = quill.getSelection(true)
  quill.insertEmbed(range.index, kind, url, 'user')
  quill.setSelection(range.index + 1)
}

/** 插入链接：支持站内与站外地址 */
function insertLink() {
  if (!quill) return
  const range = quill.getSelection(true)
  const existing = quill.getFormat(range).link as string | undefined

  const url = window.prompt('请输入链接地址（留空则移除链接）', existing ?? 'https://')
  if (url === null) return

  if (url.trim() === '') {
    quill.format('link', false, 'user')
    return
  }

  // 只接受 http/https/mailto 与站内相对路径，避免 javascript: 等危险协议
  const trimmed = url.trim()
  const safe =
    /^(https?:\/\/|mailto:|\/|#)/i.test(trimmed) ? trimmed : `https://${trimmed}`

  quill.format('link', safe, 'user')
}

/** 供父组件调用：把附件以链接形式插入正文 */
function insertAttachment(name: string, url: string) {
  if (!quill) return
  const range = quill.getSelection(true)
  quill.insertText(range.index, `📎 ${name}`, { link: url }, 'user')
  quill.setSelection(range.index + name.length + 2)
}

/** 供父组件调用：直接插入图片/视频 URL */
function insertMedia(kind: 'image' | 'video', url: string) {
  insertEmbed(kind, url)
}

/** 供父组件调用：取当前纯文本（用于字数统计或校验） */
function getText(): string {
  return quill?.getText().trim() ?? ''
}

defineExpose({ insertAttachment, insertMedia, getText })
</script>

<template>
  <div class="rich-editor" :class="{ 'rich-editor--readonly': readOnly }">
    <div ref="container" :style="{ minHeight: `${minHeight}px` }" />
    <div v-if="uploading" class="rich-editor__uploading">正在上传，请稍候…</div>
  </div>
</template>

<style scoped>
.rich-editor {
  position: relative;
  background: #fff;
  border-radius: 6px;
}

/* Quill 容器高度由内联样式控制 */
.rich-editor :deep(.ql-container) {
  font-size: 14px;
  font-family: inherit;
}

.rich-editor :deep(.ql-editor) {
  line-height: 1.75;
  color: var(--text-main);
}

.rich-editor :deep(.ql-editor img) {
  max-width: 100%;
  height: auto;
  border-radius: 6px;
}

.rich-editor :deep(.ql-editor video) {
  max-width: 100%;
  border-radius: 6px;
  background: #000;
}

.rich-editor :deep(.ql-editor blockquote) {
  border-left: 4px solid var(--brand);
  background: var(--brand-soft);
  padding: 8px 12px;
  margin: 8px 0;
  color: var(--text-main);
}

.rich-editor :deep(.ql-editor pre.ql-syntax) {
  background: #1f2937;
  color: #e5e7eb;
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
}

.rich-editor :deep(.ql-editor a) {
  color: var(--brand);
  text-decoration: underline;
}

/* 表格：Quill 默认不给表格样式，需自行补上 */
.rich-editor :deep(.ql-editor table) {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
}

.rich-editor :deep(.ql-editor th),
.rich-editor :deep(.ql-editor td) {
  border: 1px solid var(--border-color);
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}

.rich-editor :deep(.ql-editor th),
.rich-editor :deep(.ql-editor td.ql-table-header) {
  background: var(--page-bg);
  font-weight: 600;
}

/* 兼容旧数据：Quill 回填时首行可能丢失表头语义，按位置补底色 */
.rich-editor :deep(.ql-editor table tbody tr:first-child td) {
  background: var(--page-bg);
  font-weight: 600;
}

/* 代码块容器（Quill 2 的多行代码块） */
.rich-editor :deep(.ql-editor .ql-code-block-container) {
  background: #1f2937;
  color: #e5e7eb;
  border-radius: 6px;
  padding: 12px;
  margin: 8px 0;
}

/* 视频嵌入占位 */
.rich-editor :deep(.ql-editor .ql-video) {
  width: 100%;
  min-height: 260px;
  border-radius: 6px;
  background: #000;
}

/* 有序/无序列表在编辑器内的缩进 */
.rich-editor :deep(.ql-editor li) {
  margin: 4px 0;
}

.rich-editor :deep(.ql-editor hr) {
  border: none;
  border-top: 1px solid var(--border-color);
  margin: 16px 0;
}

.rich-editor :deep(.ql-toolbar) {
  border-top-left-radius: 6px;
  border-top-right-radius: 6px;
  border-color: var(--border-color);
  background: var(--page-bg);
}

.rich-editor :deep(.ql-container) {
  border-color: var(--border-color);
  border-bottom-left-radius: 6px;
  border-bottom-right-radius: 6px;
}

.rich-editor :deep(.ql-editor.ql-blank::before) {
  color: var(--text-sub);
  font-style: normal;
}

.rich-editor--readonly :deep(.ql-toolbar) {
  display: none;
}

.rich-editor__uploading {
  position: absolute;
  right: 12px;
  bottom: 12px;
  background: rgb(0 0 0 / 70%);
  color: #fff;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
}
</style>
