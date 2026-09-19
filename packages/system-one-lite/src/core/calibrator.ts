/**
 * Confidence Calibration - Pure TypeScript implementation
 * Temperature scaling, Platt scaling, Isotonic regression
 * No Python/sklearn dependencies
 */

import type { CalibrationMethod, CalibrationPoint } from "./types.js";

/**
 * Calibration result
 */
export interface CalibrationResult {
  /** Calibrated probabilities */
  probabilities: number[];
  /** Method used */
  method: CalibrationMethod;
  /** Temperature (for temperature scaling) */
  temperature?: number;
}

/**
 * Temperature Scaling - Single scalar T > 0
 * Minimizes NLL on validation set
 */
export class TemperatureScaler {
  private temperature = 1.0;

  /**
   * Fit temperature on validation data
   * logits: (n_samples, n_classes) or (n_samples,) for binary
   * labels: class indices (0 to n_classes-1) or 0/1 for binary
   */
  fit(logits: number[][], labels: number[]): void {
    // Binary case: logits is 1D
    const isBinary = logits[0].length === 1 || !Array.isArray(logits[0]);

    const objective = (t: number): number => {
      let nll = 0;
      for (let i = 0; i < logits.length; i++) {
        const logit = isBinary ? (logits[i] as unknown as number) : logits[i][labels[i]];
        const scaled = logit / t;
        const prob = 1 / (1 + Math.exp(-scaled));
        nll -= Math.log(Math.max(prob, 1e-12));
      }
      return nll / logits.length;
    };

    // Grid search + refinement
    let bestT = 1.0;
    let bestNll = objective(1.0);

    // Coarse search
    for (const t of [0.1, 0.2, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0]) {
      const nll = objective(t);
      if (nll < bestNll) {
        bestNll = nll;
        bestT = t;
      }
    }

    // Fine search around best
    let step = 0.01;
    for (let i = 0; i < 20; i++) {
      for (const dt of [-step, 0, step]) {
        const t = Math.max(0.01, bestT + dt);
        const nll = objective(t);
        if (nll < bestNll) {
          bestNll = nll;
          bestT = t;
        }
      }
      step *= 0.5;
    }

    this.temperature = bestT;
  }

  /**
   * Calibrate logits to probabilities
   */
  calibrate(logits: number[][]): number[][] {
    return logits.map(row => {
      const scaled = row.map(v => v / this.temperature);
      const max = Math.max(...scaled);
      const exp = scaled.map(v => Math.exp(v - max));
      const sum = exp.reduce((a, b) => a + b, 0);
      return exp.map(v => v / sum);
    });
  }

  getTemperature(): number {
    return this.temperature;
  }

  toJSON(): { method: string; temperature: number } {
    return { method: "temperature", temperature: this.temperature };
  }

  static fromJSON(data: { temperature: number }): TemperatureScaler {
    const scaler = new TemperatureScaler();
    scaler.temperature = data.temperature;
    return scaler;
  }
}

/**
 * Platt Scaling - Logistic regression on logits
 * For binary classification
 */
export class PlattScaler {
  private weight = 0;
  private bias = 0;

  /**
   * Fit Platt scaling (logistic regression on single logit)
   * logits: 1D array of logits
   * labels: 0 or 1
   */
  fit(logits: number[], labels: number[]): void {
    // Simple gradient descent for logistic regression
    // L = -sum(y * log(sigmoid(w*x + b)) + (1-y) * log(1 - sigmoid(w*x + b)))
    let w = 1.0;
    let b = 0.0;
    const lr = 0.01;
    const epochs = 1000;

    for (let epoch = 0; epoch < epochs; epoch++) {
      let dw = 0;
      let db = 0;

      for (let i = 0; i < logits.length; i++) {
        const z = w * logits[i] + b;
        const p = 1 / (1 + Math.exp(-z));
        const error = p - labels[i];
        dw += error * logits[i];
        db += error;
      }

      w -= lr * dw / logits.length;
      b -= lr * db / logits.length;

      // Early stopping
      if (Math.abs(dw) < 1e-6 && Math.abs(db) < 1e-6) break;
    }

    this.weight = w;
    this.bias = b;
  }

  /**
   * Calibrate logits to probabilities
   */
  calibrate(logits: number[]): number[] {
    return logits.map(x => {
      const z = this.weight * x + this.bias;
      return 1 / (1 + Math.exp(-z));
    });
  }

  toJSON(): { method: string; weight: number; bias: number } {
    return { method: "platt", weight: this.weight, bias: this.bias };
  }

  static fromJSON(data: { weight: number; bias: number }): PlattScaler {
    const scaler = new PlattScaler();
    scaler.weight = data.weight;
    scaler.bias = data.bias;
    return scaler;
  }
}

