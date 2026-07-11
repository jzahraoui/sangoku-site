// The log10 ↔ frequency maths live in measurement/frequency-log-scale.js
// ([MOTEUR], unit-tested) — this widget only owns the DOM/pointer handling.
import {
  DEFAULT_MAX_LOG,
  DEFAULT_MIN_LOG,
  createFrequencyLogScale,
  getDecimalPlaces,
  readNumber,
} from './measurement/frequency-log-scale.js';

export default class FrequencyRangeSlider {
  constructor({ minInput, maxInput, lowerFrequencyBound, upperFrequencyBound }) {
    if (!minInput) {
      throw new TypeError('FrequencyRangeSlider: `minInput` is missing');
    }
    if (!maxInput) {
      throw new TypeError('FrequencyRangeSlider: `maxInput` is missing');
    }
    if (typeof lowerFrequencyBound !== 'function') {
      throw new TypeError(
        'FrequencyRangeSlider: `lowerFrequencyBound` must be a Knockout observable',
      );
    }
    if (typeof upperFrequencyBound !== 'function') {
      throw new TypeError(
        'FrequencyRangeSlider: `upperFrequencyBound` must be a Knockout observable',
      );
    }

    this.minInput = minInput;
    this.maxInput = maxInput;
    this.lowerFrequencyBound = lowerFrequencyBound;
    this.upperFrequencyBound = upperFrequencyBound;
    this.scale = createFrequencyLogScale({
      minLog: readNumber(this.minInput.min, DEFAULT_MIN_LOG),
      maxLog: readNumber(this.minInput.max, DEFAULT_MAX_LOG),
      decimalPlaces: getDecimalPlaces(this.minInput.step),
    });
    this.minLog = this.scale.minLog;
    this.maxLog = this.scale.maxLog;
    // Cache the styled container instead of querying the DOM on every input.
    this.container = this.minInput.closest('.dual-range-input');
    // Re-entrancy counter (not a boolean) so subscribers triggered after
    // deferred KO updates still see a non-zero "updating" state.
    this.updateDepth = 0;
    this.activeInput = null;
    this.pendingPointerClientX = null;
    this.isTrackingPointer = false;

    this.handleLowerInput = () => {
      const upperFrequency = this.clampFrequency(this.upperFrequencyBound());
      const nextFrequency = Math.min(
        this.frequencyFromInput(this.minInput),
        upperFrequency,
      );
      this.setObservable(this.lowerFrequencyBound, nextFrequency);
      this.syncInputs();
    };

    this.handleUpperInput = () => {
      const lowerFrequency = this.clampFrequency(this.lowerFrequencyBound());
      const nextFrequency = Math.max(
        this.frequencyFromInput(this.maxInput),
        lowerFrequency,
      );
      this.setObservable(this.upperFrequencyBound, nextFrequency);
      this.syncInputs();
    };

    // Drive pointer interactions from the container. Native range inputs cannot
    // switch thumbs after pointerdown, which makes overlapped thumbs impossible
    // to separate reliably.
    this.handleContainerPointerDown = event => {
      event.preventDefault();
      this.capturePointer(event);
      this.startPointerTracking();
      this.pendingPointerClientX = event.clientX;

      const target = this.pickClosestInput(event);
      if (!target) {
        return;
      }

      this.beginPointerDrag(target);
      // When the press lands away from the closest thumb (i.e. on the bare
      // track), jump that thumb to the pointer position. Pressing directly on
      // (or within thumb tolerance of) the thumb leaves the value unchanged so
      // the user can start a drag without an initial snap.
      if (!this.isPointerNearInput(event, target)) {
        this.updateFromPointer(event, target);
      }
    };

    this.handleContainerPointerMove = event => {
      if (!this.activeInput) {
        const target = this.pickInputFromPendingDirection(event);
        if (!target) {
          return;
        }
        this.beginPointerDrag(target);
      }

      event.preventDefault();
      this.updateFromPointer(event, this.activeInput);
    };

    this.handlePointerRelease = event => {
      this.releasePointer(event);
      this.stopPointerTracking();
      this.endPointerDrag();
      // Restore hover state for the thumb still under the pointer so the UI
      // doesn't appear "cold" until the next pointermove.
      if (event && this.container && event.pointerType !== 'touch') {
        this.updateHoverState(event);
      }
    };

    // Hover tracking: with `pointer-events: none` on the inputs we cannot rely
    // on a CSS :hover targeting a specific thumb. Instead we toggle .is-hovered
    // on the input nearest to the pointer so only one thumb lights up.
    this.handleHoverPointerMove = event => {
      if (this.activeInput) {
        // During a drag the .is-dragging class drives the visual state.
        return;
      }
      // Touch pointers don't have a meaningful "hover" state; skipping them
      // avoids a brief flash of `is-hovered` at the start of a tap before
      // `pointerdown` upgrades it to `is-dragging`.
      if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') {
        return;
      }
      this.updateHoverState(event);
    };

    this.handlePointerLeave = () => {
      this.minInput.classList.remove('is-hovered');
      this.maxInput.classList.remove('is-hovered');
    };

