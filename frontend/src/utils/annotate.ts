/**
 * 界面标注：在页面上叠加带色方框与标签，用于前端界面调整沟通。
 *
 * AGENT-DECISION: 标注集放在 src/annotations/*.json，既能被本模块用
 * import.meta.glob 动态加载，也能被 scripts/annotate-page.mjs 直接读取，
 * 两边共用同一份数据，不会出现"脚本标注的与页面上看到的不一致"。
 * 本模块只在开发模式（import.meta.env.DEV）被动态引入，生产构建会整块移除。
 */

export interface AnnotationItem {
  /** 标签，如 A1 / B2 */
  tag: string
  /** 说明文字，显示在标签上 */
  note: string
  /** 目标元素的 CSS 选择器 */
  sel: string
  /** 方框颜色；缺省时按色板顺序取 */
  color?: string
  /** 为 true 时标注全部匹配元素，否则只标注第一个 */
  all?: boolean
  /** 覆盖目标：只框这个选择器命中的元素 */
  mark?: string
}

export interface AnnotationSet {
  /** 标注集名称 */
  name?: string
  items: AnnotationItem[]
}

export interface AnnotationTarget {
  tag: string
  note: string
  color: string
  element: HTMLElement
  /** 同一标签下的序号（从 0 开始） */
  index: number
  /** 同一标签命中的元素总数 */
  total: number
}

/** 未指定颜色时按顺序取色 */
const PALETTE = [
  '#e5484d',
  '#0090ff',
  '#12a594',
  '#f5a524',
  '#8e4ec6',
  '#e93d82',
  '#3e9b4f',
  '#7a7f87',
]

/** 给元素分配稳定编号，用于判断标注目标是否发生变化 */
const elementIds = new WeakMap<HTMLElement, number>()
let nextElementId = 1

function elementId(element: HTMLElement): number {
  let id = elementIds.get(element)
  if (id === undefined) {
    id = nextElementId++
    elementIds.set(element, id)
  }
  return id
}

/** 把标注集解析成实际命中的元素列表 */
export function resolveTargets(items: AnnotationItem[]): AnnotationTarget[] {
  const targets: AnnotationTarget[] = []

  items.forEach((item, itemIndex) => {
    const color = item.color ?? PALETTE[itemIndex % PALETTE.length]

    let elements: HTMLElement[] = []
    if (item.mark) {
      const marked = document.querySelector(item.mark)
      if (marked) elements = [marked as HTMLElement]
    }
    if (elements.length === 0) {
      const found = Array.from(document.querySelectorAll<HTMLElement>(item.sel))
      elements = item.all ? found : found.slice(0, 1)
    }

    elements.forEach((element, index) => {
      targets.push({
        tag: item.tag,
        note: item.note,
        color,
        element,
        index,
        total: elements.length,
      })
    })
  })

  return targets
}

interface BoxHandle {
  target: AnnotationTarget
  box: HTMLElement
  label: HTMLElement
}

/**
 * 标注覆盖层。
 *
 * 覆盖层固定在视口上，元素位置每次滚动、缩放或 DOM 变化后重新测量，
 * 因此异步加载出来的内容也会自动补上标注。
 */
export class AnnotationLayer {
  private root: HTMLElement
  private handles = new Map<string, BoxHandle>()
  private targets: AnnotationTarget[] = []
  private frame = 0
  private refreshTimer: number | undefined
  private observer: MutationObserver