/**
 * Isotonic Regression - Non-parametric monotonic calibration
 * Pool Adjacent Violators Algorithm (PAVA)
 */
export class IsotonicCalibrator {
  private boundaries: number[] = [];
  private values: number[] = [];

  /**
   * Fit isotonic regression
   * confidences: model's raw confidence scores (0-1)
   * labels: 0 or 1
   */
  fit(confidences: number[], labels: number[]): void {
    // Sort by confidence
    const pairs = confidences.map((c, i) => ({ c, y: labels[i] }))
      .sort((a, b) => a.c - b.c);

    // PAVA algorithm
    const blocks: Array<{ sumY: number; count: number; c: number }> = [];

    for (const { c, y } of pairs) {
      blocks.push({ sumY: y, count: 1, c });
      // Merge violating blocks
      while (blocks.length >= 2) {
        const n = blocks.length;
        const prev = blocks[n - 2];
        const curr = blocks[n - 1];
        const prevAvg = prev.sumY / prev.count;
        const currAvg = curr.sumY / curr.count;
        if (prevAvg <= currAvg) break;
        // Merge
        prev.sumY += curr.sumY;
        prev.count += curr.count;
        blocks.pop();
      }
    }

    // Build step function
    this.boundaries = [];
    this.values = [];
    for (const block of blocks) {
      this.boundaries.push(block.c);
      this.values.push(block.sumY / block.count);
    }
  }

  /**
   * Calibrate confidences
   */
  calibrate(confidences: number[]): number[] {
    return confidences.map(c => {
      // Find rightmost boundary <= c
      let idx = this.boundaries.findIndex(b => b > c);
      if (idx === -1) idx = this.values.length - 1;
      else if (idx > 0) idx = idx - 1;
      return this.values[idx];
    });
  }

  toJSON(): { method: string; boundaries: number[]; values: number[] } {
    return { method: "isotonic", boundaries: this.boundaries, values: this.values };
  }

  static fromJSON(data: { boundaries: number[]; values: number[] }): IsotonicCalibrator {
    const cal = new IsotonicCalibrator();
    cal.boundaries = data.boundaries;
    cal.values = data.values;
    return cal;
  }
}

/**
 * Unified Calibrator Interface
 */
export type Calibrator = TemperatureScaler | PlattScaler | IsotonicCalibrator;

/**
 * Factory for creating calibrators
 */
export function createCalibrator(method: CalibrationMethod): Calibrator {
  switch (method) {
    case "temperature": return new TemperatureScaler();
    case "platt": return new PlattScaler();
    case "isotonic": return new IsotonicCalibrator();
  }
}

/**
 * Expected Calibration Error (ECE)
 */
export function expectedCalibrationError(
  confidences: number[],
  accuracies: number[],
  nBins = 10
): number {
  const binBoundaries = Array.from({ length: nBins + 1 }, (_, i) => i / nBins);
  let ece = 0;

  for (let i = 0; i < nBins; i++) {
    const lower = binBoundaries[i];
    const upper = binBoundaries[i + 1];

    const inBin = confidences
      .map((c, idx) => ({ c, a: accuracies[idx] }))
      .filter(({ c }) => c > lower && c <= upper);

    if (inBin.length === 0) continue;

    const avgConf = inBin.reduce((s, { c }) => s + c, 0) / inBin.length;
    const avgAcc = inBin.reduce((s, { a }) => s + a, 0) / inBin.length;
    const prop = inBin.length / confidences.length;

    ece += Math.abs(avgConf - avgAcc) * prop;
  }

  return ece;
}

/**
 * Collect calibration data by running generator on labeled examples
 */
export interface CalibrationData {
  logits: number[][];
  labels: number[];
  confidences: number[];
}

/**
 * Save calibrator to file
 */
export async function saveCalibrator(
  calibrator: Calibrator,
  filePath: string
): Promise<void> {
  const { writeFile } = await import("fs/promises");
  const data = calibrator.toJSON();
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * Load calibrator from file
 */
export async function loadCalibrator(
  method: CalibrationMethod,
  filePath: string
): Promise<Calibrator> {
  const { readFile } = await import("fs/promises");
  const data = JSON.parse(await readFile(filePath, "utf-8"));
  
  const calibrator = createCalibrator(method);
  // Use the static fromJSON method on the appropriate class
  if (method === "temperature") {
    return TemperatureScaler.fromJSON(data as { temperature: number });
  } else if (method === "platt") {
    return PlattScaler.fromJSON(data as { weight: number; bias: number });
  } else {
    return IsotonicCalibrator.fromJSON(data as { boundaries: number[]; values: number[] });
  }
}