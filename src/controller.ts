export type ControllerAction = 'up' | 'down' | 'left' | 'right' | 'select' | 'back';

export const CONTROLLER_ACTION_CHANNEL = 'controller:action' as const;
export const CONTROLLER_RESET_CHANNEL = 'controller:reset' as const;
export type ControllerActionChannel = typeof CONTROLLER_ACTION_CHANNEL;
export type ControllerResetChannel = typeof CONTROLLER_RESET_CHANNEL;

const CONTROLLER_ACTIONS: readonly ControllerAction[] = [
  'up',
  'down',
  'left',
  'right',
  'select',
  'back',
];

export function isControllerAction(value: unknown): value is ControllerAction {
  return typeof value === 'string' && CONTROLLER_ACTIONS.some((action) => action === value);
}

export function isControllerActionChannel(value: string): value is typeof CONTROLLER_ACTION_CHANNEL {
  return value === CONTROLLER_ACTION_CHANNEL;
}

export function isControllerResetChannel(value: string): value is typeof CONTROLLER_RESET_CHANNEL {
  return value === CONTROLLER_RESET_CHANNEL;
}
