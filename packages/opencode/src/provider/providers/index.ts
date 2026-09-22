import type { CustomDep, CustomLoader } from "../provider"
import { anthropic } from "./anthropic"
import { opencode } from "./opencode"
import { openai } from "./openai"
import { meta } from "./meta"
import { xai } from "./xai"
import { azure } from "./azure"
import { llmgateway } from "./llmgateway"
import { openrouter } from "./openrouter"
import { vercel } from "./vercel"
import { zenmux } from "./zenmux"
import { gitlab } from "./gitlab"
import { cerebras } from "./cerebras"
import { devin } from "./devin"
import { codeium } from "./codeium"
import { kilo } from "./kilo"
import { githubCopilot } from "./githubCopilot"
import { azureCognitiveServices } from "./azureCognitiveServices"
import { amazonBedrock } from "./amazonBedrock"
import { nvidia } from "./nvidia"
import { googleVertex } from "./googleVertex"
import { googleVertexAnthropic } from "./googleVertexAnthropic"
import { sapAiCore } from "./sapAiCore"
import { cloudflareWorkersAi } from "./cloudflareWorkersAi"
import { cloudflareAiGateway } from "./cloudflareAiGateway"
import { snowflakeCortex } from "./snowflakeCortex"

export function custom(dep: CustomDep): Record<string, CustomLoader> {
  return {
    anthropic: anthropic(dep),
    opencode: opencode(dep),
    openai: openai(dep),
    meta: meta(dep),
    xai: xai(dep),
    "github-copilot": githubCopilot(dep),
    azure: azure(dep),
    "azure-cognitive-services": azureCognitiveServices(dep),
    "amazon-bedrock": amazonBedrock(dep),
    llmgateway: llmgateway(dep),
    openrouter: openrouter(dep),
    nvidia: nvidia(dep),
    vercel: vercel(dep),
    "google-vertex": googleVertex(dep),
    "google-vertex-anthropic": googleVertexAnthropic(dep),
    "sap-ai-core": sapAiCore(dep),
    zenmux: zenmux(dep),
    gitlab: gitlab(dep),
    "cloudflare-workers-ai": cloudflareWorkersAi(dep),
    "cloudflare-ai-gateway": cloudflareAiGateway(dep),
    cerebras: cerebras(dep),
    devin: devin(dep),
    codeium: codeium(dep),
    kilo: kilo(dep),
    "snowflake-cortex": snowflakeCortex(dep),
  }
}

export { type CustomDep, type CustomLoader }
