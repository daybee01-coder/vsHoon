// @ts-check
'use strict';

/**
 * 객체 상세 화면.
 *
 * 결과 그리드와 같은 규칙: DB 에서 온 값(컬럼 이름, 코멘트, DDL)은 전부
 * textContent 로만 넣는다. DDL 은 서버가 준 문자열이지만, 그 안에 무엇이
 * 들어 있든 여기서는 글자일 뿐이어야 한다.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const kindEl = /** @type {HTMLElement} */ (document.getElementById('kind'));
  const nameEl = /** @type {HTMLElement} */ (document.getElementById('name'));
  const sourceEl = /** @type {HTMLElement} */ (document.getElementById('source'));
  const contentEl = /** @type {HTMLElement} */ (document.getElementById('content'));
  const btnPreview = /** @type {HTMLButtonElement} */ (document.getElementById('btn-preview'));
  const btnSelect = /** @type {HTMLButtonElement} */ (document.getElementById('btn-select'));
  const btnDdl = /** @type {HTMLButtonElement} */ (document.getElementById('btn-ddl'));
  const btnRefresh = /** @type {HTMLButtonElement} */ (document.getElementById('btn-refresh'));

  const KIND_LABELS = {
    table: '테이블',
    view: '뷰',
    'materialized-view': '구체화 뷰',
    sequence: '시퀀스',
    function: '함수',
    procedure: '프로시저',
    package: '패키지',
    synonym: '동의어',
    type: '타입',
  };

  btnPreview.addEventListener('click', () => vscode.postMessage({ type: 'preview' }));
  btnSelect.addEventListener('click', () => vscode.postMessage({ type: 'generateSelect' }));
  btnDdl.addEventListener('click', () => vscode.postMessage({ type: 'openDefinition' }));
  btnRefresh.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }
    if (message.type === 'loading') {
      showHeader(message.ref);
      setActions(false, false);
      contentEl.textContent = '';
      contentEl.appendChild(placeholder('불러오는 중…'));
      return;
    }
    if (message.type === 'error') {
      showHeader(message.ref);
      setActions(false, false);
      contentEl.textContent = '';
      const block = document.createElement('div');
      block.className = 'note error';
      block.textContent = message.message || '상세 정보를 읽지 못했습니다.';
      contentEl.appendChild(block);
      return;
    }
    if (message.type === 'detail') {
      render(message.detail);
    }
  });

  function showHeader(ref) {
    if (!ref) {
      return;
    }
    kindEl.textContent = KIND_LABELS[ref.kind] || ref.kind;
    nameEl.textContent = `${ref.schema}.${ref.name}`;
  }

  function setActions(canPreview, hasDefinition) {
    btnPreview.disabled = !canPreview;
    btnSelect.disabled = !canPreview;
    btnDdl.disabled = !hasDefinition;
  }

  function render(detail) {
    showHeader(detail);
    sourceEl.textContent = `${detail.connectionName} · ${detail.dialectLabel}`;
    setActions(detail.canPreview === true, typeof detail.definition === 'string');

    contentEl.textContent = '';

    if (detail.comment) {
      const comment = document.createElement('p');
      comment.className = 'comment';
      comment.textContent = detail.comment;
      contentEl.appendChild(comment);
    }

    if (Array.isArray(detail.notes)) {
      for (const note of detail.notes) {
        const block = document.createElement('div');
        block.className = 'note';
        block.textContent = note;
        contentEl.appendChild(block);
      }
    }

    if (Array.isArray(detail.attributes) && detail.attributes.length > 0) {
      const section = openSection('속성', true);
      const grid = document.createElement('div');
      grid.className = 'attributes';
      for (const attribute of detail.attributes) {
        const label = document.createElement('div');
        label.className = 'attr-label';
        label.textContent = attribute.label;
        const value = document.createElement('div');
        value.className = 'attr-value';
        value.textContent = attribute.value;
        grid.appendChild(label);
        grid.appendChild(value);
      }
      section.body.appendChild(grid);
      contentEl.appendChild(section.root);
    }

    if (Array.isArray(detail.columns) && detail.columns.length > 0) {
      const section = openSection(`컬럼 (${detail.columns.length})`, true);
      section.body.appendChild(
        buildTable(
          ['', '이름', '타입', 'NULL', '기본값', '설명'],
          detail.columns.map((column) => [
            column.isPrimaryKey ? '🔑' : '',
            column.name,
            column.typeName,
            column.nullable ? '허용' : 'NOT NULL',
            column.defaultValue ?? '',
            column.comment ?? '',
          ]),
        ),
      );
      contentEl.appendChild(section.root);
    }

    if (Array.isArray(detail.indexes) && detail.indexes.length > 0) {
      const section = openSection(`인덱스 (${detail.indexes.length})`, true);
      section.body.appendChild(
        buildTable(
          ['이름', '고유', '컬럼'],
          detail.indexes.map((index) => [
            index.name,
            index.unique ? '예' : '',
            (index.columns || []).join(', '),
          ]),
        ),
      );
      contentEl.appendChild(section.root);
    }

    if (Array.isArray(detail.foreignKeys) && detail.foreignKeys.length > 0) {
      const section = openSection(`외래 키 (${detail.foreignKeys.length})`, true);
      section.body.appendChild(buildForeignKeyTable(detail.foreignKeys, 'outgoing'));
      contentEl.appendChild(section.root);
    }

    if (Array.isArray(detail.referencedBy) && detail.referencedBy.length > 0) {
      const section = openSection(`참조하는 테이블 (${detail.referencedBy.length})`, false);
      section.body.appendChild(buildForeignKeyTable(detail.referencedBy, 'incoming'));
      contentEl.appendChild(section.root);
    }

    if (typeof detail.definition === 'string' && detail.definition.length > 0) {
      const title = detail.definitionIsApproximate ? '정의 (근사)' : '정의';
      const section = openSection(title, true);

      if (detail.definitionIsApproximate) {
        const warn = document.createElement('div');
        warn.className = 'note';
        warn.textContent =
          '서버가 DDL 을 제공하지 않아 메타데이터로 조립한 근사치입니다. 제약 조건·파티션·스토리지 옵션은 포함되지 않습니다.';
        section.body.appendChild(warn);
      }

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'inline-button';
      copy.textContent = '복사';
      copy.addEventListener('click', () =>
        vscode.postMessage({ type: 'copy', text: detail.definition }),
      );
      section.header.appendChild(copy);

      const pre = document.createElement('pre');
      pre.className = 'definition';
      pre.textContent = detail.definition;
      section.body.appendChild(pre);
      contentEl.appendChild(section.root);
    }

    if (contentEl.childElementCount === 0) {
      contentEl.appendChild(placeholder('표시할 상세 정보가 없습니다.'));
    }
  }

  /** 접을 수 있는 구획. 큰 테이블에서 DDL 까지 스크롤하는 수고를 줄인다. */
  function openSection(title, expanded) {
    const root = document.createElement('section');
    root.className = 'section';

    const header = document.createElement('div');
    header.className = 'section-header';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'section-toggle';
    toggle.textContent = (expanded ? '▾ ' : '▸ ') + title;
    header.appendChild(toggle);

    const body = document.createElement('div');
    body.className = 'section-body';
    if (!expanded) {
      body.classList.add('hidden');
    }

    toggle.addEventListener('click', () => {
      const nowHidden = body.classList.toggle('hidden');
      toggle.textContent = (nowHidden ? '▸ ' : '▾ ') + title;
    });

    root.appendChild(header);
    root.appendChild(body);
    return { root, header, body };
  }

  /**
   * 외래 키 표. 상대 테이블 이름은 눌러서 그 객체의 상세로 이동할 수 있다 —
   * 참조를 따라가는 것이 이 화면을 여는 가장 흔한 이유다.
   */
  function buildForeignKeyTable(keys, direction) {
    const outgoing = direction === 'outgoing';
    const table = document.createElement('table');

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const headers = [
      '이름',
      outgoing ? '컬럼' : '이 테이블 컬럼',
      outgoing ? '대상' : '출발',
      'ON DELETE',
    ];
    for (const header of headers) {
      const th = document.createElement('th');
      th.textContent = header;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const key of keys) {
      const tr = document.createElement('tr');

      const nameCell = document.createElement('td');
      nameCell.textContent = key.name;
      nameCell.title = key.name;
      tr.appendChild(nameCell);

      const columnsCell = document.createElement('td');
      // 들어오는 참조는 제약이 상대 테이블에 있다 — 이쪽 컬럼은 참조 대상 컬럼이다.
      const localColumns = outgoing ? key.columns : key.referencedColumns;
      columnsCell.textContent = (localColumns || []).join(', ');
      columnsCell.title = columnsCell.textContent;
      tr.appendChild(columnsCell);

      // 나가는 참조면 "대상 테이블(대상 컬럼)", 들어오는 참조면 "출발 테이블(출발 컬럼)".
      const targetSchema = outgoing ? key.referencedSchema : key.schema;
      const targetTable = outgoing ? key.referencedTable : key.table;
      const targetColumns = outgoing ? key.referencedColumns : key.columns;

      const targetCell = document.createElement('td');
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'link';
      link.textContent = `${targetSchema}.${targetTable}`;
      link.title = '이 테이블의 상세 정보 보기';
      link.addEventListener('click', () =>
        vscode.postMessage({ type: 'openObject', schema: targetSchema, name: targetTable }),
      );
      targetCell.appendChild(link);
      const suffix = document.createElement('span');
      suffix.className = 'muted';
      suffix.textContent = ` (${(targetColumns || []).join(', ')})`;
      targetCell.appendChild(suffix);
      tr.appendChild(targetCell);

      const ruleCell = document.createElement('td');
      ruleCell.textContent = key.onDelete || '';
      tr.appendChild(ruleCell);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrap';
    wrapper.appendChild(table);
    return wrapper;
  }

  function buildTable(headers, rows) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const header of headers) {
      const th = document.createElement('th');
      th.textContent = header;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        td.textContent = cell === null || cell === undefined ? '' : String(cell);
        td.title = td.textContent;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrap';
    wrapper.appendChild(table);
    return wrapper;
  }

  function placeholder(text) {
    const el = document.createElement('div');
    el.className = 'placeholder';
    el.textContent = text;
    return el;
  }
})();
