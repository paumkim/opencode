import type {
  AgentSideConnection,
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import { applyPatch } from "diff"
import { errorMessage } from "@/util/error"
import { exists, readText } from "@/util/filesystem"
import type { ACPSession } from "./session"
import { pendingToolCall, toLocations, type ToolInput } from "./tool"
import { Effect } from "effect"

type PermissionEvent = Extract<Event, { type: "permission.asked" }>
type Reply = "once" | "always" | "reject"
type Connection = Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>

const permissionOptions: PermissionOption[] = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]

export class Handler {
  private readonly queues = new Map<string, Promise<void>>()
  private readonly report: (message: string) => void

  constructor(
    private readonly input: {
      sdk: OpencodeClient
      connection: Connection
      session: ACPSession.Interface
    },
    options?: { report?: (message: string) => void },
  ) {
    this.report = options?.report ?? ((message) => console.error(message))
  }

  handle(event: PermissionEvent) {
    const permission = event.properties
    const previous = this.queues.get(permission.sessionID) ?? Promise.resolve()
    const next = previous
      .then(() => this.process(event))
      // This used to be `.catch(() => {})`, and a permission that is never answered is the worst
      // failure in this class: not rejected, not approved, never answered. The agent stays blocked
      // on the tool for the rest of the turn, the client's dialog never resolves, and nothing says
      // why. Almost every throw inside `process` happens in `reply`, which is the one call the
      // agent is blocked on.
      .catch((error) => {
        this.report(
          `[acp] failed to deliver permission request ${permission.id} (${permission.permission}) to the agent: ${errorMessage(error)}`,
        )
      })
      .finally(() => {
        if (this.queues.get(permission.sessionID) === next) {
          this.queues.delete(permission.sessionID)
        }
      })
    this.queues.set(permission.sessionID, next)
  }

  private async process(event: PermissionEvent) {
    const permission = event.properties
    const session = await Effect.runPromise(this.input.session.tryGet(permission.sessionID))
    if (!session) return

    if (!this.input.connection.requestPermission) {
      await this.reply(permission.id, permission.sessionID, "reject", session.cwd)
      return
    }

    if (process.env.OPENCODE_UNRESTRICTED === "1") {
      await this.reply(permission.id, permission.sessionID, "always", session.cwd)
      return
    }

    const result = await this.input.connection
      .requestPermission({
        sessionId: permission.sessionID,
        toolCall: await permissionToolCall({
          toolCallId: permission.tool?.callID ?? permission.id,
          toolName: permission.permission,
          input: permission.metadata,
        }),
        options: permissionOptions,
      })
      .catch(async () => {
        await this.reply(permission.id, permission.sessionID, "reject", session.cwd)
        return undefined
      })

    if (!result) return

    const reply = selectedReply(result)
    if (reply !== "once" && reply !== "always") {
      await this.reply(permission.id, permission.sessionID, "reject", session.cwd)
      return
    }

    if (permission.permission === "edit") {
      // Not `.catch(() => {})` any more. Writing the proposed edit is how the user sees the diff they
      // are approving, so a failure here means the approval goes ahead for content nobody was shown.
      // The failure propagates to `handle`, which reports it against this permission.
      await this.writeProposedEdit(session.id, permission.metadata)
    }

      await this.reply(permission.id, permission.sessionID, reply, session.cwd)
  }

  private async reply(requestID: string, sessionID: string, reply: Reply, directory: string) {
    await this.input.sdk.permission.reply({
      requestID,
      sessionID,
      reply,
      directory,
    })
  }

  private async writeProposedEdit(sessionId: string, metadata: ToolInput) {
    const filepath = stringValue(metadata.filepath)
    const diff = stringValue(metadata.diff)
    if (!filepath || !diff || !this.input.connection.writeTextFile) return

    const content = (await exists(filepath)) ? await readText(filepath) : ""
    const next = applyPatch(content, diff)
    if (next === false) {
      // Returning quietly here sent the reply out as if the user had reviewed something. They
      // approved a diff that was neither shown nor written, and the agent proceeded to make the
      // edit on its own. There is nothing to write, so this is a failure of the proposal, not a
      // reason to let the approval through unexamined.
      throw new Error(`the proposed edit to ${filepath} does not apply to the file's current contents`)
    }

    // Awaited, not `void`. A floating promise here means a client that refuses the write produces
    // an unhandled rejection, and the user has approved an edit that is never applied to their
    // buffer - the one file this call exists to keep in step with what they reviewed.
    await this.input.connection.writeTextFile({
      sessionId,
      path: filepath,
      content: next,
    })
  }
}

