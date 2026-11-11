const GRACE_MS = 250;

/** Reveal-on-hover state for a toolbar that can auto-hide. */
export class AutoHide {
  revealed = $state(false);
  focusWithin = $state(false);
  private timer: number | undefined;

  enter = () => {
    clearTimeout(this.timer);
    this.revealed = true;
  };

  leave = () => {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => (this.revealed = false), GRACE_MS);
  };

  focusIn = () => (this.focusWithin = true);

  focusOut = (e: FocusEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) this.focusWithin = false;
  };

  hidden(autoHide: boolean, keepOpen = false) {
    return autoHide && !this.revealed && !this.focusWithin && !keepOpen;
  }
}
