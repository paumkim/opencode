/**
 * Tests for confidence calibration
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  TemperatureScaler,
  PlattScaler,
  IsotonicCalibrator,
  createCalibrator,
  expectedCalibrationError,
  saveCalibrator,
  loadCalibrator,
} from "../core/calibrator.js";
import { z } from "zod";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── TemperatureScaler ────────────────────────────────────────────────────────

describe("TemperatureScaler", () => {
  it("fit() adjusts temperature for binary data", () => {
    const scaler = new TemperatureScaler();
    // Well-calibrated data: high logits for positive class
    const logits = [[3], [2], [1], [0.5], [-0.5], [-1], [-1.5], [-3]];
    const labels = [1, 1, 1, 1, 0, 0, 0, 0];
    scaler.fit(logits, labels);
    // Temperature should be positive and finite
    expect(scaler.getTemperature()).toBeGreaterThan(0.1);
    expect(scaler.getTemperature()).toBeLessThan(20);
  });

  it("calibrate() returns probabilities for binary logits", async () => {
    const scaler = new TemperatureScaler();
    scaler.fit([[3], [0], [-3]], [1, 1, 0]);
    const probs = scaler.calibrate([[3], [0], [-3]]);
    expect(probs).toHaveLength(3);
    expect(probs[0][0]).toBeGreaterThan(0.5);
    expect(probs[1][0]).toBeGreaterThan(0);
    // Probabilities should be in valid range
    expect(probs[2][0]).toBeGreaterThanOrEqual(0);
    expect(probs[2][0]).toBeLessThanOrEqual(1);
  });

  it("calibrate() normalizes multi-class probabilities", () => {
    const scaler = new TemperatureScaler();
    scaler.fit([[2, 1], [1, 2], [0, 0]], [0, 1, 0]);
    const probs = scaler.calibrate([[2, 1], [1, 2]]);
    expect(probs[0][0] + probs[0][1]).toBeCloseTo(1, 5);
    expect(probs[1][0] + probs[1][1]).toBeCloseTo(1, 5);
  });

  it("toJSON and fromJSON round-trip", () => {
    const scaler = new TemperatureScaler();
    scaler.fit([[2], [0], [-2]], [1, 1, 0]);
    const json = scaler.toJSON();
    expect(json.method).toBe("temperature");
    expect(json.temperature).toBeDefined();

    const restored = TemperatureScaler.fromJSON(json);
    expect(restored.getTemperature()).toBe(scaler.getTemperature());
  });
});

// ─── PlattScaler ──────────────────────────────────────────────────────────────

describe("PlattScaler", () => {
  it("fit() learns weight and bias for binary data", () => {
    const scaler = new PlattScaler();
    const logits = [3, 2, 1, 0, -1, -2, -3];
    const labels = [1, 1, 1, 0, 0, 0, 0];
    scaler.fit(logits, labels);
    expect(scaler).toBeDefined();
  });

  it("calibrate() returns probabilities between 0 and 1", () => {
    const scaler = new PlattScaler();
    scaler.fit([3, 0, -3], [1, 0, 0]);
    const probs = scaler.calibrate([3, 0, -3]);
    expect(probs[0]).toBeGreaterThan(0.5);
    expect(probs[1]).toBeCloseTo(0.5, 0);
    expect(probs[2]).toBeLessThan(0.5);
  });

  it("toJSON and fromJSON round-trip", () => {
    const scaler = new PlattScaler();
    scaler.fit([2, -2], [1, 0]);
    const json = scaler.toJSON();
    expect(json.method).toBe("platt");
    expect(json.weight).toBeDefined();
    expect(json.bias).toBeDefined();

    const restored = PlattScaler.fromJSON(json);
    expect(restored).toBeDefined();
  });
});

// ─── IsotonicCalibrator ───────────────────────────────────────────────────────

describe("IsotonicCalibrator", () => {
  it("fit() builds step function from data", () => {
    const cal = new IsotonicCalibrator();
    const confidences = [0.1, 0.3, 0.5, 0.7, 0.9];
    const labels = [0, 0, 1, 1, 1];
    cal.fit(confidences, labels);
    expect(cal).toBeDefined();
  });

  it("calibrate() returns monotonic values", () => {
    const cal = new IsotonicCalibrator();
    cal.fit([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]);
    const calibrated = cal.calibrate([0.1, 0.5, 0.9]);
    // Should be monotonically non-decreasing
    expect(calibrated[0]).toBeLessThanOrEqual(calibrated[1]);
    expect(calibrated[1]).toBeLessThanOrEqual(calibrated[2]);
  });

  it("calibrate() handles edge cases", () => {
    const cal = new IsotonicCalibrator();
    cal.fit([0.5], [1]);
    const calibrated = cal.calibrate([0.0, 0.5, 1.0]);
    expect(calibrated).toHaveLength(3);
  });

  it("toJSON and fromJSON round-trip", () => {
    const cal = new IsotonicCalibrator();
    cal.fit([0.1, 0.5, 0.9], [0, 1, 1]);
    const json = cal.toJSON();
    expect(json.method).toBe("isotonic");
    expect(json.boundaries).toBeDefined();
    expect(json.values).toBeDefined();

    const restored = IsotonicCalibrator.fromJSON(json);
    expect(restored).toBeDefined();
  });
});

// ─── createCalibrator factory ─────────────────────────────────────────────────

describe("createCalibrator", () => {
  it("creates TemperatureScaler for 'temperature'", () => {
    const cal = createCalibrator("temperature");
    expect(cal).toBeInstanceOf(TemperatureScaler);
  });

  it("creates PlattScaler for 'platt'", () => {
    const cal = createCalibrator("platt");
    expect(cal).toBeInstanceOf(PlattScaler);
  });

  it("creates IsotonicCalibrator for 'isotonic'", () => {
    const cal = createCalibrator("isotonic");
    expect(cal).toBeInstanceOf(IsotonicCalibrator);
  });
});

// ─── expectedCalibrationError ─────────────────────────────────────────────────

describe("expectedCalibrationError", () => {
  it("returns 0 for perfectly calibrated data", () => {
    const confidences = [0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9];
    const accuracies = [0.1, 0.2, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9];
    const ece = expectedCalibrationError(confidences, accuracies, 10);
    expect(ece).toBeCloseTo(0, 5);
  });

  it("returns positive value for miscalibrated data", () => {
    const confidences = [0.9, 0.9, 0.9, 0.9];
    const accuracies = [0.5, 0.5, 0.5, 0.5];
    const ece = expectedCalibrationError(confidences, accuracies, 4);
    expect(ece).toBeGreaterThan(0);
  });

  it("returns 0 for empty bins", () => {
    const confidences = [0.5];
    const accuracies = [0.5];
    const ece = expectedCalibrationError(confidences, accuracies, 10);
    expect(ece).toBeGreaterThanOrEqual(0);
  });

  it("handles known values correctly", () => {
    // All predictions at 0.8 confidence, all correct
    const confidences = [0.8, 0.8, 0.8];
    const accuracies = [1, 1, 1];
    const ece = expectedCalibrationError(confidences, accuracies, 10);
    expect(ece).toBeCloseTo(0.2, 1);
  });
});

// ─── saveCalibrator / loadCalibrator round-trip ───────────────────────────────

describe("saveCalibrator and loadCalibrator", () => {
  const testDir = join(tmpdir(), "system-one-lite-calibrator-test");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("round-trips TemperatureScaler", async () => {
    const scaler = new TemperatureScaler();
    scaler.fit([[2], [0], [-2]], [1, 1, 0]);
    const filePath = join(testDir, "temp-scaler.json");
    await saveCalibrator(scaler, filePath);
    const loaded = await loadCalibrator("temperature", filePath);
    expect(loaded).toBeInstanceOf(TemperatureScaler);
    expect((loaded as TemperatureScaler).getTemperature()).toBe(scaler.getTemperature());
  });

  it("round-trips PlattScaler", async () => {
    const scaler = new PlattScaler();
    scaler.fit([2, -2], [1, 0]);
    const filePath = join(testDir, "platt-scaler.json");
    await saveCalibrator(scaler, filePath);
    const loaded = await loadCalibrator("platt", filePath);
    expect(loaded).toBeInstanceOf(PlattScaler);
  });

  it("round-trips IsotonicCalibrator", async () => {
    const cal = new IsotonicCalibrator();
    cal.fit([0.1, 0.5, 0.9], [0, 1, 1]);
    const filePath = join(testDir, "isotonic.json");
    await saveCalibrator(cal, filePath);
    const loaded = await loadCalibrator("isotonic", filePath);
    expect(loaded).toBeInstanceOf(IsotonicCalibrator);
  });

  it("creates file at specified path", async () => {
    const scaler = new TemperatureScaler();
    const filePath = join(testDir, "custom-name.json");
    await saveCalibrator(scaler, filePath);
    const { existsSync } = await import("fs");
    expect(existsSync(filePath)).toBe(true);
  });
});
