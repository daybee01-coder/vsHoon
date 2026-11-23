// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();
  function post(m) {
    vscode.postMessage(m);
  }

  // ---- 포맷터 ----------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtSize(n) {
    if (n === undefined || n === null) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
  }
  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtMode(mode) {
    if (mode === undefined || mode === null) return '';
    const bits = ['r', 'w', 'x'];
    let s = '';
    for (let g = 2; g >= 0; g--) {
      const v = (mode >> (g * 3)) & 7;
      for (let b = 0; b < 3; b++) s += v & (4 >> b) ? bits[b] : '-';
    }
    return s + ' ' + mode.toString(8).padStart(3, '0');
  }

  // ---- 상태 ---------------------------------------------------------------
  const minColumnWidths = { name: 88, size: 44, mtime: 64, mode: 52 };
  const maxColumnWidth = 4000;
  const columnKeys = Object.keys(minColumnWidths);
  function clampColumnWidth(key, width) {
    return Math.round(Math.min(maxColumnWidth, Math.max(minColumnWidths[key], width)));
  }
  function paneState(savedWidths) {
    const widths = {};
    for (const key of columnKeys) {
      if (Number.isFinite(savedWidths?.[key])) {
        widths[key] = clampColumnWidth(key, savedWidths[key]);
      }
    }
    return { path: '', entries: [], error: null, selected: new Set(), sortKey: 'name', sortAsc: true, anchor: -1, widths };
  }
  const persisted = vscode.getState() || {};
  const state = {
    local: paneState(persisted.columnWidths?.local),
    remote: paneState(persisted.columnWidths?.remote),
    connected: false,
    sessionLabel: '',
    showHidden: !!persisted.showHidden,
    queueVisible: !!persisted.queueVisible,
    queueHeight: Math.max(60, persisted.queueHeight || 160),
    splitPercent: Math.min(85, Math.max(15, persisted.splitPercent || 50)),
  };
  function savePrefs() {
    vscode.setState({
      showHidden: state.showHidden,
      queueVisible: state.queueVisible,
      queueHeight: state.queueHeight,
      splitPercent: state.splitPercent,
      columnWidths: { local: state.local.widths, remote: state.remote.widths },
    });
  }

  // ---- 로컬/원격 패널 너비 -------------------------------------------------
  const panesEl = document.getElementById('panes');
  const localPaneEl = document.querySelector('.pane[data-pane="local"]');
  const splitterEl = document.getElementById('paneSplitter');

  function applySplitPercent() {
    const available = Math.max(0, panesEl.clientWidth - splitterEl.offsetWidth);
    localPaneEl.style.flex = `0 0 ${Math.round((available * state.splitPercent) / 100)}px`;
  }

  splitterEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    splitterEl.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (event) => {
      const rect = panesEl.getBoundingClientRect();
      const available = Math.max(1, rect.width - splitterEl.offsetWidth);
      const localWidth = event.clientX - rect.left;
      state.splitPercent = Math.min(85, Math.max(15, (localWidth / available) * 100));
      applySplitPercent();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      splitterEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      savePrefs();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  applySplitPercent();
  window.addEventListener('resize', applySplitPercent);

  // ---- 우클릭 메뉴 ----------------------------------------------------------
  let menuEl = null;
  function hideMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
  }
  function showMenu(x, y, items) {
    hideMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    for (const it of items) {
      if (it[0] === '__sep__') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menuEl.appendChild(sep);
        continue;
      }
      const b = document.createElement('div');
      b.className = 'ctx-item';
      b.textContent = it[0];
      b.addEventListener('click', () => {
        hideMenu();
        it[1]();
      });
      menuEl.appendChild(b);
    }
    document.body.appendChild(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(2, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    menuEl.style.top = Math.max(2, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  }
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideMenu();
    if (e.key === 'F5' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      hideMenu();
      if (!e.repeat) post({ type: 'refreshBoth' });
    }
  });

  // dataTransfer의 사용자 MIME 데이터가 비는 Chromium/WebView 환경을 위한 보조 상태.
  // 같은 webview 안의 두 패널 사이에서만 사용하며 dragend에서 즉시 폐기한다.
  let activeDragPayload = null;

  // ---- 패널 ------------------------------------------------------------------
  function makePane(name) {
    const root = document.querySelector('.pane[data-pane="' + name + '"]');
    const listEl = root.querySelector('.pane-list');
    const headerEl = listEl.querySelector('.pane-cols');
    const entriesEl = listEl.querySelector('.pane-entries');
    const columns = headerEl.querySelectorAll('[data-sort]');
    const pathEl = root.querySelector('.pane-path');
    const footEl = root.querySelector('.pane-foot');
    const titleEl = root.querySelector('.pane-title');
    const st = state[name];
    let selectionMarquee = null;
    let renameInput = null;

    pathEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = pathEl.value.trim();
        if (v) post({ type: 'navigate', pane: name, path: v });
      }
    });

    root.querySelectorAll('.pane-tools button').forEach((b) => {
      b.addEventListener('click', () => {
        switch (b.dataset.act) {
          case 'up':
            post({ type: 'up', pane: name });
            break;
          case 'refresh':
            post({ type: 'refresh', pane: name });
            break;
          case 'mkdir':
            post({ type: 'mkdirRequest', pane: name });
            break;
          case 'pick':
            post({ type: 'pickLocalFolder' });
            break;
          case 'explorer':
            post({ type: 'openLocalExplorer' });
            break;
          case 'terminal':
            post({ type: 'openTerminalHere' });
            break;
        }
      });
    });

    const columnObserver = new ResizeObserver((entries) => {
      for (const { target } of entries) {
        target.querySelector('.column-resizer').setAttribute('aria-valuenow', String(Math.round(target.getBoundingClientRect().width)));
      }
    });
    columns.forEach((c) => {
      const key = c.dataset.sort;
      c.addEventListener('click', () => {
        if (st.sortKey === key) st.sortAsc = !st.sortAsc;
        else {
          st.sortKey = key;
          st.sortAsc = true;
        }
        render(true);
      });

      const handle = document.createElement('span');
      handle.className = 'column-resizer';
      handle.tabIndex = 0;
      handle.title = document.body.dataset.resizeColumnLabel;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', c.textContent);
      handle.setAttribute('aria-valuemin', String(minColumnWidths[key]));
      handle.setAttribute('aria-valuemax', String(maxColumnWidth));
      c.appendChild(handle);
      columnObserver.observe(c);
      if (st.widths[key] !== undefined) {
        root.style.setProperty('--column-' + key, st.widths[key] + 'px');
      }

      let drag;
      const setWidth = (width) => {
        const clamped = clampColumnWidth(key, width);
        st.widths[key] = clamped;
        root.style.setProperty('--column-' + key, clamped + 'px');
      };
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !e.isPrimary) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, lastX: e.clientX, width: c.getBoundingClientRect().width };
        handle.classList.add('dragging');
      });
      handle.addEventListener('pointermove', (e) => {
        if (!drag || e.clientX === drag.lastX || !handle.hasPointerCapture(e.pointerId)) return;
        drag.lastX = e.clientX;
        setWidth(drag.width + e.clientX - drag.x);
      });
      handle.addEventListener('lostpointercapture', () => {
        drag = undefined;
        handle.classList.remove('dragging');
        savePrefs();
      });
      handle.addEventListener('click', (e) => e.stopPropagation());
      handle.addEventListener('dblclick', () => {
        delete st.widths[key];
        root.style.removeProperty('--column-' + key);
        savePrefs();
      });
      handle.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          setWidth(c.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? -10 : 10));
          savePrefs();
        }
      });
    });

    listEl.addEventListener('keydown', onListKey);
    listEl.addEventListener('contextmenu', (e) => {
      if (e.target !== listEl && e.target !== entriesEl) return; // 빈 영역에서만
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        ['새 폴더', () => post({ type: 'mkdirRequest', pane: name })],
        ['새로고침', () => post({ type: 'refresh', pane: name })],
      ]);
    });
    listEl.addEventListener('dragover', (e) => {
      if (activeDragPayload && activeDragPayload.pane !== name && st.listingId !== undefined) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        listEl.classList.add('drop-hover');
      }
    });
    listEl.addEventListener('dragleave', (e) => {
      if (!listEl.contains(e.relatedTarget)) listEl.classList.remove('drop-hover');
    });
    listEl.addEventListener('drop', (e) => {
      listEl.classList.remove('drop-hover');
      if (activeDragPayload?.pane !== name) handleDrop(e);
    });

    function canDrop(intoDir, intoParent) {
      if (!activeDragPayload || st.listingId === undefined) return false;
      if (activeDragPayload.pane !== name) return !intoParent;
      return activeDragPayload.listingId === st.listingId && (intoParent || (!!intoDir && !activeDragPayload.names.includes(intoDir)));
    }

    function handleDrop(e, intoDir, intoParent = false) {
      if (!canDrop(intoDir, intoParent)) return;
      e.preventDefault();
      e.stopPropagation();
      const { pane, names, listingId } = activeDragPayload;
      activeDragPayload = null;
      document.querySelectorAll('.drop-target, .drop-hover').forEach(row => row.classList.remove('drop-target', 'drop-hover'));
      if (pane === name) {
        post({ type: 'moveRequest', pane, names, listingId, intoDir, intoParent });
      } else {
        post({ type: 'transfer', from: pane, names, listingId, targetListingId: st.listingId, intoDir });
      }
    }

    function registerDropTarget(row, intoDir, intoParent = false) {
      row.addEventListener('dragover', (e) => {
        if (!canDrop(intoDir, intoParent)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = activeDragPayload.pane === name ? 'move' : 'copy';
        listEl.classList.remove('drop-hover');
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', (e) => {
        if (!row.contains(e.relatedTarget)) row.classList.remove('drop-target');
      });
      row.addEventListener('drop', (e) => {
        row.classList.remove('drop-target');
        handleDrop(e, intoDir, intoParent);
      });
    }

    function beginSelectionMarquee(e) {
      if (e.button !== 0 || (e.target !== listEl && e.target !== entriesEl)) return;
      e.preventDefault();
      listEl.focus();

      const rect = listEl.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = 'selection-marquee';
      listEl.appendChild(box);
      selectionMarquee = {
        startX: e.clientX - rect.left + listEl.scrollLeft,
        startY: e.clientY - rect.top + listEl.scrollTop,
        base: e.ctrlKey || e.metaKey ? new Set(st.selected) : new Set(),
        box,
      };
      st.selected = new Set(selectionMarquee.base);
      st.anchor = -1;
      applySelectionClasses();
      document.body.style.userSelect = 'none';
    }

    function updateSelectionMarquee(e) {
      if (!selectionMarquee) return;
      if (!(e.buttons & 1)) {
        finishSelectionMarquee();
        return;
      }

      const rect = listEl.getBoundingClientRect();
      if (e.clientY < rect.top + headerEl.offsetHeight + 24) listEl.scrollTop -= 12;
      else if (e.clientY > rect.bottom - 24) listEl.scrollTop += 12;

      const viewX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const viewY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
      const currentX = viewX + listEl.scrollLeft;
      const currentY = viewY + listEl.scrollTop;
      const left = Math.min(selectionMarquee.startX, currentX);
      const top = Math.min(selectionMarquee.startY, currentY);
      const right = Math.max(selectionMarquee.startX, currentX);
      const bottom = Math.max(selectionMarquee.startY, currentY);

      Object.assign(selectionMarquee.box.style, {
        left: left + 'px',
        top: top + 'px',
        width: right - left + 'px',
        height: bottom - top + 'px',
      });

      st.selected = new Set(selectionMarquee.base);
      listEl.querySelectorAll('.row[data-name]').forEach((row) => {
        const rowLeft = row.offsetLeft;
        const rowTop = row.offsetTop;
        const intersects = rowLeft < right && rowLeft + row.offsetWidth > left && rowTop < bottom && rowTop + row.offsetHeight > top;
        if (intersects) st.selected.add(row.dataset.name);
      });
      applySelectionClasses();
    }

    function finishSelectionMarquee() {
      if (!selectionMarquee) return;
      selectionMarquee.box.remove();
      selectionMarquee = null;
      document.body.style.userSelect = '';
    }

    listEl.addEventListener('mousedown', beginSelectionMarquee);
    document.addEventListener('mousemove', updateSelectionMarquee);
    document.addEventListener('mouseup', finishSelectionMarquee);

    function visibleEntries() {
      let arr = st.entries;
      if (!state.showHidden) arr = arr.filter((e) => !e.name.startsWith('.'));
      arr = arr.slice();
      const dir = st.sortAsc ? 1 : -1;
      arr.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        if (st.sortKey === 'size') return dir * ((a.size || 0) - (b.size || 0));
        if (st.sortKey === 'mtime') return dir * ((a.mtime || 0) - (b.mtime || 0));
        if (st.sortKey === 'mode') return dir * ((a.mode || 0) - (b.mode || 0));
        return dir * a.name.localeCompare(b.name, 'ko');
      });
      return arr;
    }

    function renderFoot() {
      const n = st.selected.size;
      const total = visibleEntries().length;
      footEl.textContent = n ? n + '개 선택 · ' + total + '개 표시' : total + '개 항목';
    }

    function applySelectionClasses() {
      listEl.querySelectorAll('.row[data-name]').forEach((r) => {
        r.classList.toggle('selected', st.selected.has(r.dataset.name));
      });
      renderFoot();
    }

    function onRowClick(e, rows, idx) {
      listEl.focus();
      const nm = rows[idx].name;
      if (e.ctrlKey || e.metaKey) {
        if (st.selected.has(nm)) st.selected.delete(nm);
        else st.selected.add(nm);
        st.anchor = idx;
      } else if (e.shiftKey && st.anchor >= 0) {
        const lo = Math.min(st.anchor, idx);
        const hi = Math.max(st.anchor, idx);
        st.selected = new Set(rows.slice(lo, hi + 1).map((r) => r.name));
      } else {
        st.selected = new Set([nm]);
        st.anchor = idx;
      }
      applySelectionClasses();
    }

    function onListKey(e) {
      if (e.key === 'Backspace') {
        e.preventDefault();
        post({ type: 'up', pane: name });
      } else if (e.key === 'Delete' && st.selected.size) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) requestEntryOperation('deleteRequest');
      } else if (e.key === 'F2' && st.selected.size === 1) {
        e.preventDefault();
        e.stopPropagation();
        beginRename(st.selected.values().next().value);
      } else if (e.key === 'Enter' && st.selected.size === 1) {
        e.preventDefault();
        openByName(Array.from(st.selected)[0]);
      }
    }

    function requestEntryOperation(type, names = Array.from(st.selected), listingId = st.listingId) {
      if (listingId !== undefined && names.length) post({ type, pane: name, names, listingId });
    }

    function beginRename(entryName) {
      if (renameInput || st.listingId === undefined) return;
      const entry = st.entries.find((item) => item.name === entryName);
      const row = Array.from(listEl.querySelectorAll('.row[data-name]'))
        .find((item) => item.dataset.name === entryName);
      if (!entry || !row) return;

      const listingId = st.listingId;
      const cell = row.querySelector('.c-name');
      const label = cell.textContent;
      const input = renameInput = document.createElement('input');
      input.className = 'rename-input';
      input.type = 'text';
      input.value = entryName;
      input.spellcheck = false;
      input.setAttribute('aria-label', document.body.dataset.renameLabel);
      row.draggable = false;
      cell.replaceChildren(input);

      function finish(commit, restoreFocus) {
        if (renameInput !== input) return;
        renameInput = null;
        cell.textContent = label;
        row.draggable = true;
        if (restoreFocus) listEl.focus({ preventScroll: true });
        if (commit && input.value !== entryName) {
          post({ type: 'rename', pane: name, listingId, name: entryName, newName: input.value });
        }
      }

      input.addEventListener('keydown', (e) => {
        if (e.key !== 'F5') e.stopPropagation();
        if (e.isComposing) return;
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          finish(e.key === 'Enter', true);
        }
      });
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('dblclick', (e) => e.stopPropagation());
      input.addEventListener('contextmenu', (e) => e.stopPropagation());
      input.addEventListener('blur', () => finish(false, false));
      input.focus();
      const dot = entryName.lastIndexOf('.');
      input.setSelectionRange(0, !entry.isDirectory && dot > 0 ? dot : entryName.length);
    }

    function openByName(nm) {
      const entry = st.entries.find((x) => x.name === nm);
      if (!entry) return;
      if (entry.isSymbolicLink && !entry.isDirectory) post({ type: 'openSymlink', pane: name, name: nm });
      else if (entry.isDirectory) post({ type: 'enter', pane: name, name: nm });
      else post({ type: 'open', pane: name, name: nm });
    }

    function onRowContext(e, rows, idx) {
      e.preventDefault();
      e.stopPropagation();
      const entry = rows[idx];
      if (!st.selected.has(entry.name)) {
        st.selected = new Set([entry.name]);
        st.anchor = idx;
        applySelectionClasses();
      }
      const sel = Array.from(st.selected);
      const listingId = st.listingId;
      const labels = document.body.dataset;
      const items = [];
      if (name === 'local') {
        items.push(['원격으로 업로드', () => post({ type: 'transfer', from: 'local', names: sel })]);
        if (!entry.isDirectory) items.push(['열기', () => post({ type: 'open', pane: name, name: entry.name })]);
      } else {
        items.push(['로컬로 다운로드', () => post({ type: 'transfer', from: 'remote', names: sel })]);
        if (!entry.isDirectory) items.push(['편집기로 열기', () => post({ type: 'open', pane: name, name: entry.name })]);
      }
      items.push(['__sep__']);
      if (sel.length === 1) items.push([labels.renameLabel, () => beginRename(entry.name)]);
      items.push([labels.copyLabel, () => requestEntryOperation('copyRequest', sel, listingId)]);
      items.push([labels.moveLabel, () => requestEntryOperation('moveRequest', sel, listingId)]);
      items.push([labels.deleteLabel, () => requestEntryOperation('deleteRequest', sel, listingId)]);
      items.push(['새 폴더', () => post({ type: 'mkdirRequest', pane: name })]);
      if (name === 'remote') items.push(['여기로 터미널 이동', () => post({ type: 'openTerminalHere' })]);
      showMenu(e.clientX, e.clientY, items);
    }

    function render(preserveScroll) {
      const scroll = preserveScroll ? listEl.scrollTop : 0;
      titleEl.textContent =
        name === 'local' ? '로컬' : state.connected ? '원격 · ' + (state.sessionLabel || '') : '원격 (연결 안 됨)';
      if (document.activeElement !== pathEl) pathEl.value = st.path;

      columns.forEach((c) => {
        const on = c.dataset.sort === st.sortKey;
        c.classList.toggle('sorted', on);
        c.dataset.dir = on ? (st.sortAsc ? '▲' : '▼') : '';
      });

      if (renameInput) {
        listEl.focus({ preventScroll: true });
        renameInput = null;
      }
      entriesEl.replaceChildren();

      if (st.error) {
        const d = document.createElement('div');
        d.className = 'pane-error';
        d.textContent = st.error;
        entriesEl.appendChild(d);
        footEl.textContent = '';
        return;
      }

      const up = document.createElement('div');
      up.className = 'row up';
      up.innerHTML = '<span class="c-name">📁 ..</span><span class="c-size"></span><span class="c-mtime"></span><span class="c-mode"></span>';
      up.addEventListener('dblclick', () => post({ type: 'up', pane: name }));
      registerDropTarget(up, undefined, true);
      entriesEl.appendChild(up);

      const rows = visibleEntries();
      rows.forEach((entry, idx) => {
        const row = document.createElement('div');
        row.className = 'row' + (st.selected.has(entry.name) ? ' selected' : '');
        row.dataset.name = entry.name;
        row.draggable = true;
        if (name === 'local') row.title = document.body.dataset.nativeDragLabel;
        const icon = entry.isDirectory ? '📁' : entry.isSymbolicLink ? '🔗' : '📄';
        row.innerHTML =
          '<span class="c-name">' + icon + ' ' + escapeHtml(entry.name) + '</span>' +
          '<span class="c-size">' + (entry.isDirectory ? '' : fmtSize(entry.size)) + '</span>' +
          '<span class="c-mtime">' + fmtTime(entry.mtime) + '</span>' +
          '<span class="c-mode">' + fmtMode(entry.mode) + '</span>';
        row.addEventListener('click', (e) => onRowClick(e, rows, idx));
        row.addEventListener('dblclick', () => openByName(entry.name));
        row.addEventListener('contextmenu', (e) => onRowContext(e, rows, idx));
        row.addEventListener('dragstart', (e) => {
          if (!st.selected.has(entry.name)) {
            st.selected = new Set([entry.name]);
            st.anchor = idx;
            applySelectionClasses();
          }

          if (st.listingId === undefined) {
            e.preventDefault();
            return;
          }
          if (name === 'local' && e.altKey) {
            e.preventDefault();
            post({ type: 'osDragStart', pane: name, names: Array.from(st.selected), listingId: st.listingId });
            return;
          }

          activeDragPayload = { pane: name, names: Array.from(st.selected), listingId: st.listingId };
          e.dataTransfer.effectAllowed = 'copyMove';
          e.dataTransfer.setData('application/x-vssh', name);
        });
        row.addEventListener('dragend', () => {
          activeDragPayload = null;
          listEl.classList.remove('drop-hover');
          document.querySelectorAll('.row.drop-target').forEach((r) => r.classList.remove('drop-target'));
        });
        if (entry.isDirectory) {
          registerDropTarget(row, entry.name);
        }
        entriesEl.appendChild(row);
      });

      listEl.scrollTop = scroll;
      renderFoot();
    }

    return {
      render,
      update(msg) {
        if (activeDragPayload?.pane === name && activeDragPayload.listingId !== msg.listingId) {
          activeDragPayload = null;
        }
        const sameDirectory = st.listedPath === msg.path && st.sessionId === msg.sessionId;
        st.listedPath = msg.path;
        st.sessionId = msg.sessionId;
        st.listingId = msg.listingId;
        if (msg.path) st.path = msg.path;
        st.error = msg.error || null;
        st.entries = msg.entries || [];
        if (msg.selectedName) {
          st.selected = new Set([msg.selectedName]);
        } else if (!sameDirectory) {
          st.selected.clear();
        }
        const visible = visibleEntries();
        st.selected = new Set(visible.filter((entry) => st.selected.has(entry.name)).map((entry) => entry.name));
        st.anchor = visible.findIndex((entry) => st.selected.has(entry.name));
        render(sameDirectory);
      },
    };
  }

  const panes = { local: makePane('local'), remote: makePane('remote') };

  // ---- 파일 전송 --------------------------------------------------------
  document.getElementById('toRemote').addEventListener('click', () => {
    const names = Array.from(state.local.selected);
    if (names.length) post({ type: 'transfer', from: 'local', names });
  });
  document.getElementById('toLocal').addEventListener('click', () => {
    const names = Array.from(state.remote.selected);
    if (names.length) post({ type: 'transfer', from: 'remote', names });
  });
  function toggleHiddenFiles() {
    state.showHidden = !state.showHidden;
    savePrefs();
    panes.local.render(true);
    panes.remote.render(true);
  }
  // ---- 전송 큐 -------------------------------------------------------------
  const queueEl = document.getElementById('queue');
  const queueListEl = document.getElementById('queueList');
  const queueSummaryEl = document.getElementById('queueSummary');
  const queueHandleEl = document.getElementById('queueHandle');
  let lastQueueItems = [];

  function queueMax() {
    return Math.max(80, Math.floor(window.innerHeight * 0.85));
  }
  function applyQueueHeight() {
    state.queueHeight = Math.min(queueMax(), Math.max(60, state.queueHeight));
    queueEl.style.height = state.queueHeight + 'px';
  }
  function applyQueueVisibility() {
    queueEl.classList.toggle('hidden', !state.queueVisible);
    if (state.queueVisible) applyQueueHeight();
  }
  function setQueueVisible(v) {
    state.queueVisible = v;
    savePrefs();
    applyQueueVisibility();
    if (v) renderQueue(lastQueueItems);
  }
  applyQueueVisibility();

  document.getElementById('queueToggle').addEventListener('click', () => setQueueVisible(false));
  document.getElementById('queueClear').addEventListener('click', () => post({ type: 'queueClear' }));
  document.getElementById('queueCancel').addEventListener('click', () => post({ type: 'queueCancel' }));

  // 상단 손잡이를 드래그해서 전송 목록 높이 조절
  queueHandleEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = queueEl.getBoundingClientRect().height;
    queueHandleEl.classList.add('dragging');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev) => {
      state.queueHeight = Math.min(queueMax(), Math.max(60, startH + (startY - ev.clientY)));
      queueEl.style.height = state.queueHeight + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      queueHandleEl.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      savePrefs();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  window.addEventListener('resize', () => {
    if (state.queueVisible) applyQueueHeight();
  });

  function qStat(i) {
    if (i.status === 'error') return '실패';
    if (i.status === 'done') return '완료';
    if (i.status === 'canceled') return '취소';
    if (i.status === 'active') return fmtSize(i.transferred) + ' / ' + fmtSize(i.size);
    return '대기';
  }

  function renderQueue(items) {
    const active = items.filter((i) => i.status === 'active' || i.status === 'queued').length;
    const done = items.filter((i) => i.status === 'done').length;
    const failed = items.filter((i) => i.status === 'error').length;
    let total = 0;
    let moved = 0;
    for (const i of items) {
      total += i.size || 0;
      moved += (i.status === 'done' ? i.size : i.transferred) || 0;
    }
    const pct = total ? Math.floor((moved / total) * 100) : 0;
    queueSummaryEl.textContent = !items.length
      ? '전송 없음'
      : active
      ? '전송 중 ' + active + '개 · ' + pct + '%'
      : '완료 ' + done + '개' + (failed ? ' · 실패 ' + failed + '개' : '');

    queueListEl.innerHTML = '';
    for (const i of items.slice().reverse()) {
      const row = document.createElement('div');
      row.className = 'q-row q-' + i.status;
      const p = i.size ? Math.min(100, Math.floor((i.transferred / i.size) * 100)) : i.status === 'done' ? 100 : 0;
      const cancelable = i.status === 'active' || i.status === 'queued';
      row.innerHTML =
        '<span class="q-dir">' + (i.direction === 'upload' ? '▲' : '▼') + '</span>' +
        '<span class="q-label">' + escapeHtml(i.label) + '</span>' +
        '<span class="q-bar"><span class="q-fill" style="width:' + p + '%"></span></span>' +
        '<span class="q-stat">' + qStat(i) + '</span>' +
        '<span class="q-cancel">' + (cancelable ? '✕' : '') + '</span>';
      if (i.error) row.title = i.error;
      if (cancelable) {
        row.querySelector('.q-cancel').addEventListener('click', () => post({ type: 'queueCancelItem', id: i.id }));
      }
      queueListEl.appendChild(row);
    }
  }

  // ---- 탐색기에서 끌어온 파일 ------------------------------------------------
  // 웹뷰는 OS 드롭을 직접 받을 수 없다. Workbench가 경로를 풀어 이 메시지로 넘겨주므로,
  // 여기서는 포인터가 어느 패널의 무엇 위에 있었는지만 판단해 확장에 전달한다.
  function resolveOsDropTarget(position) {
    const x = Number(position && position.x);
    const y = Number(position && position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const at = document.elementFromPoint(x, y);
    const paneEl = at && at.closest ? at.closest('.pane[data-pane]') : null;
    if (!paneEl) {
      // 스플리터나 여백 위에서 놓았을 수 있다. 그 x를 품는 패널로 되돌린다.
      for (const candidate of document.querySelectorAll('.pane[data-pane]')) {
        const r = candidate.getBoundingClientRect();
        if (x >= r.left && x <= r.right) return { pane: candidate.dataset.pane, intoDir: undefined };
      }
      return null;
    }

    const rowEl = at.closest('.row[data-name]');
    const name = rowEl ? rowEl.dataset.name : undefined;
    const pane = paneEl.dataset.pane;
    const isDir = !!name && (state[pane].entries || []).some((e) => e.name === name && e.isDirectory);
    return { pane, intoDir: isDir ? name : undefined };
  }

  // ---- 확장 -> 웹뷰 메시지 --------------------------------------------------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
        state.connected = !!msg.connected;
        state.sessionLabel = msg.sessionLabel || '';
        state.canEditRemote = !!msg.canEditRemote;
        if (msg.localPath) state.local.path = msg.localPath;
        if (msg.remotePath) state.remote.path = msg.remotePath;
        panes.local.render(true);
        panes.remote.render(true);
        break;
      case 'list':
        if (panes[msg.pane]) panes[msg.pane].update(msg);
        break;
      case 'queue':
        lastQueueItems = msg.items || [];
        // 숨겨진 전송 목록의 전체 DOM을 진행 이벤트마다 다시 만들지 않는다.
        if (state.queueVisible) renderQueue(lastQueueItems);
        break;
      case 'toggleHidden':
        toggleHiddenFiles();
        break;
      case 'toggleQueue':
        setQueueVisible(!state.queueVisible);
        break;
      case 'vshoon.osFileDragReady': {
        // 확장이 확정한 경로를 그대로 되돌려 보낸다. Workbench seam이 이 메시지를 보고 셸 드래그를
        // 시작한다 — 웹뷰가 직접 할 수 없는 일이다.
        if (Array.isArray(msg.paths) && msg.paths.length) {
          post({ type: 'vshoon.osFileDrag', paths: msg.paths });
        }
        break;
      }
      case 'vshoon.osFileDrop': {
        const target = resolveOsDropTarget(msg.position);
        if (!target || !Array.isArray(msg.paths) || !msg.paths.length) break;
        post({ type: 'osFileDrop', pane: target.pane, paths: msg.paths, intoDir: target.intoDir });
        break;
      }
    }
  });

  post({ type: 'ready' });
})();
