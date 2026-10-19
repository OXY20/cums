<script setup lang="ts">
/**
 * 作业文件预览组件。
 *
 * 按用途分流：
 * - 图片：直接内嵌；点击可放大到新窗口
 * - 视频：`<video controls>` 在线播放
 * - PDF：`<iframe>` 内嵌（浏览器自带阅读器）
 * - 其他文档：显示文件图标与下载按钮，不做伪预览
 *
 * 所有预览地址都带 `inline=1`，服务端会返回 `Content-Disposition: inline`。
 */
import { computed, ref } from 'vue'
import { inlineFileUrl, fileUrl, type SubmissionFile, type SubmissionDetail } from '@/api'
import { formatBytes } from '@/utils/format'

const props = defineProps<{
  /** 完整提交详情；与 files 二选一 */
  detail?: SubmissionDetail | null
}>()

/** 当前选中的文件索引 */
const activeIndex = ref(0)

const files = computed<SubmissionFile[]>(() => props.detail?.files ?? [])

const active = computed<SubmissionFile | null>(() => files.value[activeIndex.value] ?? null)

/** 文件类型图标，用文字符号避免额外依赖 */
const KIND_LABELS: Record<string, string> = {
  image: '图片',
  video: '视频',
  attachment: '文件',
}

function kindLabel(file: SubmissionFile): string {
  return KIND_LABELS[file.purpose] ?? '文件'
}

/** 是否为 PDF：PDF 可以用 iframe 内嵌预览 */
function isPdf(file: SubmissionFile): boolean {
  return file.mime_type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

/** 是否为纯文本/代码，可用浏览器直接展示 */
function isText(file: SubmissionFile): boolean {
  return file.mime_type.startsWith('text/') || /\.(txt|log|md|csv)$/i.test(file.name)
}

function selectFile(index: number) {
  activeIndex.value = index
}

function openInNewTab(file: SubmissionFile) {
  window.open(inlineFileUrl(file.resource_id), '_blank')
}

function download(file: SubmissionFile) {
  window.open(fileUrl(file.resource_id), '_blank')
}
</script>

<template>
  <div class="preview">
    <div v-if="files.length === 0" class="empty-state">暂无文件。</div>

    <template v-else>
      <!-- 文件切换条：多文件提交时在弹窗内快速切换 -->
      <div class="preview__tabs">
        <button
          v-for="(file, index) in files"
          :key="file.resource_id"
          class="preview__tab"
          :class="{ 'preview__tab--active': index === activeIndex }"
          type="button"
          :title="file.name"
          @click="selectFile(index)"
        >
          <span class="preview__tab-kind">{{ kindLabel(file) }}</span>
          <span class="preview__tab-name">{{ file.name }}</span>
        </button>
      </div>

      <!-- 预览主体 -->
      <div v-if="active" class="preview__body">
        <img
          v-if="active.purpose === 'image'"
          :src="inlineFileUrl(active.resource_id)"
          :alt="active.name"
          class="preview__image"
        />

        <video
          v-else-if="active.purpose === 'video'"
          :src="inlineFileUrl(active.resource_id)"
          controls
          preload="metadata"
          class="preview__video"
        />

        <iframe
          v-else-if="isPdf(active)"
          :src="inlineFileUrl(active.resource_id)"
          class="preview__frame"
          title="PDF 预览"
        />

        <iframe
          v-else-if="isText(active)"
          :src="inlineFileUrl(active.resource_id)"
          class="preview__frame preview__frame--text"
          title="文本预览"
        />

        <div v-else class="preview__fallback">
          <div class="preview__fallback-icon">📄</div>
          <div class="preview__fallback-name">{{ active.name }}</div>
          <div class="preview__fallback-meta">
            {{ formatBytes(active.size_bytes) }} · {{ active.mime_type || '未知类型' }}
          </div>
          <p class="preview__fallback-hint">
            该类型不支持页内预览，请下载后用本地软件打开。
          </p>
          <div class="preview__actions">
            <el-button type="primary" @click="download(active)">下载文件</el-button>
            <el-button @click="openInNewTab(active)">新窗口打开</el-button>
          </div>
        </div>
      </div>

      <!-- 文件信息 -->
      <div v-if="active" class="preview__meta">
        <span class="preview__meta-name">{{ active.name }}</span>
        <span class="preview__meta-size">{{ formatBytes(active.size_bytes) }}</span>
        <span class="preview__meta-type">{{ active.mime_type || '未知类型' }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 文件切换条 */
.preview__tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-color);
}

.preview__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-sub);
}

.preview__tab:hover {
  border-color: var(--brand);
  color: var(--brand);
}

.preview__tab--active {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
  font-weight: 600;
}

.preview__tab-kind {
  flex: none;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.06);
}

.preview__tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 预览主体 */
.preview__body {
  min-height: 260px;
  max-height: 60vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f7f8fa;
  border-radius: 8px;
  overflow: auto;
  padding: 10px;
}

.preview__image {
  max-width: 100%;
  max-height: 58vh;
  border-radius: 6px;
  display: block;
}

.preview__video {
  width: 100%;
  max-height: 58vh;
  border-radius: 6px;
  background: #000;
  display: block;
}

.preview__frame {
  width: 100%;
  height: 58vh;
  border: none;
  border-radius: 6px;
  background: #fff;
}

.preview__frame--text {
  background: #fff;
}

.preview__fallback {
  text-align: center;
  padding: 24px 16px;
}

.preview__fallback-icon {
  font-size: 40px;
  line-height: 1;
  margin-bottom: 10px;
}

.preview__fallback-name {
  font-weight: 600;
  margin-bottom: 4px;
  word-break: break-all;
}

.preview__fallback-meta {
  font-size: 12px;
  color: var(--text-sub);
  margin-bottom: 10px;
}

.preview__fallback-hint {
  font-size: 13px;
  color: var(--text-sub);
  margin: 0 0 14px;
}

.preview__actions {
  display: flex;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
}

/* 文件信息 */
.preview__meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-sub);
  padding-top: 4px;
}

.preview__meta-name {
  font-weight: 600;
  color: var(--text-main);
  word-break: break-all;
}
</style>
