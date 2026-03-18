function installTrustedTypesStub() {
  globalThis.trustedTypes = {
    createPolicy(_name, rules) {
      return {
        createHTML(value) {
          return rules.createHTML(value);
        },
        createScript(value) {
          return rules.createScript(value);
        },
      };
    },
    isHTML() {
      return false;
    },
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  installTrustedTypesStub();

  const knockoutModule = await import('knockout');
  const ko = knockoutModule.default ?? knockoutModule;

  const viewModel = {
    confirmManager: {
      showConfirmDialog: ko.observable(false),
      isConfirmDanger: ko.observable(true),
    },
  };

  const bindingContext = { $data: viewModel };
  const bindingProvider = new ko.bindingProvider();

  const bindingsToCheck = [
    {
      expression: 'visible: confirmManager.showConfirmDialog',
      verify(parsedBindings) {
        assert(
          typeof parsedBindings.visible === 'function',
          'Expected visible binding accessor to be a function',
        );
        assert(
          parsedBindings.visible()() === false,
          'Expected visible binding accessor to resolve the observable value',
        );
      },
    },
    {
      expression: 'css: { danger: confirmManager.isConfirmDanger }',
      verify(parsedBindings) {
        assert(
          typeof parsedBindings.css === 'function',
          'Expected css binding accessor to be a function',
        );
        const cssValue = parsedBindings.css();
        assert(
          typeof cssValue?.danger === 'function' && cssValue.danger() === true,
          'Expected css binding object to be evaluated',
        );
      },
    },
  ];

  for (const binding of bindingsToCheck) {
    const parsedBindings = bindingProvider.parseBindingsString(
      binding.expression,
      bindingContext,
      {},
      { valueAccessors: true },
    );
    binding.verify(parsedBindings);
  }

  console.log('Knockout Trusted Types smoke test passed');
} catch (error) {
  console.error('Knockout Trusted Types smoke test failed');
  console.error(error?.stack ?? error);
  process.exit(1);
}
