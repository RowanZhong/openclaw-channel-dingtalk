import { describe, expect, it, vi } from "vitest";
import { createRuntimeEventsFanout } from "../../src/platform/runtime-events";

describe("runtime events fanout", () => {
  it("uses one upstream subscription while delivering events to multiple local consumers", () => {
    let upstreamListener: ((event: unknown) => void) | undefined;
    const upstreamUnsubscribe = vi.fn();
    const upstream = {
      onAgentEvent: vi.fn((listener: (event: unknown) => void) => {
        upstreamListener = listener;
        return upstreamUnsubscribe;
      }),
    };
    const fanout = createRuntimeEventsFanout(upstream);
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = fanout.onAgentEvent?.(first);
    const unsubscribeSecond = fanout.onAgentEvent?.(second);
    upstreamListener?.({ stream: "tool" });

    expect(upstream.onAgentEvent).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    unsubscribeFirst?.();
    expect(upstreamUnsubscribe).not.toHaveBeenCalled();
    unsubscribeSecond?.();
    expect(upstreamUnsubscribe).toHaveBeenCalledOnce();
  });

  it("delivers the current event to a snapshot when a listener unsubscribes another listener", () => {
    let upstreamListener: ((event: unknown) => void) | undefined;
    const upstream = {
      onAgentEvent: vi.fn((listener: (event: unknown) => void) => {
        upstreamListener = listener;
        return vi.fn();
      }),
    };
    const fanout = createRuntimeEventsFanout(upstream);
    const second = vi.fn();
    let unsubscribeSecond: (() => void) | undefined;
    const first = vi.fn(() => unsubscribeSecond?.());

    fanout.onAgentEvent?.(first);
    unsubscribeSecond = fanout.onAgentEvent?.(second);
    upstreamListener?.({ stream: "tool" });

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it("isolates a throwing listener so later consumers still receive the event", () => {
    let upstreamListener: ((event: unknown) => void) | undefined;
    const upstream = {
      onAgentEvent: vi.fn((listener: (event: unknown) => void) => {
        upstreamListener = listener;
        return vi.fn();
      }),
    };
    const log = { warn: vi.fn() };
    const fanout = createRuntimeEventsFanout(upstream, { log });
    const failing = vi.fn(() => {
      throw new Error("listener boom");
    });
    const healthy = vi.fn();

    fanout.onAgentEvent?.(failing);
    fanout.onAgentEvent?.(healthy);

    // A throwing consumer must not bubble into the host event emitter.
    expect(() => upstreamListener?.({ stream: "tool" })).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("listener boom"));
  });

  it("keeps working without an upstream surface or a logger", () => {
    const fanout = createRuntimeEventsFanout(undefined);
    const listener = vi.fn();
    const unsubscribe = fanout.onAgentEvent?.(listener);

    expect(listener).not.toHaveBeenCalled();
    expect(() => unsubscribe?.()).not.toThrow();
  });
});
