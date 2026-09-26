import { describe, expect, test } from "bun:test"
import { EventEmitter } from "events"
import { GlobalBus } from "@/bus/global"

type Warning = { name: string; message: string }

// process.emitWarning delivers on a later tick, so every capture gives the
// runtime a chance to flush the warning before asserting on it.
const collectWarnings = async (body: () => void | Promise<void>) => {
  const seen: Warning[] = []
  const onWarning = (warning: { name?: string; message?: string }) => {
    seen.push({ name: warning.name ?? "", message: warning.message ?? "" })
  }
  process.on("warning", onWarning)
  try {
    await body()
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    process.off("warning", onWarning)
  }
  return seen
}

const isListenerWarning = (warning: Warning) => warning.name === "MaxListenersExceededWarning"

describe("GlobalBus", () => {
  test("has no listener cap", () => {
    expect(GlobalBus.getMaxListeners()).toBe(0)
  })

  test("attaching 50 listeners emits no MaxListenersExceededWarning", async () => {
    // Control: a plain emitter with the default cap does warn, so a silent
    // assertion here means the cap was lifted rather than the warning not firing.
    const control = new EventEmitter()
    const controlWarnings = await collectWarnings(() => {
      for (let i = 0; i < 50; i++) control.on("event", () => {})
      control.emit("event")
    })
    expect(controlWarnings.filter(isListenerWarning).length).toBe(1)

    const before = GlobalBus.listenerCount("event")
    const listeners = Array.from({ length: 50 }, () => () => {})
    const warnings = await collectWarnings(() => {
      for (const listener of listeners) GlobalBus.on("event", listener)
      expect(GlobalBus.listenerCount("event")).toBe(before + 50)
      for (const listener of listeners) GlobalBus.off("event", listener)
    })

    expect(GlobalBus.listenerCount("event")).toBe(before)
    expect(warnings.filter(isListenerWarning)).toEqual([])
  })

  test("still fans an event out to every listener after the cap is lifted", async () => {
    const before = GlobalBus.listenerCount("event")
    const seen: number[] = []
    const listeners = Array.from({ length: 50 }, (_, i) => () => seen.push(i))
    const warnings = await collectWarnings(() => {
      for (const listener of listeners) GlobalBus.on("event", listener)
      GlobalBus.emit("event", { payload: { type: "test.fanout", properties: {} } })
      for (const listener of listeners) GlobalBus.off("event", listener)
    })

    expect(GlobalBus.listenerCount("event")).toBe(before)
    expect(seen.length).toBe(50)
    expect(warnings.filter(isListenerWarning)).toEqual([])
  })
})
