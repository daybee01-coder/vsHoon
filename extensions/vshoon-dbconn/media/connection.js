// @ts-check
'use strict';

/**
 * 연결 추가/편집 폼.
 *
 * 예전 마법사가 단계마다 물어보던 것을 한 화면에 늘어놓은 것이다. 그래서 이
 * 파일이 하는 일의 대부분은 "지금 고른 종류에서 의미 없는 칸을 감추는 것"이다 —
 * MySQL 에 SID 를 묻거나, TLS 를 껐는데 CA 파일을 묻는 화면은 단계형보다 나쁘다.
 *
 * 비밀번호는 여기서 입력받지만 어디에도 남기지 않는다: setState 를 쓰지 않고,
 * 저장/테스트 메시지에 실어 확장으로 보내는 것이 전부다.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (/** @type {string} */ id) =>
    /** @type {HTMLInputElement & HTMLSelectElement & HTMLElement} */ (
      document.getElementById(id)
    );

  const form = /** @type {HTMLFormElement} */ (document.getElementById('form'));
  const el = {
    name: $('name'),
    nameHint: $('name-hint'),
    nameSuggestion: $('name-suggestion'),
    dialect: $('dialect'),
    environment: $('environment'),
    environmentHint: $('environment-hint'),
    modeFields: $('mode-fields'),
    modeUrl: $('mode-url'),
    rowDialect: $('row-dialect'),
    rowUrl: $('row-url'),
    url: $('url'),
    urlSummary: $('url-summary'),
    copyUrl: $('btn-copy-url'),
    rowHost: $('row-host'),
    rowDatabase: $('row-database'),
    host: $('host'),
    port: $('port'),
    rowOracleType: $('row-oracle-type'),
    oracleConnectType: $('oracleConnectType'),
    databaseLabel: $('database-label'),
    database: $('database'),
    databaseHint: $('database-hint'),
    user: $('user'),
    password: $('password'),
    passwordHint: $('password-hint'),
    savePassword: $('savePassword'),
    readOnly: $('readOnly'),
    tlsEnabled: $('tlsEnabled'),
    tlsVerify: $('tlsVerify'),
    rowCa: $('row-ca'),
    caPath: $('caPath'),
    tlsWarning: $('tls-warning'),
    browse: $('btn-browse'),
    status: $('status'),
    test: $('btn-test'),
    cancel: $('btn-cancel'),
    save: $('btn-save'),
  };

  /** @type {{ id: string, label: string, defaultPort: number, defaultUser: string }[]} */
  let dialects = [];
  /** @type {{ id: string, label: string, description: string }[]} */
  let environments = [];
  let isEdit = false;
  /**
   * 종류를 바꾸면 포트·사용자 기본값이 따라온다 — 단, 사용자가 직접 고친
   * 뒤에는 건드리지 않는다. 애써 적어 넣은 값을 화면이 되돌리면 안 된다.
   */
  const touched = { port: false, user: false };
  /** 테스트가 도는 동안 버튼을 잠근다. */
  let busy = false;
  /** 마지막 검증 결과. 버튼을 잠글지 판단하는 곳이 여러 군데라 상태로 둔다. */
  let valid = false;
  /** 접속 정보를 어떻게 입력하는 중인지. 'url' 이면 URL 칸이 진실이다. */
  let mode = 'fields';
  /** 마지막 URL 파싱이 남긴 문제. 없으면 빈 문자열. */
  let urlProblem = '';
  /**
   * 사용자·비밀번호를 손으로 고쳤는지.
   *
   * URL 방식에서는 URL 을 읽을 때마다 칸을 채우는데, 자격 증명만은 손으로 적은
   * 값을 덮어쓰면 안 된다 — URL 에 계정이 박혀 있어도 실제로 쓸 계정은 따로인
   * 경우가 흔하다. 반대로 URL 을 **붙여 넣는** 것은 "이걸로 새로 시작한다"는
   * 뜻이므로 그때는 이 표시를 지운다.
   */
  const handEdited = { user: false, password: false };
  /** 타자마다 파싱을 요청하지 않도록 하는 지연. */
  let urlTimer = null;

  // ── 확장 → 웹뷰 ─────────────────────────────────────────────────────────

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }
    switch (message.type) {
      case 'init':
        init(message);
        break;
      case 'status':
        showStatus(message.level, message.message);
        break;
      case 'idle':
        busy = false;
        syncEnabled();
        break;
      case 'caPath':
        el.caPath.value = message.path;
        validate();
        break;
      case 'urlApplied':
        urlProblem = typeof message.problem === 'string' ? message.problem : '';
        if (message.patch) {
          applyPatch(message.patch);
        }
        el.urlSummary.textContent = urlProblem || message.summary || '';
        el.urlSummary.classList.toggle('warn', urlProblem !== '');
        validate();
        break;
      case 'urlText':
        el.url.value = typeof message.url === 'string' ? message.url : '';
        requestUrlParse(true);
        break;
    }
  });

  /**
   * URL 파싱 결과를 칸에 흩뿌린다.
   *
   * 확장이 보내 준 키만 손댄다 — URL 이 말하지 않은 것(예: TLS)까지
   * 기본값으로 되돌리면, 공들여 맞춰 둔 설정이 붙여넣기 한 번에 날아간다.
   */
  function applyPatch(patch) {
    if (!patch || typeof patch !== 'object') {
      return;
    }
    if (patch.dialect) {
      el.dialect.value = patch.dialect;
    }
    if (typeof patch.host === 'string') {
      el.host.value = patch.host;
    }
    if (typeof patch.port === 'string') {
      el.port.value = patch.port;
      touched.port = true;
    }
    if (typeof patch.database === 'string') {
      el.database.value = patch.database;
    }
    if (typeof patch.user === 'string' && !handEdited.user) {
      el.user.value = patch.user;
      touched.user = true;
    }
    if (typeof patch.password === 'string' && !handEdited.password) {
      el.password.value = patch.password;
    }
    if (patch.oracleConnectType) {
      el.oracleConnectType.value = patch.oracleConnectType;
    }
    if (typeof patch.tlsEnabled === 'boolean') {
      el.tlsEnabled.checked = patch.tlsEnabled;
    }
    if (patch.tlsVerify) {
      el.tlsVerify.value = patch.tlsVerify;
    }

    syncDialect();
    syncTls();
    validate();
  }

  function init(message) {
    isEdit = message.isEdit === true;
    dialects = message.dialects || [];
    environments = message.environments || [];

    fillOptions(el.dialect, dialects);
    fillOptions(el.environment, environments);

    el.url.value = typeof message.url === 'string' ? message.url : '';
    setMode(message.mode === 'url' ? 'url' : 'fields', false);

    const v = message.values;
    el.name.value = v.name;
    el.dialect.value = v.dialect;
    el.environment.value = v.environment;
    el.host.value = v.host;
    el.port.value = v.port;
    el.database.value = v.database;
    el.user.value = v.user;
    el.password.value = '';
    el.savePassword.checked = v.savePassword;
    el.readOnly.checked = v.readOnly;
    el.tlsEnabled.checked = v.tlsEnabled;
    el.tlsVerify.value = v.tlsVerify;
    el.caPath.value = v.caPath;
    el.oracleConnectType.value = v.oracleConnectType;

    // 편집이면 이미 사용자가 정한 값이다. 종류를 바꿔도 덮어쓰지 않는다.
    touched.port = isEdit;
    touched.user = isEdit;

    el.passwordHint.textContent = isEdit
      ? '비워 두면 기존 비밀번호를 그대로 씁니다.'
      : 'OS 자격 증명 저장소에 안전하게 보관됩니다.';
    el.save.textContent = isEdit ? '저장' : '추가';

    syncDialect();
    syncTls();
    if (mode === 'url' && el.url.value.trim() !== '') {
      requestUrlParse(true);
    }
    validate();
    el.name.focus();
    el.name.select();
  }

  function fillOptions(select, items) {
    select.textContent = '';
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label;
      select.appendChild(option);
    }
  }

  // ── 입력 방식 ───────────────────────────────────────────────────────────

  /**
   * 호스트 방식 ↔ URL 방식.
   *
   * URL 방식에서는 종류 · 호스트 · 포트 · 데이터베이스 칸을 감춘다. 그 값들은
   * URL 에서 나오므로 두 곳에 같은 정보를 두면 어느 쪽이 진실인지 알 수 없다.
   * 대신 파싱 결과를 URL 칸 아래 한 줄로 보여 준다.
   *
   * 칸 자체는 남겨 두고 감추기만 한다 — 파싱 결과가 그대로 담기고, 방식을
   * 되돌리면 방금 URL 로 만든 값에서 이어서 고칠 수 있다.
   */
  function setMode(next, fromUser) {
    mode = next === 'url' ? 'url' : 'fields';
    el.modeUrl.checked = mode === 'url';
    el.modeFields.checked = mode === 'fields';

    el.rowUrl.hidden = mode !== 'url';
    el.rowDialect.hidden = mode === 'url';
    el.rowHost.hidden = mode === 'url';
    el.rowDatabase.hidden = mode === 'url';
    syncOracleRow();

    if (mode === 'url') {
      // 방식을 바꾼 순간의 칸 값으로 URL 을 만들어 채운다 — 빈 칸에서 시작하면
      // 방금까지 입력하던 것이 사라진 것처럼 보인다.
      if (fromUser) {
        vscode.postMessage({ type: 'buildUrl', values: values() });
      }
    } else {
      urlProblem = '';
      el.url.classList.remove('invalid');
    }
    validate();
  }

  /** Oracle 접속 식별(서비스 이름/SID)은 호스트 방식에서만 묻는다. */
  function syncOracleRow() {
    el.rowOracleType.hidden = mode === 'url' || el.dialect.value !== 'oracle';
  }

  /**
   * URL 을 확장에 보내 파싱을 부탁한다.
   *
   * 파싱 규칙은 확장 쪽 한 곳에만 둔다(테스트가 붙어 있는 곳이다). 타자마다
   * 보내지 않도록 잠깐 모았다가 보낸다.
   */
  function requestUrlParse(immediate) {
    if (urlTimer !== null) {
      clearTimeout(urlTimer);
      urlTimer = null;
    }
    const send = () => {
      urlTimer = null;
      const text = el.url.value.trim();
      if (text === '') {
        urlProblem = '';
        el.urlSummary.textContent = '';
        el.urlSummary.classList.remove('warn');
        validate();
        return;
      }
      vscode.postMessage({ type: 'applyUrl', url: text });
    };
    if (immediate) {
      send();
    } else {
      urlTimer = setTimeout(send, 250);
    }
  }

  // ── 화면 동기화 ─────────────────────────────────────────────────────────

  function currentDialect() {
    return dialects.find((d) => d.id === el.dialect.value);
  }

  /** 종류에 따라 달라지는 것: 기본 포트·사용자, 데이터베이스 칸의 이름과 필수 여부. */
  function syncDialect() {
    const dialect = currentDialect();
    if (!dialect) {
      return;
    }
    if (!touched.port) {
      el.port.value = String(dialect.defaultPort);
    }
    if (!touched.user) {
      el.user.value = dialect.defaultUser;
    }

    syncOracleRow();
    el.databaseLabel.textContent = databaseLabel();
    el.databaseHint.textContent =
      dialect.id === 'mysql' || dialect.id === 'mariadb'
        ? '비워 두면 기본 스키마를 사용합니다.'
        : '';

    syncEnvironmentHint();
    syncNameSuggestion();
  }

  function databaseLabel() {
    if (el.dialect.value !== 'oracle') {
      return '데이터베이스';
    }
    return el.oracleConnectType.value === 'sid' ? 'SID' : '서비스 이름';
  }

  function requiresDatabase() {
    return el.dialect.value === 'postgres' || el.dialect.value === 'oracle';
  }

  function syncEnvironmentHint() {
    const environment = environments.find((e) => e.id === el.environment.value);
    el.environmentHint.textContent = environment ? environment.description : '';
  }

  /** 이름을 비워 두면 무엇으로 저장되는지 미리 보여 준다 (확장 쪽 규칙과 같은 문구). */
  function syncNameSuggestion() {
    const dialect = currentDialect();
    const host = el.host.value.trim() || 'localhost';
    el.nameSuggestion.textContent = dialect ? dialect.label + ' · ' + host : host;
    el.nameHint.hidden = el.name.value.trim().length > 0;
  }

  function syncTls() {
    const enabled = el.tlsEnabled.checked;
    el.tlsVerify.disabled = !enabled;
    el.rowCa.hidden = !enabled || el.tlsVerify.value !== 'ca';
    el.caPath.disabled = !enabled;
    el.tlsWarning.hidden = !enabled || el.tlsVerify.value !== 'insecure';
  }

  // ── 검증 ────────────────────────────────────────────────────────────────

  /**
   * 저장할 수 있는 상태인지 본다. 판정은 확장에서 한 번 더 하지만(신뢰 경계),
   * 여기서 먼저 알려 줘야 저장을 누르고 나서야 빠진 칸을 알게 되는 일이 없다.
   */
  function validate() {
    /** @type {[HTMLInputElement, boolean][]} */
    const checks = [];

    const portValue = Number(el.port.value);
    const portOk =
      el.port.value.trim() !== '' &&
      Number.isInteger(portValue) &&
      portValue > 0 &&
      portValue < 65536;

    // 감춘 칸의 빨간 테두리는 보이지 않는다. URL 방식에서는 URL 칸 하나로 말한다.
    if (mode === 'url') {
      checks.push([el.url, urlCheck(portOk)]);
    } else {
      checks.push([el.host, el.host.value.trim() !== '']);
      checks.push([el.port, portOk]);
      checks.push([el.database, !requiresDatabase() || el.database.value.trim() !== '']);
    }
    checks.push([el.user, el.user.value.trim() !== '']);
    checks.push([
      el.caPath,
      !(el.tlsEnabled.checked && el.tlsVerify.value === 'ca') || el.caPath.value.trim() !== '',
    ]);

    let problem = '';
    for (const [input, ok] of checks) {
      input.classList.toggle('invalid', !ok);
      if (!ok && !problem) {
        problem = messageFor(input);
      }
    }

    if (problem) {
      showStatus('error', problem);
    } else {
      // 값이 바뀌면 지난 안내는 낡은 정보다 — 고친 칸을 두고 빨간 글씨가 남아 있거나,
      // 호스트를 바꿨는데 조금 전 "연결 성공"이 그대로 있으면 사람을 속인다.
      showStatus('info', '');
    }
    valid = problem === '';
    syncEnabled();
    return valid;
  }

  /** URL 방식에서 저장할 수 있는 상태인가 — 파싱이 성공했고 필수 값이 채워졌는가. */
  function urlCheck(portOk) {
    if (el.url.value.trim() === '' || urlProblem !== '') {
      return false;
    }
    if (el.host.value.trim() === '' || !portOk) {
      return false;
    }
    return !requiresDatabase() || el.database.value.trim() !== '';
  }

  function messageFor(input) {
    if (input === el.url) {
      if (el.url.value.trim() === '') {
        return '연결 URL 을 입력하세요.';
      }
      if (urlProblem !== '') {
        return urlProblem;
      }
      if (el.host.value.trim() === '') {
        return 'URL 에서 호스트를 읽지 못했습니다.';
      }
      if (requiresDatabase() && el.database.value.trim() === '') {
        return `URL 에 ${databaseLabel()} 이(가) 없습니다.`;
      }
      return 'URL 의 포트가 올바르지 않습니다.';
    }
    if (input === el.host) {
      return '호스트를 입력하세요.';
    }
    if (input === el.port) {
      return '포트는 1–65535 사이의 정수여야 합니다.';
    }
    if (input === el.user) {
      return '사용자를 입력하세요.';
    }
    if (input === el.database) {
      return databaseLabel() + ' 을(를) 입력하세요.';
    }
    if (input === el.caPath) {
      return 'CA 인증서 파일을 지정하세요.';
    }
    return '';
  }

  function syncEnabled() {
    el.save.disabled = busy || !valid;
    el.test.disabled = busy || !valid;
    el.browse.disabled = busy;
    el.copyUrl.disabled = busy;
    el.url.disabled = busy;
  }

  function showStatus(level, message) {
    el.status.textContent = message || '';
    el.status.className = level === 'error' ? 'error' : level === 'success' ? 'success' : '';
  }

  // ── 값 모으기 ───────────────────────────────────────────────────────────

  function values() {
    return {
      name: el.name.value,
      dialect: el.dialect.value,
      environment: el.environment.value,
      mode,
      url: el.url.value,
      host: el.host.value,
      port: el.port.value,
      database: el.database.value,
      user: el.user.value,
      password: el.password.value,
      savePassword: el.savePassword.checked,
      readOnly: el.readOnly.checked,
      tlsEnabled: el.tlsEnabled.checked,
      tlsVerify: el.tlsVerify.value,
      caPath: el.caPath.value,
      oracleConnectType: el.oracleConnectType.value,
    };
  }

  function submit() {
    if (busy || !validate()) {
      return;
    }
    vscode.postMessage({ type: 'save', values: values() });
  }

  function test() {
    if (busy || !validate()) {
      return;
    }
    busy = true;
    syncEnabled();
    vscode.postMessage({ type: 'test', values: values() });
  }

  // ── 입력 연결 ───────────────────────────────────────────────────────────

  el.dialect.addEventListener('change', () => {
    syncDialect();
    validate();
  });
  el.environment.addEventListener('change', syncEnvironmentHint);
  el.oracleConnectType.addEventListener('change', () => {
    el.databaseLabel.textContent = databaseLabel();
    validate();
  });
  el.port.addEventListener('input', () => {
    touched.port = true;
    validate();
  });
  el.user.addEventListener('input', () => {
    touched.user = true;
    handEdited.user = true;
    validate();
  });
  el.password.addEventListener('input', () => {
    handEdited.password = true;
    validate();
  });
  el.host.addEventListener('input', () => {
    syncNameSuggestion();
    validate();
  });
  el.name.addEventListener('input', syncNameSuggestion);
  el.database.addEventListener('input', validate);
  el.caPath.addEventListener('input', validate);
  el.tlsEnabled.addEventListener('change', () => {
    syncTls();
    validate();
  });
  el.tlsVerify.addEventListener('change', () => {
    syncTls();
    validate();
  });

  el.modeFields.addEventListener('change', () => setMode('fields', true));
  el.modeUrl.addEventListener('change', () => setMode('url', true));
  el.copyUrl.addEventListener('click', () =>
    vscode.postMessage({ type: 'copyUrl', values: values() }),
  );
  // 붙여넣기·타이핑 어느 쪽이든 곧바로 읽어 아래 칸에 반영한다.
  el.url.addEventListener('input', () => requestUrlParse(false));
  el.url.addEventListener('paste', () => {
    // 붙여 넣은 URL 은 새 출발점이다 — 자격 증명도 그 URL 것을 따른다.
    handEdited.user = false;
    handEdited.password = false;
    setTimeout(() => requestUrlParse(true), 0);
  });

  el.browse.addEventListener('click', () => vscode.postMessage({ type: 'browseCa' }));
  el.test.addEventListener('click', test);
  el.cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      vscode.postMessage({ type: 'cancel' });
      return;
    }
    // 어느 칸에 있든 Ctrl+Enter 로 저장 — 편집기의 실행 단축키와 같은 손놀림.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