  constructor(private items: AnnotationItem[], private onChange?: () => void) {
    this.root = document.createElement('div')
    this.root.className = 'annotation-layer'
    // AGENT-DECISION: 覆盖层不拦截鼠标事件，标注开启时仍可正常点击页面
    this.root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483000;'
    document.body.appendChild(this.root)

    window.addEventListener('scroll', this.schedule, { capture: true, passive: true })
    window.addEventListener('resize', this.schedule)

    // AGENT-DECISION: 监听 DOM 变化后重新解析，接口数据渲染完成的元素也能被标注
    this.observer = new MutationObserver(() => this.scheduleRefresh())
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    })

    this.refresh()
  }

  /** 当前标注命中情况，供清单面板展示 */
  summary(): { tag: string; note: string; color: string; count: number }[] {
    const map = new Map<string, { tag: string; note: string; color: string; count: number }>()
    this.items.forEach((item, itemIndex) => {
      const color = item.color ?? PALETTE[itemIndex % PALETTE.length]
      map.set(item.tag, { tag: item.tag, note: item.note, color, count: 0 })
    })
    for (const target of this.targets) {
      const entry = map.get(target.tag)
      if (entry) entry.count += 1
    }
    return [...map.values()]
  }

  private schedule = () => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.update()
    })
  }

  private scheduleRefresh() {
    if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer)
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = undefined
      this.refresh()
    }, 200)
  }

  /** 重新解析目标并同步方框 */
  refresh() {
    this.targets = resolveTargets(this.items)
    const wanted = new Map<string, AnnotationTarget>()
    for (const target of this.targets) {
      wanted.set(`${target.tag}#${elementId(target.element)}#${target.index}`, target)
    }

    // 移除已失效的方框
    for (const [key, handle] of [...this.handles]) {
      if (!wanted.has(key)) {
        handle.box.remove()
        this.handles.delete(key)
      }
    }

    for (const [key, target] of wanted) {
      const handle = this.handles.get(key)
      if (handle) {
        handle.target = target
        continue
      }
      this.handles.set(key, this.createBox(target))
    }

    this.update()
    this.onChange?.()
  }

  private createBox(target: AnnotationTarget): BoxHandle {
    const box = document.createElement('div')
    box.style.cssText = [
      'position:absolute',
      'box-sizing:border-box',
      `border:2px solid ${target.color}`,
      'border-radius:4px',
      `background:${target.color}14`,
    ].join(';')

    // AGENT-DECISION: 角标只显示编号并放在框的左上角外侧，
    // 说明文字放右下角清单面板，避免宽标签压住正文。
    const label = document.createElement('div')
    label.textContent = target.total > 1 ? `${target.tag}.${target.index + 1}` : target.tag
    label.title = target.note
    label.style.cssText = [
      'position:absolute',
      'left:-2px',
      'top:-2px',
      'transform:translateY(-100%)',
      `background:${target.color}`,
      'color:#fff',
      'font:600 10px/14px "Segoe UI",sans-serif',
      'padding:0 4px',
      'border-radius:2px',
      'white-space:nowrap',
      'box-shadow:0 0 0 1px #fff',
    ].join(';')

    box.appendChild(label)
    this.root.appendChild(box)
    return { target, box, label }
  }

  /** 同步方框位置与标签摆放 */
  private update() {
    for (const handle of this.handles.values()) {
      const rect = handle.target.element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        handle.box.style.display = 'none'
        continue
      }
      handle.box.style.display = ''
      handle.box.style.left = `${rect.left}px`
      handle.box.style.top = `${rect.top}px`
      handle.box.style.width = `${rect.width}px`
      handle.box.style.height = `${rect.height}px`
    }
  }

  destroy() {
    window.removeEventListener('scroll', this.schedule, { capture: true })
    window.removeEventListener('resize', this.schedule)
    this.observer.disconnect()
    if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer)
    if (this.frame) cancelAnimationFrame(this.frame)
    this.root.remove()
    this.handles.clear()
  }
}

/** 标注集加载器：按文件名动态引入 src/annotations 下的 JSON */
const setLoaders = import.meta.glob('../annotations/*.json', { import: 'default' })

export async function loadAnnotationSet(name: string): Promise<AnnotationSet> {
  const loader = setLoaders[`../annotations/${name}.json`]
  if (!loader) {
    const available = Object.keys(setLoaders)
      .map((key) => key.split('/').pop()?.replace('.json', '') ?? key)
      .join('、')
    throw new Error(`标注集不存在：${name}（可用：${available}）`)
  }
  return (await loader()) as unknown as AnnotationSet
}
