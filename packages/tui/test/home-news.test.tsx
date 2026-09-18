/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { HomeNews, loadHomeNews, type HomeRelease } from "../src/routes/home/news"

test("GET /news reuses SDK authentication, directory rewriting and custom fetch", async () => {
  const requests: Request[] = []
  const client = createOpencodeClient({
    baseUrl: "http://news.test",
    directory: "/tmp/project with spaces",
    headers: { Authorization: "Basic test-credentials" },
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        return Response.json(releases)
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const result = await loadHomeNews(client, new AbortController().signal)
  expect(result).toEqual(releases)
  expect(requests).toHaveLength(1)
  expect(requests[0].method).toBe("GET")
  expect(new URL(requests[0].url).pathname).toBe("/news")
  expect(new URL(requests[0].url).searchParams.get("directory")).toBe("/tmp/project with spaces")
  expect(requests[0].headers.get("authorization")).toBe("Basic test-credentials")
})

for (const status of [401, 404, 503]) {
  test(`news SDK request rejects HTTP ${status}`, async () => {
    const client = createOpencodeClient({
      baseUrl: "http://news.test",
      fetch: Object.assign(async () => Response.json({ message: "Unavailable" }, { status }), {
        preconnect: fetch.preconnect,
      }),
    })
    await expect(loadHomeNews(client, new AbortController().signal)).rejects.toBeDefined()
  })
}

test("news SDK request rejects invalid response shape", async () => {
  const client = createOpencodeClient({
    baseUrl: "http://news.test",
    fetch: Object.assign(async () => Response.json({ items: [] }), { preconnect: fetch.preconnect }),
  })
  await expect(loadHomeNews(client, new AbortController().signal)).rejects.toThrow("Invalid news response")
})

for (const state of ["empty", "offline"] as const) {
  test(`Home news renders ${state} without a blocking error`, async () => {
    const app = await testRender(
      () => (
        <HomeNews
          load={async () => {
            if (state === "offline") throw new Error("offline")
            return []
          }}
          color="#888888"
          maxWidth={75}
        />
      ),
      { width: 80, height: 30 },
    )
    try {
      await Bun.sleep(30)
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain(
        state === "empty" ? "No recent model releases" : "Release news unavailable",
      )
    } finally {
      app.renderer.destroy()
    }
  })
}

test("Home news renders loading and aborts pending work when unmounted", async () => {
  let signal: AbortSignal | undefined
  let finish: ((items: readonly HomeRelease[]) => void) | undefined
  const app = await testRender(
    () => (
      <HomeNews
        load={(value) => {
          signal = value
          return new Promise((resolve) => {
            finish = resolve
          })
        }}
        color="#888888"
        maxWidth={75}
      />
    ),
    { width: 80, height: 30 },
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Loading releases")
    expect(signal?.aborted).toBe(false)
  } finally {
    app.renderer.destroy()
  }
  expect(signal?.aborted).toBe(true)
  finish?.(releases)
  await Bun.sleep(10)
})

for (const [width, height, count] of [
  [80, 24, 1],
  [80, 27, 2],
  [80, 40, 3],
  [35, 40, 0],
  [80, 20, 0],
]) {
  test(`Home news limits rows to ${count} at ${width}x${height}`, async () => {
    const data = Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      title: `Release-${index}`,
      provider: "Provider",
      model: String(index),
      releaseDate: "2026-09-17",
    }))
    const app = await testRender(() => <HomeNews load={async () => data} color="#888888" maxWidth={75} />, {
      width,
      height,
    })
    try {
      await Bun.sleep(30)
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame.match(/Release-\d/g) ?? []).toHaveLength(count)
      if (count) expect(frame).toContain("Release-0")
      if (!count) expect(frame).not.toContain("Model releases")
    } finally {
      app.renderer.destroy()
    }
  })
}

const releases = [
  {
    id: "new",
    title: "A very long model release name ".repeat(10),
    provider: "Provider",
    model: "new",
    releaseDate: "2026-09-17",
  },
  { id: "older", title: "Older model", provider: "Other", model: "older", releaseDate: "2026-09-16" },
]

test("Home news keeps long release titles inside a narrow viewport without taking focus", async () => {
  const app = await testRender(
    () => (
      <box width="100%" paddingLeft={2} paddingRight={2}>
        <input id="news-test-prompt" focused value="prompt" />
        <HomeNews load={async () => releases} color="#888888" maxWidth={75} />
      </box>
    ),
    { width: 42, height: 28 },
  )
  try {
    await Bun.sleep(30)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Model releases")
    expect(frame).toContain("2026-09-17")
    expect(frame).toContain("Provider")
    expect(frame).not.toContain("Older model")
    expect(frame.split("\n").every((line) => line.length <= 42)).toBe(true)
    expect(app.renderer.currentFocusedRenderable?.id).toBe("news-test-prompt")
    expect(frame).toContain("prompt")
  } finally {
    app.renderer.destroy()
  }
})
