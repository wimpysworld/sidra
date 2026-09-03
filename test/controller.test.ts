import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CONTROLLER_ACTION_CHANNEL,
  CONTROLLER_RESET_CHANNEL,
  isControllerAction,
  isControllerActionChannel,
  isControllerResetChannel,
} from '../src/controller';
import type { ControllerAction } from '../src/controller';

describe('controller channels and actions', () => {
  it('keeps the action union exact', () => {
    expectTypeOf<ControllerAction>().toEqualTypeOf<
      'up' | 'down' | 'left' | 'right' | 'select' | 'back'
    >();
  });

  it('validates actions and private channel literals at runtime', () => {
    for (const action of ['up', 'down', 'left', 'right', 'select', 'back']) {
      expect(isControllerAction(action)).toBe(true);
    }
    expect(isControllerAction('play')).toBe(false);
    expect(isControllerAction(null)).toBe(false);
    expect(CONTROLLER_ACTION_CHANNEL).toBe('controller:action');
    expect(CONTROLLER_RESET_CHANNEL).toBe('controller:reset');
    expect(isControllerActionChannel(CONTROLLER_ACTION_CHANNEL)).toBe(true);
    expect(isControllerActionChannel(CONTROLLER_RESET_CHANNEL)).toBe(false);
    expect(isControllerResetChannel(CONTROLLER_RESET_CHANNEL)).toBe(true);
    expect(isControllerResetChannel(CONTROLLER_ACTION_CHANNEL)).toBe(false);
  });
});
