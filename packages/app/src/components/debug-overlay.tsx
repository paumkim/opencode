import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"

type StackFrame = {
  file: string
  line: number
  col: number
  name: string
}

const parseStack = (stack: string): StackFrame[] => {
  const frames: StackFrame[] = []
  const lines = stack.split("\n")
  for (const line of lines) {
    // Match Vite dev stack frames:
    //   at ComponentName (http://localhost:4444/src/components/foo.tsx:10:5)
    //   at http://localhost:4444/src/components/foo.tsx:10:5
    //   at /src/components/foo.tsx:10:5
    let match = line.match(
      /at\s+(?:(\S+)\s+\()?(?:https?:\/\/[^/]+)?(\/src\/[^)\s]+):(\d+):(\d+)\)?/,
    )
    if (!match) {
      match = line.match(/at\s+(?:(\S+)\s+\()?(\/src\/[^)\s]+):(\d+):(\d+)/)
    }
    if (!match) {
      match = line.match(/(\/src\/[^)\s]+):(\d+):(\d+)/)
    }
    if (match) {
      frames.push({
        file: match[1] ?? "",
        line: Number.parseInt(match[2], 10),
        col: Number.parseInt(match[3], 10),
        name: match[1] ?? "",
      })
    }
  }
  return frames
}

const shortenPath = (path: string): string => {
  const match = path.match(/\/src\/(.+)$/)
  if (match) return match[1]
  if (path.includes("/src/")) {
    const idx = path.indexOf("/src/")
    return path.slice(idx + 5)
  }
  return path
}

import { Accessor } from "solid-js"

export function DebugOverlay(props: { active: Accessor<boolean>; onToggle?: () => void }) {
  const active = createMemo(() => props.active())
  const [state, setState] = createStore({
    x: 0,
    y: 0,
    file: "",
    line: 0,
    col: 0,
    name: "",
    copied: false,
  })

  let lastTarget: Element | null = null
  let lastFrame: StackFrame | null = null
  let copyTimer: number | undefined
  let portalEl: HTMLDivElement | undefined
  let tooltipEl: HTMLDivElement | undefined

  const refreshFrame = (element: Element | null) => {
    if (!element) return
    const componentEl = element.closest("[data-component]") as HTMLElement | null
    const componentName = componentEl?.dataset.component ?? ""

    try {
      const err = new Error("debug-overlay-stack")
      const frames = parseStack(err.stack ?? "")
      const srcFrame = frames.find(
        (f) =>
          (f.file.includes("/src/") || f.file.includes("src/")) &&
          !f.file.includes("debug-overlay") &&
          !f.file.includes("node_modules"),
      )
      if (srcFrame) {
        lastFrame = srcFrame
        setState({
          file: shortenPath(srcFrame.file),
          line: srcFrame.line,
          col: srcFrame.col,
          name: srcFrame.name,
        })
        updateTooltip()
        return
      }
    } catch {
      // ignore
    }

    if (componentName) {
      setState({
        file: "",
        line: 0,
        col: 0,
        name: componentName,
      })
      updateTooltip()
    }
  }

  const updateTooltip = () => {
    if (!tooltipEl) return
    tooltipEl.style.left = `${Math.min(state.x + 16, window.innerWidth - 280)}px`
    tooltipEl.style.top = `${Math.min(state.y + 16, window.innerHeight - 60)}px`

    const nameEl = tooltipEl.querySelector('[data-attr="name"]')
    if (nameEl) nameEl.textContent = state.name || "component"

    const locEl = tooltipEl.querySelector('[data-attr="location"]')
    if (locEl) locEl.textContent = `${state.file}:${state.line}:${state.col}`

    const copyBtn = tooltipEl.querySelector('[data-attr="copy"]')
    if (copyBtn) copyBtn.textContent = state.copied ? "Copied!" : "Copy"
  }

  const onHover = (e: MouseEvent) => {
    if (!active() || !tooltipEl) return
    const target = e.target as Element | null
    if (target === lastTarget) return
    lastTarget = target
    refreshFrame(target)
    tooltipEl.style.display = "flex"
  }

  const onMouseMove = (e: MouseEvent) => {
    if (!active() || !tooltipEl) return
    setState({ x: e.clientX, y: e.clientY })
    tooltipEl.style.left = `${Math.min(e.clientX + 16, window.innerWidth - 280)}px`
    tooltipEl.style.top = `${Math.min(e.clientY + 16, window.innerHeight - 60)}px`
  }

  const onClick = async () => {
    if (!active() || !lastFrame) return
    const loc = `${lastFrame.file}:${lastFrame.line}:${lastFrame.col}`
    try {
      await navigator.clipboard.writeText(loc)
      setState("copied", true)
      if (copyTimer !== undefined) clearTimeout(copyTimer)
      copyTimer = window.setTimeout(() => setState("copied", false), 1500)
      updateTooltip()
    } catch {
      // fallback
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (!active()) return
    if (e.key === "Escape") {
      if (tooltipEl) tooltipEl.style.display = "none"
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "I" || e.key === "i")) {
      e.preventDefault()
      props.onToggle?.()
      return
    }
  }

  onMount(() => {
    makeEventListener(document, "mouseover", onHover)
    makeEventListener(document, "mousemove", onMouseMove)
    makeEventListener(document, "keydown", onKeyDown)

    // Create portal
    portalEl = document.createElement("div")
    portalEl.style.cssText = "position:fixed;inset:0;z-index:99999;pointer-events:none"
    document.body.appendChild(portalEl)

    // Create tooltip element directly
    tooltipEl = document.createElement("div")
    tooltipEl.style.cssText = `
      position: fixed;
      z-index: 100000;
      pointer-events: auto;
      display: none;
      border-radius: 6px;
      border: 1px solid var(--border-base, #333);
      background: var(--surface-raised-stronger-non-alpha, #1a1a1a);
      padding: 8px 12px;
      font-family: monospace;
      font-size: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      color: var(--text-strong, #fff);
      flex-direction: column;
      gap: 4px;
    `
    tooltipEl.innerHTML = `
      <div data-attr="name" style="color:var(--text-muted,#999)"></div>
      <div data-attr="location" style="display:flex;align-items:center;gap:8px">
        <span></span>
        <button data-attr="copy" style="margin-left:auto;padding:2px 8px;border-radius:4px;background:var(--surface-raised-base,#2a2a2a);border:1px solid var(--border-base,#333);color:var(--text-strong,#fff);font-size:10px;text-transform:uppercase;cursor:pointer">Copy</button>
      </div>
    `
    portalEl.appendChild(tooltipEl)

    const copyBtn = tooltipEl.querySelector('[data-attr="copy"]')
    copyBtn?.addEventListener("click", (e) => {
      e.stopPropagation()
      void onClick()
    })
  })

  onCleanup(() => {
    if (copyTimer !== undefined) clearTimeout(copyTimer)
    if (portalEl) {
      portalEl.remove()
      portalEl = undefined
      tooltipEl = undefined
    }
  })

  createEffect(() => {
    if (!active() && tooltipEl) {
      tooltipEl.style.display = "none"
    }
  })

  return null
}