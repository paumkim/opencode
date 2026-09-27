import path from "path"

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"

// These two are read at call time from the ambient environment and would otherwise decide
// what the suite reports. OPENCODE_UNRESTRICTED="1" makes `PermissionV2.ask`/`assert`
// (packages/core/src/permission.ts) bypass every rule, so the permission tests that assert
// "deny", "ask", and a queued pending request all see "allow" instead and fail. OPENCODE_API_KEY
// is treated by `packages/core/src/plugin/provider/opencode.ts` as "a key is configured",
// which leaves the real key in place and paid models enabled rather than pinning the provider
// to "public". Both are commonly exported from a developer shell, so without this a developer
// running with them set sees 10 unrelated failures. No test sets either itself, so removing
// them here only removes the ambient value. The key is deleted rather than captured so it is
// never retained, let alone printed.
delete process.env.OPENCODE_UNRESTRICTED
delete process.env.OPENCODE_API_KEY
