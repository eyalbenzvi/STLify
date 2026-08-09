/**
 * AI job client tests, on the in-process path with an injected session
 * factory — the real ONNX runtime is never loaded (it could not run under
 * node anyway, which is exactly why the boundary exists).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { AiJobCancelledError, runAiJob } from "../client";
import { disposeAiSessions, type AiImagePayload } from "../jobs";
import { AiError } from "../errors";
import type { AiSession, AiSessionFactory } from "../onnx";

function payload(width = 4, height = 4): AiImagePayload {
  return { rgba: new Uint8Array(width * height * 4).fill(128), width, height };
}

/** A session that answers a fixed 2x2 map ([1,1,2,2] dims). */
function fakeSession(values: number[], dims = [1, 1, 2, 2]): AiSession {
  return {
    provider: "wasm",
    async run() {
      return { data: new Float32Array(values), dims };
    },
    async dispose() {},
  };
}

beforeEach(async () => {
  await disposeAiSessions();
});

describe("runAiJob (in-process, injected session)", () => {
  it("runs, normalises the map and reports the provider", async () => {
    const sessionFactory: AiSessionFactory = async () => fakeSession([2, 4, 6, 8]);
    const stages: string[] = [];
    const { result, ranOn } = await runAiJob("segmentImage", payload(), {
      forceInProcess: true,
      sessionFactory,
      onProgress: (_, labelHe) => stages.push(labelHe),
    });
    expect(ranOn).toBe("main");
    expect(result.provider).toBe("wasm");
    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(result.hasSignal).toBe(true);
    const expected = [0, 1 / 3, 2 / 3, 1];
    result.map.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 5));
    expect(stages[stages.length - 1]).toBe("הושלם");
  });

  it("reads the map from 3-dim outputs too ([1,H,W])", async () => {
    const sessionFactory: AiSessionFactory = async () =>
      fakeSession([0, 1, 2, 3, 4, 5], [1, 2, 3]);
    const { result } = await runAiJob("estimateDepth", payload(), {
      forceInProcess: true,
      sessionFactory,
    });
    expect(result.width).toBe(3);
    expect(result.height).toBe(2);
  });

  it("flags a flat map as having no signal", async () => {
    const sessionFactory: AiSessionFactory = async () => fakeSession([5, 5, 5, 5]);
    const { result } = await runAiJob("segmentImage", payload(), {
      forceInProcess: true,
      sessionFactory,
    });
    expect(result.hasSignal).toBe(false);
    expect([...result.map]).toEqual([0, 0, 0, 0]);
  });

  it("rejects a mismatched payload before ever touching a session", async () => {
    let created = 0;
    const sessionFactory: AiSessionFactory = async () => {
      created++;
      return fakeSession([1, 2, 3, 4]);
    };
    const bad: AiImagePayload = { rgba: new Uint8Array(7), width: 4, height: 4 };
    await expect(
      runAiJob("segmentImage", bad, { forceInProcess: true, sessionFactory })
    ).rejects.toThrow(AiError);
    expect(created).toBe(0);
  });

  it("cancels via the signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const sessionFactory: AiSessionFactory = async () => fakeSession([1, 2, 3, 4]);
    await expect(
      runAiJob("segmentImage", payload(), {
        forceInProcess: true,
        sessionFactory,
        signal: controller.signal,
      })
    ).rejects.toThrow(AiJobCancelledError);
  });

  it("does not cache a session whose factory failed", async () => {
    let calls = 0;
    const failing: AiSessionFactory = async () => {
      calls++;
      throw new AiError("נכשל");
    };
    await expect(
      runAiJob("segmentImage", payload(), { forceInProcess: true, sessionFactory: failing })
    ).rejects.toThrow(AiError);
    const working: AiSessionFactory = async () => {
      calls++;
      return fakeSession([1, 2, 3, 4]);
    };
    const { result } = await runAiJob("segmentImage", payload(), {
      forceInProcess: true,
      sessionFactory: working,
    });
    expect(calls).toBe(2);
    expect(result.width).toBe(2);
  });

  it("reuses one session per model across runs", async () => {
    let created = 0;
    const sessionFactory: AiSessionFactory = async () => {
      created++;
      return fakeSession([1, 2, 3, 4]);
    };
    await runAiJob("segmentImage", payload(), { forceInProcess: true, sessionFactory });
    await runAiJob("segmentImage", payload(), { forceInProcess: true, sessionFactory });
    expect(created).toBe(1);
  });
});
