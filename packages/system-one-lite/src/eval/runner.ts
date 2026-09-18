/**
 * Batch Evaluation Runner CLI
 * Run workflow evaluations and compare against reference
 */

import { program } from "commander";
import { LlamaCppGenerator, createGenerator } from "../core/generator.js";
import {
  WorkflowRunner,
  computeMetrics,
  loadContexts,
  saveResults,
  ISSUE_TRIAGE_WORKFLOW,
  CODE_REVIEW_WORKFLOW,
  RELEASE_READINESS_WORKFLOW,
} from "../eval/workflow.js";

const WORKFLOWS = {
  issue_triage: ISSUE_TRIAGE_WORKFLOW,
  code_review: CODE_REVIEW_WORKFLOW,
  release_readiness: RELEASE_READINESS_WORKFLOW,
} as const;

program
  .name("system-one-eval")
  .description("Run workflow evaluations for System One Lite")
  .version("0.1.0");

program
  .command("run")
  .description("Run evaluation on a workflow")
  .requiredOption("-w, --workflow <name>", "Workflow to run", Object.keys(WORKFLOWS))
  .requiredOption("-c, --contexts <path>", "Path to contexts JSONL file")
  .requiredOption("-m, --model <path>", "Path to GGUF model")
  .option("-r, --reference <path>", "Reference model path for comparison")
  .option("-o, --output <path>", "Output results JSONL")
  .option("-l, --limit <number>", "Limit number of contexts", "100")
  .option("--ctx-size <number>", "Context size", "4096")
  .option("--ngl <number>", "GPU layers to offload", "999")
  .option("--temp <number>", "Temperature", "0.0")
  .option("--concurrency <number>", "Parallel contexts", "2")
  .action(async (options) => {
    const workflow = WORKFLOWS[options.workflow as keyof typeof WORKFLOWS];
    if (!workflow) {
      console.error(`Unknown workflow: ${options.workflow}`);
      process.exit(1);
    }

    console.log(`Loading workflow: ${workflow.name} (${workflow.steps.length} steps)`);

    const contexts = await loadContexts(options.contexts);
    const limitedContexts = contexts.slice(0, parseInt(options.limit));
    console.log(`Loaded ${limitedContexts.length} contexts`);

    // Create generator
    const generator = createGenerator(options.model, {
      ctxSize: parseInt(options.ctxSize),
      ngl: parseInt(options.ngl),
      temperature: parseFloat(options.temp),
    });

    let referenceGenerator: LlamaCppGenerator | undefined;
    if (options.reference) {
      referenceGenerator = createGenerator(options.reference, {
        ctxSize: parseInt(options.ctxSize),
        ngl: parseInt(options.ngl),
        temperature: parseFloat(options.temp),
      });
    }

    const runner = new WorkflowRunner(generator, referenceGenerator);

    console.log(`\nRunning evaluation...`);
    const start = performance.now();

    let results: Awaited<ReturnType<typeof runner.runBatch>>;
    let referenceResults: Awaited<ReturnType<typeof runner.runBatch>> | undefined;

    if (referenceGenerator) {
      const { results: r, referenceResults: rr } = await runner.runWithReference(workflow, limitedContexts);
      results = r;
      referenceResults = rr;
    } else {
      results = await runner.runBatch(workflow, limitedContexts, parseInt(options.concurrency));
    }

    const elapsed = performance.now() - start;
    console.log(`Completed in ${(elapsed / 1000).toFixed(1)}s (${(elapsed / limitedContexts.length).toFixed(1)}ms per context)`);

    // Compute metrics
    const metrics = computeMetrics(workflow.name, results, referenceResults);

    console.log(`\nMetrics:`);
    console.log(`  Success rate: ${(metrics.successRate * 100).toFixed(1)}%`);
    console.log(`  Avg latency: ${metrics.avgLatencyMs.toFixed(1)}ms`);
    console.log(`  Avg tokens: ${metrics.avgTokens.toFixed(0)}`);
    if (metrics.agreementRate !== undefined) {
      console.log(`  Agreement with reference: ${(metrics.agreementRate * 100).toFixed(1)}%`);
    }

    // Save results
    if (options.output) {
      await saveResults(results, options.output);
      console.log(`\nResults saved to ${options.output}`);
    }

    // Print sample results
    console.log(`\nSample results:`);
    for (const r of results.slice(0, 3)) {
      console.log(`  ${r.success ? "✅" : "❌"} ${r.totalLatencyMs.toFixed(0)}ms`);
      for (const [step, result] of Object.entries(r.stepResults)) {
        console.log(`    ${step}: ${JSON.stringify(result)}`);
      }
    }
  });

program
  .command("list-workflows")
  .description("List available workflows")
  .action(() => {
    console.log("Available workflows:");
    for (const [name, wf] of Object.entries(WORKFLOWS)) {
      console.log(`  ${name}: ${wf.description} (${wf.steps.length} steps)`);
    }
  });

program.parse();