import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"

export const SharedPaths = {
  ws: "/ws",
} as const

export const SharedApi = HttpApi.make("shared").add(
  HttpApiGroup.make("shared")
    .add(
      HttpApiEndpoint.get("ws", SharedPaths.ws, {
        success: undefined,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "shared.ws",
          summary: "Shared workspace WebSocket",
          description: "WebSocket endpoint for multi-client shared workspace sessions",
        }),
      ),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({ title: "shared", description: "Shared workspace WebSocket route." })),
)
