import { Schema } from "effect"

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "InvalidRequestError",
  {
    message: Schema.String,
    kind: Schema.optional(Schema.String),
    field: Schema.optional(Schema.String),
  },
  { httpApiStatus: 400 },
) {}

export class SessionBusyError extends Schema.TaggedErrorClass<SessionBusyError>()(
  "SessionBusyError",
  {
    sessionID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export class QuestionNotFoundError extends Schema.TaggedErrorClass<QuestionNotFoundError>()(
  "QuestionNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class PermissionNotFoundError extends Schema.TaggedErrorClass<PermissionNotFoundError>()(
  "PermissionNotFoundError",
  {
    requestID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class McpServerNotFoundError extends Schema.TaggedErrorClass<McpServerNotFoundError>()(
  "McpServerNotFoundError",
  {
    name: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class PtyNotFoundError extends Schema.TaggedErrorClass<PtyNotFoundError>()(
  "PtyNotFoundError",
  {
    ptyID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class PtyForbiddenError extends Schema.TaggedErrorClass<PtyForbiddenError>()(
  "PtyForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export class ProjectNotFoundError extends Schema.TaggedErrorClass<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    projectID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class ApiNotFoundError extends Schema.ErrorClass<ApiNotFoundError>("NotFoundError")(
  {
    name: Schema.Literal("NotFoundError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export function notFound(message: string) {
  return new ApiNotFoundError({
    name: "NotFoundError",
    data: { message },
  })
}

/**
 * The instance backing a request could not be loaded.
 *
 * Every endpoint that reads through `InstanceContextMiddleware` needs a live
 * instance first: config resolution, provider bundles, plugin hooks and the
 * project row all come from it. When that load fails — an unreadable directory,
 * a database that will not answer, a plugin that throws during bootstrap — the
 * endpoint has no result to return, and previously produced a bare undeclared
 * 500. A client had no way to tell that apart from a server fault it could
 * retry, and the OpenAPI document claimed no such response existed.
 */
export class ApiInstanceLoadError extends Schema.ErrorClass<ApiInstanceLoadError>("InstanceLoadError")(
  {
    name: Schema.Literal("InstanceLoadError"),
    data: Schema.Struct({
      message: Schema.String,
      directory: Schema.String,
    }),
  },
  { httpApiStatus: 500 },
) {}