async function permissionToolCall(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: ToolInput
}): Promise<ToolCallUpdate> {
  const toolCall = pendingToolCall({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    state: {
      input: input.input,
      title: permissionTitle(input.toolName, input.input),
    },
  })
  const content = await permissionContent(input.toolName, input.input)
  return {
    ...toolCall,
    locations: permissionLocations(input.toolName, input.input),
    ...(content.length ? { content } : {}),
  }
}

function permissionTitle(toolName: string, input: ToolInput) {
  const tool = toolName.toLocaleLowerCase()
  switch (tool) {
    case "external_directory":
      return stringValue(input.description) ?? stringValue(input.command) ?? stringValue(input.parentDir)

    case "webfetch":
      return stringValue(input.url)

    case "websearch":
      return stringValue(input.query)

    case "grep":
    case "glob":
      return stringValue(input.pattern)

    case "read":
    case "edit":
    case "write":
      return editTitle(input)

    default:
      return undefined
  }
}

function editTitle(input: ToolInput) {
  const files = fileMetadata(input)
  if (files.length === 1) return files[0]?.relativePath ?? files[0]?.filePath
  if (files.length > 1) return `${files.length} files`
  return stringValue(input.filePath) ?? stringValue(input.filepath) ?? stringValue(input.path)
}

function permissionLocations(toolName: string, input: ToolInput): ToolCallLocation[] {
  const files = fileMetadata(input)
  if (files.length) {
    return Array.from(
      new Set(files.flatMap((file) => [file.filePath, file.movePath].filter((path): path is string => !!path))),
      (path) => ({ path }),
    )
  }
  return toLocations(toolName, input)
}

async function permissionContent(toolName: string, input: ToolInput): Promise<ToolCallContent[]> {
  if (toolName.toLocaleLowerCase() !== "edit") return []

  const files = fileMetadata(input)
  if (files.length) return diffContentForFiles(files)

  const filepath = stringValue(input.filepath) ?? stringValue(input.filePath)
  const diff = stringValue(input.diff)
  if (!filepath || !diff) return []
  const content = await diffContentForPatch(filepath, diff)
  return content ? [content] : []
}

async function diffContentForFiles(files: PermissionFileMetadata[]) {
  const content = await Promise.all(
    files.map(async (file) => {
      if (!file.patch) return []
      const content = await diffContentForPatch(file.filePath, file.patch, file.movePath)
      return content ? [content] : []
    }),
  )
  return content.flat()
}

async function diffContentForPatch(filepath: string, diff: string, displayPath = filepath) {
  const content = (await exists(filepath)) ? await readText(filepath) : ""
  const next = applyPatch(content, diff)
  if (next === false) return undefined
  return {
    type: "diff" as const,
    path: displayPath,
    oldText: content,
    newText: next,
  }
}

function selectedReply(result: RequestPermissionResponse): Reply {
  if (result.outcome.outcome !== "selected") return "reject"
  if (result.outcome.optionId === "once" || result.outcome.optionId === "always") return result.outcome.optionId
  return "reject"
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

type PermissionFileMetadata = {
  readonly filePath: string
  readonly relativePath?: string
  readonly movePath?: string
  readonly patch?: string
}

function fileMetadata(input: ToolInput): PermissionFileMetadata[] {
  if (!Array.isArray(input.files)) return []
  return input.files.flatMap((file): PermissionFileMetadata[] => {
    if (!file || typeof file !== "object") return []
    const info = file as Record<string, unknown>
    const filePath = stringValue(info.filePath)
    if (!filePath) return []
    return [
      {
        filePath,
        relativePath: stringValue(info.relativePath),
        movePath: stringValue(info.movePath),
        patch: stringValue(info.patch),
      },
    ]
  })
}

export * as ACPPermission from "./permission"
