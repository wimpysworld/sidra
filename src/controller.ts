/** Navigation actions accepted from the isolated controller preload. */
export type ControllerAction = 'up' | 'down' | 'left' | 'right' | 'select' | 'back';

/** Private preload-to-main channel, outside the AMWrapper bridge. */
export const CONTROLLER_ACTION_CHANNEL = 'controller:action' as const;
/** Private main-to-preload channel that suppresses held buttons after navigation. */
export const CONTROLLER_RESET_CHANNEL = 'controller:reset' as const;
/** Literal type for private controller action messages. */
export type ControllerActionChannel = typeof CONTROLLER_ACTION_CHANNEL;
/** Literal type for private controller reset messages. */
export type ControllerResetChannel = typeof CONTROLLER_RESET_CHANNEL;

const CONTROLLER_ACTIONS: readonly ControllerAction[] = [
  'up',
  'down',
  'left',
  'right',
  'select',
  'back',
];

/** Validate an IPC payload against the fixed navigation action list. */
export function isControllerAction(value: unknown): value is ControllerAction {
  return typeof value === 'string' && CONTROLLER_ACTIONS.some((action) => action === value);
}

/** Identify the private action channel without widening the bridge allowlist. */
export function isControllerActionChannel(value: string): value is typeof CONTROLLER_ACTION_CHANNEL {
  return value === CONTROLLER_ACTION_CHANNEL;
}

/** Identify the private reset channel without widening the bridge allowlist. */
export function isControllerResetChannel(value: string): value is typeof CONTROLLER_RESET_CHANNEL {
  return value === CONTROLLER_RESET_CHANNEL;
}
