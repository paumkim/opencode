import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { mutateRemote } from "../util/mutate-remote"

interface DialogSessionRenameProps {
  session: string
}

/**
 * Renames a session, reporting a refusal and leaving the decision to close to
 * the caller.
 *
 * Extracted from the dialog the way `loadDialogSessionList` was: the interesting
 * behaviour is what happens when the server says no, and that should be
 * testable without a textarea renderable.
 */
export async function renameSession(input: {
  update: (title: string) => Promise<{ data?: unknown; error?: unknown }>
  title: string
  report: (reason: string) => void
}): Promise<boolean> {
  // `session.update` can answer 400, 404 or 500, and the client resolves those
  // as `{data: undefined, error}` rather than rejecting. Closing regardless
  // would leave the list showing the old name with nothing said, and the dialog
  // holds the only copy of the name just typed — so a refusal keeps it open.
  return mutateRemote(() => input.update(input.title), input.report)
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const session = createMemo(() => sync.session.get(props.session))

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.title}
      onConfirm={async (value) => {
        const renamed = await renameSession({
          update: (title) => sdk.client.session.update({ sessionID: props.session, title }),
          title: value,
          report: (reason) => toast.show({ variant: "error", title: "Could not rename session", message: reason }),
        })
        if (!renamed) return
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
