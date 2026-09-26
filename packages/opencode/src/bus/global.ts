import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()

// Every open SSE / WS client, plus the web and TUI frontends, attach a listener
// here, so the default cap of 10 is routinely exceeded during normal use. The
// warning it prints is pure noise, and each emit fans out synchronously to every
// subscriber, so there is no correctness reason to cap the count.
GlobalBus.setMaxListeners(0)
