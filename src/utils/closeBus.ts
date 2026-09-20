import type { MessageBus } from "@holusion/dbus-next";

interface DbusMessageBusInternals {
  _connection?: {
    stream?: {
      destroy: () => void;
    };
  };
}

/** Disconnect a D-Bus message bus, then force-close its internal stream. */
export function closeBus(bus: MessageBus): void {
  const stream = (bus as MessageBus & DbusMessageBusInternals)._connection
    ?.stream;
  bus.disconnect();
  stream?.destroy();
}
