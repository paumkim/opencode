/**
 * Model Loader - VRAM-aware model recommendations for 6GB GPU
 * Downloads and manages GGUF models
 */

import { spawn } from "child_process";
import { writeFile, readFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import type { ModelSpec } from "../core/types.js";

/**
 * Curated models for 6GB VRAM
 */
export const RECOMMENDED_MODELS: ModelSpec[] = [
  // Tier 1: Best quality (7B Q3_K_M ~4.1-4.7GB VRAM)
  {
    name: "qwen2.5-7b-instruct-q3_k_m",
    hfRepo: "Qwen/Qwen2.5-7B-Instruct-GGUF",
    filename: "qwen2.5-7b-instruct-q3_k_m.gguf",
    sizeGb: 4.1,
    vramGb: 4.5,
    qualityTier: 1,
    tags: ["reasoning", "structured", "128k-ctx"],
  },
  {
    name: "llama-3.1-8b-instruct-q3_k_m",
    hfRepo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
    filename: "Meta-Llama-3.1-8B-Instruct-Q3_K_M.gguf",
    sizeGb: 4.7,
    vramGb: 5.2,
    qualityTier: 1,
    tags: ["reasoning", "general"],
  },
  {
    name: "nemotron-3-ultra-8b-q3_k_m",
    hfRepo: "NVIDIA/Nemotron-3-Ultra-8B-GGUF",
    filename: "Nemotron-3-Ultra-8B-Q3_K_M.gguf",
    sizeGb: 4.7,
    vramGb: 5.2,
    qualityTier: 1,
    tags: ["reasoning", "instruction-following"],
  },

  // Tier 2: Comfortable (3B Q4_K_M ~2.4-2.8GB VRAM)
  {
    name: "qwen2.5-3b-instruct-q4_k_m",
    hfRepo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
    filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
    sizeGb: 2.4,
    vramGb: 2.8,
    qualityTier: 2,
    tags: ["reasoning", "structured", "fast", "32k-ctx"],
  },
  {
    name: "phi-3.5-mini-instruct-q4_k_m",
    hfRepo: "microsoft/Phi-3.5-mini-instruct-GGUF",
    filename: "phi-3.5-mini-instruct-q4_k_m.gguf",
    sizeGb: 2.8,
    vramGb: 3.2,
    qualityTier: 2,
    tags: ["reasoning", "compact"],
  },
  {
    name: "gemma-2-2b-it-q4_k_m",
    hfRepo: "google/gemma-2-2b-it-GGUF",
    filename: "gemma-2-2b-it-q4_k_m.gguf",
    sizeGb: 1.6,
    vramGb: 2.0,
    qualityTier: 2,
    tags: ["fast", "efficient"],
  },

  // Tier 3: Code-specialized
  {
    name: "codeqwen-1.5b-chat-q4_k_m",
    hfRepo: "Qwen/CodeQwen1.5-Chat-GGUF",
    filename: "codeqwen1.5-chat-q4_k_m.gguf",
    sizeGb: 1.3,
    vramGb: 1.7,
    qualityTier: 3,
    tags: ["code", "structured", "fast"],
  },
  {
    name: "stable-code-3b-q4_k_m",
    hfRepo: "stabilityai/stable-code-3b-GGUF",
    filename: "stable-code-3b-q4_k_m.gguf",
    sizeGb: 2.4,
    vramGb: 2.8,
    qualityTier: 3,
    tags: ["code", "completion"],
  },
];

/**
 * Get GPU VRAM in GB using nvidia-smi
 */
export async function getGpuVram(): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("nvidia-smi", [
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits",
    ]);

    let stdout = "";
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.on("close", (code) => {
      if (code === 0) {
        const vramMb = parseInt(stdout.trim().split("\n")[0], 10);
        resolve(vramMb / 1024);
      } else {
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}

/**
 * Recommend models that fit in given VRAM
 */
export function recommendModels(vramGb: number = 6.0, maxTier: 1 | 2 | 3 = 1): ModelSpec[] {
  // Leave 1GB headroom for OS/other
  const available = vramGb - 1.0;

  return RECOMMENDED_MODELS
    .filter(m => m.vramGb <= available && m.qualityTier <= maxTier)
    .sort((a, b) => a.qualityTier - b.qualityTier || b.vramGb - a.vramGb);
}

/**
 * Download model using huggingface-cli
 */
export async function downloadModel(spec: ModelSpec, destDir: string): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const destPath = join(destDir, spec.filename);

  // Check if already exists
  try {
    await readFile(destPath);
    console.log(`Already exists: ${destPath}`);
    return destPath;
  } catch {
    // Not found, continue to download
  }

  console.log(`Downloading ${spec.name} (${spec.sizeGb.toFixed(1)}GB)...`);

  return new Promise((resolve, reject) => {
    const child = spawn("huggingface-cli", [
      "download", spec.hfRepo, spec.filename,
      "--local-dir", destDir,
    ]);

    child.stdout?.on("data", (data) => process.stdout.write(data));
    child.stderr?.on("data", (data) => process.stderr.write(data));

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`\nDownloaded to ${destPath}`);
        resolve(destPath);
      } else {
        reject(new Error(`Download failed with code ${code}`));
      }
    });

    child.on("error", (err) => reject(err));
  });
}

