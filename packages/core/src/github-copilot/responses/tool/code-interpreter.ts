import { z } from "zod/v4"

export const codeInterpreterInputSchema = z.object({
  code: z.string().nullish(),
  containerId: z.string(),
})

export const codeInterpreterOutputSchema = z.object({
  outputs: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("logs"), logs: z.string() }),
        z.object({ type: z.literal("image"), url: z.string() }),
      ]),
    )
    .nullish(),
})

export const codeInterpreterArgsSchema = z.object({
  container: z
    .union([
      z.string(),
      z.object({
        fileIds: z.array(z.string()).optional(),
      }),
    ])
    .optional(),
})

type CodeInterpreterArgs = {
  /**
   * The code interpreter container.
   * Can be a container ID
   * or an object that specifies uploaded file IDs to make available to your code.
   */
  container?: string | { fileIds?: string[] }
}
