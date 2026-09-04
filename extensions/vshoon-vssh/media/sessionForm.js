// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    form: document.getElementById('form'),
    sessionName: document.getElementById('sessionName'),
    hostName: document.getElementById('hostName'),
    portNumber: document.getElementById('portNumber'),
    userName: document.getElementById('userName'),
    passwordSection: document.getElementById('passwordSection'),
    passwordAction: document.getElementById('passwordAction'),
    passwordInput: document.getElementById('passwordInput'),
    keySection: document.getElementById('keySection'),
    privateKeyPath: document.getElementById('privateKeyPath'),
    browseKeyBtn: document.getElementById('browseKeyBtn'),
    errorBox: document.getElementById('errorBox'),
    cancelBtn: document.getElementById('cancelBtn'),
  };

  let hasSavedPassword = false;

  function authMethodEls() {
    return Array.from(document.querySelectorAll('input[name="authMethod"]'));
  }

  function currentAuthMethod() {
    const checked = authMethodEls().find((r) => r.checked);
    return checked ? checked.value : 'password';
  }

  function updatePasswordActionOptions() {
    for (const opt of el.passwordAction.options) {
      if (opt.value === 'keep-saved' || opt.value === 'forget') {
        opt.hidden = !hasSavedPassword;
      }
      if (opt.value === 'keep-none') {
        opt.hidden = hasSavedPassword;
      }
    }
    el.passwordAction.value = hasSavedPassword ? 'keep-saved' : 'keep-none';
    updatePasswordInputVisibility();
  }

  function updatePasswordInputVisibility() {
    el.passwordInput.style.display = el.passwordAction.value === 'save' ? '' : 'none';
  }

  function updateAuthUi() {
    const method = currentAuthMethod();
    el.passwordSection.style.display = method === 'password' ? '' : 'none';
    el.keySection.style.display = method === 'password' ? 'none' : '';
    if (method === 'password') {
      updatePasswordActionOptions();
    }
  }

  authMethodEls().forEach((r) => r.addEventListener('change', updateAuthUi));
  el.passwordAction.addEventListener('change', updatePasswordInputVisibility);
  el.browseKeyBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickKeyFile' }));
  el.cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    el.errorBox.textContent = '';

    const authMethod = currentAuthMethod();
    let passwordAction = { type: 'keep' };
    if (authMethod === 'password') {
      const action = el.passwordAction.value;
      if (action === 'save') {
        passwordAction = { type: 'save', password: el.passwordInput.value };
      } else if (action === 'forget') {
        passwordAction = { type: 'forget' };
      } else {
        passwordAction = { type: 'keep' };
      }
    }

    vscode.postMessage({
      type: 'submit',
      profile: {
        sessionName: el.sessionName.value,
        hostName: el.hostName.value,
        portNumber: parseInt(el.portNumber.value, 10) || 22,
        userName: el.userName.value,
        authMethod,
        privateKeyPath: authMethod === 'password' ? undefined : el.privateKeyPath.value,
      },
      passwordAction,
    });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init': {
        hasSavedPassword = message.hasSavedPassword;
        const profile = message.profile;
        if (profile) {
          el.sessionName.value = profile.sessionName;
          el.hostName.value = profile.hostName;
          el.portNumber.value = String(profile.portNumber);
          el.userName.value = profile.userName;
          const radio = authMethodEls().find((r) => r.value === profile.authMethod);
          if (radio) radio.checked = true;
          if (profile.privateKeyPath) el.privateKeyPath.value = profile.privateKeyPath;
        }
        updateAuthUi();
        el.sessionName.focus();
        break;
      }
      case 'keyFilePicked':
        el.privateKeyPath.value = message.path;
        break;
      case 'error':
        el.errorBox.textContent = message.message;
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
