import type { MessageBus } from "@holusion/dbus-next";
import { describe, expect, it, vi } from "vitest";
import { closeBus } from "../src/utils/closeBus";

describe("closeBus", () => {
  it("disconnects before it destroys the internal stream", () => {
    const calls: string[] = [];
    const disconnect = vi.fn(() => calls.push("disconnect"));
    const destroy = vi.fn(() => calls.push("destroy"));
    const bus = {
      disconnect,
      _connection: { stream: { destroy } },
    } as unknown as MessageBus;

    closeBus(bus);

    expect(calls).toEqual(["disconnect", "destroy"]);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("disconnects when the internal stream is absent", () => {
    const disconnect = vi.fn();
    const bus = { disconnect } as unknown as MessageBus;

    expect(() => closeBus(bus)).not.toThrow();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("preserves a disconnect error without destroying the stream", () => {
    const failure = new Error("disconnect failed");
    const destroy = vi.fn();
    const bus = {
      disconnect: vi.fn(() => {
        throw failure;
      }),
      _connection: { stream: { destroy } },
    } as unknown as MessageBus;

    expect(() => closeBus(bus)).toThrow(failure);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("preserves a stream destroy error after disconnect", () => {
    const failure = new Error("destroy failed");
    const disconnect = vi.fn();
    const bus = {
      disconnect,
      _connection: {
        stream: {
          destroy: vi.fn(() => {
            throw failure;
          }),
        },
      },
    } as unknown as MessageBus;

    expect(() => closeBus(bus)).toThrow(failure);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
