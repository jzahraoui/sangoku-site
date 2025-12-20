import ko from 'knockout';

/**
 * Gestionnaire de dialogues de confirmation
 */
export class ConfirmDialogManager {
  constructor() {
    this.showConfirmDialog = ko.observable(false);
    this.confirmDialogTitle = ko.observable('');
    this.confirmDialogMessage = ko.observable('');
    this.isConfirmDanger = ko.observable(false);
    this.pendingAction = null;

    // Pre-bound methods for Knockout bindings
    this.executeConfirmDialog = this.execute.bind(this);
    this.cancelConfirmDialog = this.cancel.bind(this);

    // Fermer avec Escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.showConfirmDialog()) {
        this.cancel();
      }
    });
  }

  show({ title, message, onConfirm, onCancel, danger = false }) {
    this.confirmDialogTitle(title);
    this.confirmDialogMessage(message);
    this.isConfirmDanger(danger);
    this.pendingAction = { onConfirm, onCancel };
    this.showConfirmDialog(true);

    setTimeout(() => {
      document.querySelector('.confirm-dialog .btn-cancel')?.focus();
    }, 100);
  }

  execute() {
    this.pendingAction?.onConfirm?.();
    this.close();
  }

  cancel() {
    this.pendingAction?.onCancel?.();
    this.close();
  }

  close() {
    this.showConfirmDialog(false);
    this.pendingAction = null;
  }
}

// Messages prédéfinis
export const confirmMessages = {
  resetApplication: {
    title: '⚠️ Reset Application',
    message:
      'This will delete ALL settings, measurements and filters. This operation is irreversible. Are you sure you want to continue?',
    danger: true,
  },
  resetMeasurements: {
    title: 'Reset Measurements',
    message:
      'This will reset all measurements to default settings (smoothing, IR window, target curve, equalizer, delays, inversion). Continue?',
    danger: false,
  },
};
