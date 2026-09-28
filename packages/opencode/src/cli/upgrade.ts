import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { describeUpgradeFailure, Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (InstallationVersion === latest) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch((error) => reportUpgradeFailure(method, latest, error))
}

/**
 * An auto-upgrade runs unattended on startup, so its failure was previously
 * discarded by a bare `.catch(() => {})`. Nothing reached the user, the
 * `Updated` event never fired, and the next launch tried the whole thing again
 * as though it had never been attempted — which is how a permission error from
 * an installer package manager, or a full disk, persisted indefinitely with no
 * trace anywhere.
 *
 * `Installation.upgrade` logs its own success, so the failure was the only
 * outcome it never recorded. The manual `opencode upgrade` command already
 * reported this correctly; this is the unattended equivalent.
 */
async function reportUpgradeFailure(method: Installation.Method, target: string, error: unknown) {
  try {
    await AppRuntime.runPromise(
      Effect.logError("auto-upgrade failed", {
        method,
        target,
        // `UpgradeFailedError.message` is overridden to return the installer
        // command's own stderr, so the real reason survives here rather than a
        // generic "upgrade failed" that reads the same for every cause.
        reason: describeUpgradeFailure(error),
      }),
    )
  } catch {
    // Logging must not take the process down on the failure path.
  }
}
