import { describe, expect, test } from "bun:test"
import { PtyProtocol } from "@opencode-ai/core/pty/protocol"

describe("pty protocol", () => {
  test("drops invalid binary input frames and decodes valid ones", () => {
    expect(PtyProtocol.decodeInput("ready")).toBe("ready")
    expect(PtyProtocol.decodeInput(new Uint8Array([0xff, 0xfe, 0xfd]))).toBeUndefined()
    expect(PtyProtocol.decodeInput(new TextEncoder().encode("hello"))).toBe("hello")
    expect(PtyProtocol.decodeInput(new TextEncoder().encode("hello").buffer)).toBe("hello")
  })

  test("encodes the cursor as a 0x00-prefixed JSON control frame", () => {
    const frame = PtyProtocol.metaFrame(42)
    expect(frame[0]).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(1)))).toEqual({ cursor: 42 })
  })

  test("splits replay into bounded frames", () => {
    expect(PtyProtocol.chunks("")).toEqual([])
    expect(PtyProtocol.chunks("abc")).toEqual(["abc"])
    const big = "x".repeat(PtyProtocol.REPLAY_CHUNK + 1)
    const frames = PtyProtocol.chunks(big)
    expect(frames.length).toBe(2)
    expect(frames[0].length).toBe(PtyProtocol.REPLAY_CHUNK)
    expect(frames.join("")).toBe(big)
  })

  // Every frame is UTF-8 encoded on its own before it hits the socket, so a lone
  // surrogate in a frame is unrecoverable. `frames.join("")` cannot catch this,
  // because joining reassembles the pair even when the wire bytes are corrupt.
  test("never splits a surrogate pair across frames", () => {
    const hasLoneSurrogate = (value: string) => {
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i)
        if (code < 0xd800 || code > 0xdfff) continue
        const next = value.charCodeAt(i + 1)
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) i++
        else return true
      }
      return false
    }
    const roundTrip = (value: string) => new TextDecoder().decode(new TextEncoder().encode(value))

    // Straddle the boundary: the pair starts one unit before it, exactly on it,
    // and one unit after it.
    for (const pad of [1, 0, -1]) {
      const data = "x".repeat(PtyProtocol.REPLAY_CHUNK - pad) + "😀tail"
      const frames = PtyProtocol.chunks(data)
      expect(frames.join("")).toBe(data)
      for (const frame of frames) {
        expect(hasLoneSurrogate(frame)).toBe(false)
        expect(roundTrip(frame)).toBe(frame)
        expect(frame.length).toBeLessThanOrEqual(PtyProtocol.REPLAY_CHUNK + 1)
      }
    }
  })
})
