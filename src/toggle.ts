export interface ToggleState {
  pressed: boolean;
  /** The value of the `mokapiValidation` global after a click. */
  next: 'on' | 'off';
  tooltip: string;
}

// Anything but 'on' counts as off, like the validation hook does.
export function toggleState(validation: unknown): ToggleState {
  return validation === 'on'
    ? { pressed: true, next: 'off', tooltip: 'Mokapi validation is on. Click to turn off.' }
    : { pressed: false, next: 'on', tooltip: 'Mokapi validation is off. Click to turn on.' };
}