/**
 * List local GGUF models
 */
export async function listLocalModels(modelsDir: string): Promise<string[]> {
  try {
    const files = await readdir(modelsDir);
    return files.filter(f => f.endsWith(".gguf")).sort();
  } catch {
    return [];
  }
}

/**
 * Get model info using llama.cpp
 */
export async function getModelInfo(modelPath: string, llamaCli = "llama-cli"): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    const child = spawn(llamaCli, ["-m", modelPath, "--version"]);
    let stdout = "";
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.on("close", () => {
      resolve({ path: modelPath, info: stdout.trim() });
    });
    child.on("error", (err) => {
      resolve({ path: modelPath, error: err.message });
    });
  });
}

/**
 * Auto-detect best model for current hardware
 */
export async function autoSelectModel(
  modelsDir: string,
  preferredTier: 1 | 2 | 3 = 1
): Promise<ModelSpec | null> {
  const vram = await getGpuVram() ?? 6.0;
  console.log(`Detected GPU VRAM: ${vram.toFixed(1)}GB`);

  const recommended = recommendModels(vram, preferredTier);
  if (recommended.length === 0) {
    console.log("No models fit in available VRAM");
    return null;
  }

  const best = recommended[0];
  console.log(`Recommended: ${best.name} (${best.vramGb.toFixed(1)}GB VRAM, tier ${best.qualityTier})`);

  // Check if already downloaded
  const local = await listLocalModels(modelsDir);
  if (local.includes(best.filename)) {
    console.log(`Already available locally`);
    return best;
  }

  return best;
}

/**
 * CLI for model management
 */
export async function modelCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;

  switch (command) {
    case "list": {
      const vram = await getGpuVram() ?? 6.0;
      console.log(`GPU VRAM: ${vram.toFixed(1)}GB\n`);

      for (const tier of [1, 2, 3] as const) {
        const models = recommendModels(vram, tier);
        console.log(`Tier ${tier} (fits in ${vram - 1}GB):`);
        for (const m of models) {
          const fit = m.vramGb <= vram - 1 ? "✅" : "🟡";
          console.log(`  ${fit} ${m.name} - ${m.vramGb.toFixed(1)}GB VRAM, ${m.sizeGb.toFixed(1)}GB disk - ${m.tags.join(", ")}`);
        }
        console.log("");
      }
      break;
    }

    case "download": {
      const name = rest[0];
      const modelsDir = rest[1] ?? "./models";
      const spec = RECOMMENDED_MODELS.find(m => m.name === name);
      if (!spec) {
        console.error(`Unknown model: ${name}`);
        process.exit(1);
      }
      await downloadModel(spec, modelsDir);
      break;
    }

    case "local": {
      const modelsDir = rest[0] ?? "./models";
      const local = await listLocalModels(modelsDir);
      console.log(`Local models in ${modelsDir}:`);
      for (const f of local) {
        console.log(`  ${f}`);
      }
      break;
    }

    case "auto": {
      const modelsDir = rest[0] ?? "./models";
      const tier = (parseInt(rest[1]) as 1 | 2 | 3) || 1;
      const selected = await autoSelectModel(modelsDir, tier);
      if (selected) {
        await downloadModel(selected, modelsDir);
      }
      break;
    }

    default:
      console.log(`
Usage:
  system-one-model list                    # List recommended models for current GPU
  system-one-model download <name> [dir]   # Download a model
  system-one-model local [dir]             # List local models
  system-one-model auto [dir] [tier]       # Auto-select and download best model
      `);
  }
}