    this.minInput.addEventListener('input', this.handleLowerInput);
    this.maxInput.addEventListener('input', this.handleUpperInput);
    if (this.container) {
      this.container.addEventListener('pointerdown', this.handleContainerPointerDown, {
        passive: false,
      });
      this.container.addEventListener('pointermove', this.handleHoverPointerMove, {
        passive: true,
      });
      this.container.addEventListener('pointerleave', this.handlePointerLeave);
    }
    globalThis.addEventListener?.('pointerup', this.handlePointerRelease);
    globalThis.addEventListener?.('pointercancel', this.handlePointerRelease);

    this.normalizeObservables();
    this.lowerSubscription = this.subscribeToObservable(this.lowerFrequencyBound);
    this.upperSubscription = this.subscribeToObservable(this.upperFrequencyBound);
    this.syncInputs();
  }

  destroy() {
    this.minInput.removeEventListener('input', this.handleLowerInput);
    this.maxInput.removeEventListener('input', this.handleUpperInput);
    if (this.container) {
      this.container.removeEventListener('pointerdown', this.handleContainerPointerDown);
      this.container.removeEventListener('pointermove', this.handleHoverPointerMove);
      this.container.removeEventListener('pointerleave', this.handlePointerLeave);
    }
    this.stopPointerTracking();
    globalThis.removeEventListener?.('pointerup', this.handlePointerRelease);
    globalThis.removeEventListener?.('pointercancel', this.handlePointerRelease);
    this.lowerSubscription?.dispose?.();
    this.upperSubscription?.dispose?.();
    this.lowerSubscription = null;
    this.upperSubscription = null;
    this.endPointerDrag();
    this.minInput.classList.remove('is-hovered');
    this.maxInput.classList.remove('is-hovered');
    // Drop the JS-driven custom properties so a stale gradient doesn't linger
    // if the same container is reused without re-instantiating the slider.
    if (this.container) {
      this.container.style.removeProperty('--dual-range-lower-percent');
      this.container.style.removeProperty('--dual-range-upper-percent');
    }
  }

  // Picks the input whose current value is closest to the pointer's horizontal
  // position so a click at the boundary always selects the visible thumb.
  pickClosestInput(event) {
    if (!this.container) {
      return null;
    }
    const rect = this.container.getBoundingClientRect();
    if (rect.width <= 0) {
      return null;
    }
    const pointerLog = this.logFromPointer(event, rect);
    const lowerLog = this.logFromFrequency(this.lowerFrequencyBound());
    const upperLog = this.logFromFrequency(this.upperFrequencyBound());

    if (Math.abs(lowerLog - upperLog) <= Number.EPSILON) {
      const tolerance = this.pointerLogTolerance(rect);
      if (pointerLog < lowerLog - tolerance) {
        return this.minInput;
      }
      if (pointerLog > upperLog + tolerance) {
        return this.maxInput;
      }
      return null;
    }

    return Math.abs(pointerLog - lowerLog) <= Math.abs(pointerLog - upperLog)
      ? this.minInput
      : this.maxInput;
  }

  pickInputFromPendingDirection(event) {
    if (this.pendingPointerClientX === null) {
      return null;
    }

    const delta = event.clientX - this.pendingPointerClientX;
    // Require a 2 px movement before committing to a direction so that a
    // single-pixel jitter on touch / high-DPI devices doesn't lock onto the
    // wrong thumb when both are overlapped.
    if (Math.abs(delta) < 2) {
      return null;
    }

    return delta < 0 ? this.minInput : this.maxInput;
  }

  isPointerNearInput(event, input) {
    if (!this.container) {
      return false;
    }

    const rect = this.container.getBoundingClientRect();
    if (rect.width <= 0) {
      return false;
    }

    const pointerLog = this.logFromPointer(event, rect);
    const inputFrequency =
      input === this.minInput
        ? this.lowerFrequencyBound()
        : this.upperFrequencyBound();
    const inputLog = this.logFromFrequency(inputFrequency);

    return Math.abs(pointerLog - inputLog) <= this.pointerLogTolerance(rect);
  }

  // Toggles .is-hovered on the input whose thumb is closest to the pointer.
  // When neither thumb is within the tolerance band (e.g. pointer over the
  // raw track far from any thumb), both classes are cleared.
  updateHoverState(event) {
    const target = this.pickClosestInput(event);
    this.minInput.classList.toggle('is-hovered', target === this.minInput);
    this.maxInput.classList.toggle('is-hovered', target === this.maxInput);
  }

  startPointerTracking() {
    if (!this.container || this.isTrackingPointer) {
      return;
    }

    this.container.addEventListener('pointermove', this.handleContainerPointerMove, {
      passive: false,
    });
    this.isTrackingPointer = true;
  }

  stopPointerTracking() {
    if (!this.container || !this.isTrackingPointer) {
      return;
    }

    this.container.removeEventListener('pointermove', this.handleContainerPointerMove);
    this.isTrackingPointer = false;
  }

  beginPointerDrag(input) {
    this.activeInput = input;
    this.minInput.classList.toggle('is-dragging', input === this.minInput);
    this.maxInput.classList.toggle('is-dragging', input === this.maxInput);
    input.focus({ preventScroll: true });
  }

  endPointerDrag() {
    this.activeInput = null;
    this.pendingPointerClientX = null;
    this.minInput.classList.remove('is-dragging');
    this.maxInput.classList.remove('is-dragging');
  }

  updateFromPointer(event, input) {
    const nextFrequency = this.frequencyFromPointer(event);

    if (input === this.minInput) {
      const upperFrequency = this.clampFrequency(this.upperFrequencyBound());
      this.setObservable(
        this.lowerFrequencyBound,
        Math.min(nextFrequency, upperFrequency),
      );
    } else {
      const lowerFrequency = this.clampFrequency(this.lowerFrequencyBound());
      this.setObservable(
        this.upperFrequencyBound,
        Math.max(nextFrequency, lowerFrequency),
      );
    }

    this.syncInputs();
  }

  frequencyFromPointer(event) {
    return this.roundFrequency(10 ** this.logFromPointer(event));
  }

  logFromPointer(event, rect = this.container?.getBoundingClientRect()) {
    if (!rect || rect.width <= 0) {
      return this.minLog;
    }

    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    return this.minLog + ratio * (this.maxLog - this.minLog);
  }

  pointerLogTolerance(rect) {
    const inputRect = this.minInput.getBoundingClientRect();
    const thumbWidth = Math.min(inputRect.height || 0, inputRect.width || 0);
    if (!thumbWidth || rect.width <= 0) {
      return 0;
    }

    return ((thumbWidth / 2) / rect.width) * (this.maxLog - this.minLog);
  }

  capturePointer(event) {
    if (!this.container || typeof this.container.setPointerCapture !== 'function') {
      return;
    }

    try {
      this.container.setPointerCapture(event.pointerId);
    } catch {
      // Ignore browsers that reject capture for this pointer.
    }
  }

  releasePointer(event) {
    if (!this.container || typeof this.container.releasePointerCapture !== 'function') {
      return;
    }

    try {
      this.container.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore cleanup races after pointer cancellation.
    }
  }

  normalizeObservables() {
    const lowerFrequency = this.roundFrequency(
      this.clampFrequency(this.lowerFrequencyBound()),
    );
    const upperFrequency = this.roundFrequency(
      this.clampFrequency(this.upperFrequencyBound()),
    );

    this.setObservable(
      this.lowerFrequencyBound,
      Math.min(lowerFrequency, upperFrequency),
    );
    this.setObservable(
      this.upperFrequencyBound,
      Math.max(lowerFrequency, upperFrequency),
    );
  }

  subscribeToObservable(observable) {
    if (typeof observable.subscribe !== 'function') {
      return null;
    }

    return observable.subscribe(() => {
      if (this.updateDepth > 0) {
        return;
      }
      // Re-normalize observables (clamp + ordering) when state changes from
      // the outside, then refresh the UI.
      this.normalizeObservables();
      this.syncInputs();
    });
  }

  setObservable(observable, value) {
    const current = Number(observable());
    if (Number.isFinite(current) && current === value) {
      return;
    }

    this.updateDepth += 1;
    try {
      observable(value);
    } finally {
      this.updateDepth -= 1;
    }
  }

  syncInputs() {
    const { lower: orderedLower, upper: orderedUpper } = this.scale.normalizeBounds(
      this.lowerFrequencyBound(),
      this.upperFrequencyBound(),
    );
    const lowerLog = this.logFromFrequency(orderedLower);
    const upperLog = this.logFromFrequency(orderedUpper);

    this.minInput.value = this.formatLogValue(lowerLog);
    this.maxInput.value = this.formatLogValue(upperLog);
    // aria-valuetext makes screen readers announce "1234 Hz" instead of the
    // raw log10 number that drives the slider.
    this.minInput.setAttribute('aria-valuetext', `${orderedLower} Hz`);
    this.maxInput.setAttribute('aria-valuetext', `${orderedUpper} Hz`);
    this.updateTrack(lowerLog, upperLog);
  }

  updateTrack(lowerLog, upperLog) {
    if (!this.container) {
      return;
    }

    const lowerPercent = this.scale.percentForLog(lowerLog);
    const upperPercent = this.scale.percentForLog(upperLog);

    this.container.style.setProperty('--dual-range-lower-percent', `${lowerPercent}%`);
    this.container.style.setProperty('--dual-range-upper-percent', `${upperPercent}%`);
  }

  frequencyFromInput(input) {
    return this.scale.frequencyFromLog(readNumber(input.value, this.minLog));
  }

  logFromFrequency(frequency) {
    return this.scale.logFromFrequency(frequency);
  }

  clampFrequency(frequency) {
    return this.scale.clampFrequency(frequency);
  }

  clampLog(logValue) {
    return this.scale.clampLog(logValue);
  }

  formatLogValue(logValue) {
    return this.scale.formatLog(logValue);
  }

  roundFrequency(frequency) {
    return this.scale.roundFrequency(frequency);
  }
}
