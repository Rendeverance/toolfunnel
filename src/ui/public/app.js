'use strict';

/*
 * ToolFunnel management console — vanilla client. Zero dependencies, zero external
 * assets, works offline. Talks to the loopback JSON API served by src/ui/server.js.
 * Every edit is persisted server-side through the gateway's own stores (registry,
 * tool-state, expose-store, hook-loader), so the running MCP server sees changes
 * with no restart.
 *
 * Four tabs — Tools / MCPs / Hooks / Logs. The first three each have a live search box,
 * a collapsible Add form, and a list whose rows carry activate/deactivate + remove controls.
 * Logs is read-mostly: an on/off toggle bound to the logger config plus a newest-first view
 * of recent activity records.
 */

(function () {
  // ── tiny DOM helpers ────────────────────────────────────────────────────────
  var $ = function (sel) { return document.querySelector(sel); };
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] === true) node.setAttribute(k, '');
        else if (attrs[k] != null && attrs[k] !== false) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // ── fetch wrappers ──────────────────────────────────────────────────────────
  function getJson(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (r) { return r.json(); });
  }
  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  // ── toast ─────────────────────────────────────────────────────────────────--
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('#toast');
    t.innerHTML = '';
    t.appendChild(typeof msg === 'string' ? document.createTextNode(msg) : msg);
    t.className = 'toast show' + (kind === 'error' ? ' error' : kind === 'good' ? ' good' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 6000);
  }
  function errText(e) { return e && e.message ? e.message : String(e); }

  // ── status counts ─────────────────────────────────────────────────────────--
  function refreshStatus() {
    return getJson('/api/status').then(function (s) {
      $('#stat-tools').textContent = s && typeof s.tools === 'number' ? s.tools : '0';
      $('#stat-upstreams').textContent = s && typeof s.upstreams === 'number' ? s.upstreams : '0';
      $('#stat-hooks').textContent = s && typeof s.hooks === 'number' ? s.hooks : '0';
    }).catch(function () { /* leave placeholders */ });
  }

  // ── shared controls ─────────────────────────────────────────────────────────
  function makeSwitch(checked, small, onChange) {
    var input = el('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', function () { onChange(input); });
    return el('label', { class: 'switch' + (small ? ' small' : '') }, [input, el('span', { class: 'slider' })]);
  }
  function toggleGroup(label, extraClass, sw) {
    return el('div', { class: 'toggle-group ' + extraClass }, [sw, el('span', { class: 'toggle-label', text: label })]);
  }
  // A small destructive control with an inline confirm guard.
  function removeButton(label, onConfirm) {
    return el('button', {
      class: 'btn-remove', type: 'button', title: 'Remove',
      onclick: function () { if (window.confirm(label)) onConfirm(); },
    }, ['Remove']);
  }
  // POST helper that drives a control disabled/revert/toast lifecycle. `apply` runs on success.
  function driveSwitch(input, url, body, apply, onFail) {
    input.disabled = true;
    postJson(url, body).then(function (res) {
      input.disabled = false;
      if (!res || res.ok !== true) { onFail(); toast((res && res.error) || 'Action failed', 'error'); return; }
      apply(res);
      refreshStatus();
    }).catch(function (e) { input.disabled = false; onFail(); toast('Request failed: ' + errText(e), 'error'); });
  }

  // ── generic filter ───────────────────────────────────────────────────────--
  function filterList(items, query, hayFn) {
    var q = (query || '').trim().toLowerCase();
    if (!q) return items.slice();
    return items.filter(function (it) { return hayFn(it).toLowerCase().indexOf(q) !== -1; });
  }
  // The authored innerHTML of each empty div (the rich "nothing configured" state) is
  // captured once so it can be restored after a "no matches" message overwrote it.
  var emptyOriginal = {};
  function renderInto(listSel, emptySel, countSel, shown, total, renderFn, noMatchText) {
    var list = $(listSel);
    list.innerHTML = '';
    shown.forEach(function (it) { list.appendChild(renderFn(it)); });
    var empty = $(emptySel);
    if (emptyOriginal[emptySel] === undefined) emptyOriginal[emptySel] = empty.innerHTML;
    if (shown.length === 0) {
      empty.hidden = false;
      if (total === 0) empty.innerHTML = emptyOriginal[emptySel]; // nothing configured
      else empty.textContent = noMatchText;                       // filtered to nothing
    } else {
      empty.hidden = true;
    }
    $(countSel).textContent = (shown.length !== total) ? (shown.length + '/' + total) : '';
  }

  // ── collapsible add forms ────────────────────────────────────────────────--
  function wireAddForm(btnSel, formSel, cancelSel, onReset) {
    var btn = $(btnSel), form = $(formSel);
    function open(show) {
      form.hidden = !show;
      btn.setAttribute('aria-expanded', show ? 'true' : 'false');
      btn.classList.toggle('is-open', show);
      if (show) { var f = form.querySelector('input, select, textarea'); if (f) f.focus(); }
    }
    btn.addEventListener('click', function () { open(form.hidden); });
    $(cancelSel).addEventListener('click', function () { onReset(); open(false); });
    return { open: open };
  }

  /* ══════════════════════════════ TOOLS ══════════════════════════════ */
  var tools = [];

  function renderTool(t) {
    var card = el('div', { class: 'row' + (t.enabled ? '' : ' is-disabled') + (t.hot ? ' is-hot' : ''), 'data-id': t.id });

    var head = el('div', { class: 'row-head' }, [
      el('span', { class: 'row-name', text: t.name || t.id }),
      t.category ? el('span', { class: 'chip', text: t.category }) : null,
      el('span', { class: 'row-id', text: t.id }),
    ]);
    var summary = el('p', { class: 'row-summary', text: t.summary || 'No summary.' });

    // Execution-mode toggle (reference ↔ gateway). checked = gateway.
    var modeSwitch = makeSwitch(t.mode === 'gateway', true, function (input) {
      var want = input.checked ? 'gateway' : 'reference';
      driveSwitch(input, '/api/tools/mode', { id: t.id, mode: want },
        function (res) { t.mode = (res && res.mode) || want; modeLabel.textContent = t.mode; },
        function () { input.checked = (t.mode === 'gateway'); });
    });
    var modeLabel = el('span', { class: 'toggle-label mode-label', text: t.mode || 'reference' });
    var modeGroup = el('div', { class: 'toggle-group mode' }, [modeSwitch, modeLabel]);

    // Pre / Post hook gates (POST /api/tools/hook).
    function hookSwitch(eventName, label, current) {
      return toggleGroup(label, 'hook', makeSwitch(current, true, function (input) {
        var want = input.checked;
        driveSwitch(input, '/api/tools/hook', { id: t.id, event: eventName, on: want },
          function (res) {
            if (eventName === 'PreToolUse') t.pre = want; else t.post = want;
            if (want && res.scriptPath) {
              toast(el('span', {}, [label + ' gate enabled for ', el('code', { text: t.id }), '. ', el('code', { text: res.scriptPath })]));
            } else if (want) { toast(label + ' gate enabled for ' + t.id, 'good'); }
            else { toast(label + ' gate removed for ' + t.id, 'good'); }
          },
          function () { input.checked = !want; });
      }));
    }

    // Enable / disable — LEAN visibility (POST /api/tools/state).
    var enableSwitch = makeSwitch(t.enabled, false, function (input) {
      var want = input.checked;
      driveSwitch(input, '/api/tools/state', { id: t.id, enabled: want },
        // A disabled tool is never on the every-turn surface, so refresh the panel (count + warnings)
        // — disabling a hot tool drops it from the surface, re-enabling restores it.
        function () { t.enabled = want; card.classList.toggle('is-disabled', !want); loadSurface(); },
        function () { input.checked = !want; });
    });

    // Hot — promote to the TOP-LEVEL every-turn surface (POST /api/tools/state {hot}). A hot tool is
    // injected into the AI's context every turn AND becomes directly callable. Refresh the surface
    // panel (count + bloat warnings) after a change.
    var hotSwitch = makeSwitch(t.hot, false, function (input) {
      var want = input.checked;
      driveSwitch(input, '/api/tools/state', { id: t.id, hot: want },
        function () { t.hot = want; card.classList.toggle('is-hot', want); loadSurface(); },
        function () { input.checked = !want; });
    });

    // Hidden — declutter THIS manager list only (does not change what the AI sees). Re-filter on
    // change so the row drops out when hidden (unless "show hidden" is on).
    var hiddenSwitch = makeSwitch(t.hidden, false, function (input) {
      var want = input.checked;
      driveSwitch(input, '/api/tools/state', { id: t.id, hidden: want },
        function () { t.hidden = want; applyToolFilter(); },
        function () { input.checked = !want; });
    });

    // Details / edit — a lazy inline panel showing the full entry (instructions, invoke, script body)
    // with editable fields + Save. Fetched from /api/tools/detail on first expand.
    var detailPanel = el('div', { class: 'tool-detail', hidden: true });
    var detailLoaded = false;
    var detailsBtn = el('button', { class: 'btn btn-ghost btn-sm tool-details-btn', type: 'button' }, ['Details / edit']);
    detailsBtn.addEventListener('click', function () {
      var show = detailPanel.hidden;
      detailPanel.hidden = !show;
      detailsBtn.classList.toggle('is-open', show);
      if (show && !detailLoaded) { detailLoaded = true; loadToolDetail(t, detailPanel); }
    });

    var controls = el('div', { class: 'row-controls' }, [
      modeGroup,
      el('div', { class: 'hook-toggles' }, [hookSwitch('PreToolUse', 'Pre', t.pre), hookSwitch('PostToolUse', 'Post', t.post)]),
      toggleGroup('Enabled', 'enable', enableSwitch),
      toggleGroup('Hot', 'hot', hotSwitch),
      toggleGroup('Hidden', 'hidden', hiddenSwitch),
      detailsBtn,
      removeButton('Remove tool "' + t.id + '" from the register?', function () {
        postJson('/api/tools/remove', { id: t.id }).then(function (res) {
          if (!res || res.ok !== true) { toast((res && res.error) || 'Remove failed', 'error'); return; }
          toast('Removed tool ' + t.id, 'good');
          loadTools(); refreshStatus();
        }).catch(function (e) { toast('Request failed: ' + errText(e), 'error'); });
      }),
    ]);

    card.appendChild(head); card.appendChild(summary); card.appendChild(controls); card.appendChild(detailPanel);
    return card;
  }

  // Fetch one tool's full detail and render the editor into `panel`.
  function loadToolDetail(t, panel) {
    panel.innerHTML = '';
    panel.appendChild(el('p', { class: 'muted', text: 'Loading…' }));
    getJson('/api/tools/detail?id=' + encodeURIComponent(t.id)).then(function (res) {
      panel.innerHTML = '';
      if (!res || res.ok !== true || !res.entry) {
        panel.appendChild(el('p', { class: 'muted', text: (res && res.error) || 'Failed to load details.' }));
        return;
      }
      renderToolEditor(t, panel, res.entry, res.scriptText);
    }).catch(function (e) {
      panel.innerHTML = '';
      panel.appendChild(el('p', { class: 'muted', text: 'Failed to load details: ' + errText(e) }));
    });
  }

  // Build the editable detail form for one tool. Save → POST /api/tools/update.
  function renderToolEditor(t, panel, entry, scriptText) {
    var inv = entry.invoke || {};
    function field(label, hint, control) {
      return el('label', { class: 'field field-wide' }, [
        el('span', {}, [label, hint ? el('em', { class: 'hint', text: ' ' + hint }) : null]),
        control,
      ]);
    }
    var fName = el('input', { type: 'text', value: entry.name || '' });
    var fSummary = el('input', { type: 'text', value: entry.summary || '' });
    var fCategory = el('input', { type: 'text', value: entry.category || '' });
    var fMode = el('select', {}, [
      el('option', { value: 'gateway', text: 'gateway — run here' }),
      el('option', { value: 'reference', text: 'reference — AI runs it' }),
    ]);
    fMode.value = (t.mode === 'reference') ? 'reference' : 'gateway';
    var fInstr = el('textarea', { rows: '4', spellcheck: 'false' }); fInstr.value = entry.instructions || '';

    var fType = el('select', {}, [
      el('option', { value: 'script', text: 'script' }),
      el('option', { value: 'shell', text: 'shell' }),
      el('option', { value: 'none', text: 'none (reference)' }),
    ]);
    fType.value = inv.type || 'none';
    var fPath = el('input', { type: 'text', value: inv.path || '', spellcheck: 'false' });
    var fCmd = el('input', { type: 'text', value: inv.command || '', spellcheck: 'false' });
    var fScript = el('textarea', { rows: '8', spellcheck: 'false' }); fScript.value = scriptText || '';

    var pathField = field('script path', '', fPath);
    var cmdField = field('shell command', '', fCmd);
    var scriptField = field('script body', '(authored under tools/scripts/)', fScript);
    function syncInvoke() {
      var ty = fType.value;
      pathField.hidden = ty !== 'script';
      cmdField.hidden = ty !== 'shell';
      scriptField.hidden = ty !== 'script';
    }
    fType.addEventListener('change', syncInvoke);

    var idTag = el('div', { class: 'tool-detail-id' }, [el('span', { class: 'row-id', text: 'id: ' + entry.id })]);
    var grid = el('div', { class: 'field-grid' }, [
      field('name', '', fName),
      field('summary', '', fSummary),
      field('category', '', fCategory),
      field('mode', '', fMode),
      field('invoke type', '', fType),
      pathField, cmdField,
      field('instructions', '', fInstr),
      scriptField,
    ]);

    var saveBtn = el('button', { class: 'btn btn-primary', type: 'button' }, ['Save changes']);
    saveBtn.addEventListener('click', function () {
      var patch = {
        name: fName.value.trim(),
        summary: fSummary.value.trim(),
        category: fCategory.value.trim(),
        instructions: fInstr.value,
        mode: fMode.value,
      };
      var ty = fType.value;
      if (ty === 'script') { patch.invoke = { type: 'script', path: fPath.value.trim() }; }
      else if (ty === 'shell') { patch.invoke = { type: 'shell', command: fCmd.value.trim() }; }
      var body = { id: entry.id, patch: patch };
      if (ty === 'script' && fScript.value.length) body.scriptText = fScript.value;
      saveBtn.disabled = true;
      postJson('/api/tools/update', body).then(function (res) {
        saveBtn.disabled = false;
        if (!res || res.ok !== true) { toast((res && res.error) || 'Save failed', 'error'); return; }
        toast('Saved ' + entry.id, 'good');
        loadTools(); refreshStatus();
      }).catch(function (e) { saveBtn.disabled = false; toast('Request failed: ' + errText(e), 'error'); });
    });

    panel.appendChild(idTag);
    panel.appendChild(grid);
    panel.appendChild(el('div', { class: 'addform-actions' }, [saveBtn]));
    syncInvoke();
  }

  function applyToolFilter() {
    // Hidden tools are decluttered from THIS manager list unless "show hidden" is ticked. (This is the
    // manager view only — `hidden` never affects the lean list / top-level surface the AI sees.)
    var showHidden = $('#show-hidden') && $('#show-hidden').checked;
    var base = showHidden ? tools : tools.filter(function (t) { return !t.hidden; });
    var shown = filterList(base, $('#search-tools').value, function (t) {
      return t.id + ' ' + (t.name || '') + ' ' + (t.summary || '') + ' ' + (t.category || '') + ' ' + (t.mode || '');
    });
    // Distinguish "register empty" (tools.length===0 → renderInto's authored message) from "all
    // hidden" (tools exist but the hidden filter emptied the view) — pass tools.length as `total` so
    // a non-empty register never reads as empty, and give an all-hidden-specific no-match message.
    var noMatch = (base.length === 0 && tools.length > 0)
      ? ('All ' + tools.length + ' tool' + (tools.length === 1 ? '' : 's') + ' are hidden — tick "show hidden" to see them.')
      : 'No tools match your search.';
    renderInto('#tool-list', '#tools-empty', '#count-tools', shown, tools.length, renderTool, noMatch);
  }

  function loadTools() {
    return getJson('/api/tools').then(function (data) {
      tools = Array.isArray(data) ? data : [];
      applyToolFilter();
    }).catch(function (e) {
      $('#tool-list').innerHTML = '';
      $('#tools-empty').hidden = false;
      $('#tools-empty').textContent = 'Failed to load tools: ' + errText(e);
    });
  }

  /* ── Top-level surface panel ─────────────────────────────────────────────────
   * Shows which tools are injected EVERY turn: the 4 meta-tools (default on, each
   * toggleable), the count of promoted tools, and footgun warnings (hiding the
   * management tools / promoting too many = context bloat). Reads /api/surface. */
  function loadSurface() {
    return getJson('/api/surface').then(renderSurface).catch(function () { /* leave last state */ });
  }
  function renderSurface(data) {
    var meta = (data && Array.isArray(data.meta)) ? data.meta : [];
    var metaBox = $('#surface-meta');
    metaBox.innerHTML = '';
    meta.forEach(function (m) {
      var sw = makeSwitch(m.hot, true, function (input) {
        var want = input.checked;
        driveSwitch(input, '/api/tools/state', { id: m.name, hot: want },
          function () { m.hot = want; loadSurface(); },
          function () { input.checked = !want; });
      });
      metaBox.appendChild(el('div', { class: 'surface-meta-item' + (m.hot ? '' : ' is-off') }, [sw, el('code', { text: m.name })]));
    });
    var total = (data && typeof data.promotedTotal === 'number') ? data.promotedTotal : 0;
    var countEl = $('#surface-count');
    countEl.textContent = total ? (total + ' promoted') : 'lean';
    countEl.className = 'surface-count' + (total > 10 ? ' is-bloat' : total ? ' is-some' : '');

    var warnBox = $('#surface-warnings');
    var warnings = (data && Array.isArray(data.warnings)) ? data.warnings : [];
    warnBox.innerHTML = '';
    if (warnings.length) {
      warnings.forEach(function (w) { warnBox.appendChild(el('p', { class: 'surface-warning', text: '⚠ ' + w })); });
      warnBox.hidden = false;
    } else {
      warnBox.hidden = true;
    }
  }

  function resetToolForm() {
    ['#t-id', '#t-name', '#t-category', '#t-summary', '#t-path', '#t-command', '#t-instructions', '#t-scripttext']
      .forEach(function (s) { $(s).value = ''; });
    $('#t-mode').value = 'gateway';
    $('#t-invoke-type').value = 'script';
    syncToolFields();
  }
  // Show/hide invoke fields by mode + invoke type.
  function syncToolFields() {
    var mode = $('#t-mode').value;
    var type = $('#t-invoke-type').value;
    var ref = mode === 'reference';
    $('#t-invoke-type-field').hidden = ref;
    $('#t-path-field').hidden = ref || type !== 'script';
    $('#t-command-field').hidden = ref || type !== 'shell';
    $('#t-script-field').hidden = ref || type !== 'script';
  }

  function submitTool(ev) {
    ev.preventDefault();
    var id = $('#t-id').value.trim(), name = $('#t-name').value.trim();
    if (!id) { toast('Tool id is required', 'error'); return; }
    if (!name) { toast('Tool name is required', 'error'); return; }
    var mode = $('#t-mode').value;
    var entry = { id: id, name: name, mode: mode };
    var v;
    if ((v = $('#t-summary').value.trim())) entry.summary = v;
    if ((v = $('#t-category').value.trim())) entry.category = v;
    if ((v = $('#t-instructions').value.trim())) entry.instructions = v;
    if (mode !== 'reference') {
      var type = $('#t-invoke-type').value;
      if (type === 'script') {
        var path = $('#t-path').value.trim();
        if (!path) { toast('Script path is required for a script invoke', 'error'); return; }
        entry.invoke = { type: 'script', path: path };
        var body = $('#t-scripttext').value;
        if (body && body.length) entry.scriptText = body;
      } else if (type === 'shell') {
        var cmd = $('#t-command').value.trim();
        if (!cmd) { toast('Shell command is required for a shell invoke', 'error'); return; }
        entry.invoke = { type: 'shell', command: cmd };
      }
    }
    var submit = $('#t-submit'); submit.disabled = true;
    postJson('/api/tools/add', { entry: entry }).then(function (res) {
      submit.disabled = false;
      if (!res || res.ok !== true) { toast((res && res.error) || 'Add failed', 'error'); return; }
      toast('Added tool ' + id, 'good');
      resetToolForm(); toolForm.open(false);
      loadTools(); refreshStatus();
    }).catch(function (e) { submit.disabled = false; toast('Request failed: ' + errText(e), 'error'); });
  }

  /* ══════════════════════════════ MCPs ══════════════════════════════ */
  var upstreams = [];
  var exposeByUpstream = {};

  function renderUpstream(u) {
    var exposed = exposeByUpstream[u.id] || [];
    var card = el('div', { class: 'row' + (u.enabled ? '' : ' is-disabled'), 'data-id': u.id });

    var head = el('div', { class: 'row-head' }, [
      el('span', { class: 'row-name mono', text: u.id }),
      el('span', { class: 'badge', text: u.transport || 'stdio' }),
      el('span', { class: 'badge ' + (u.enabled ? 'on' : 'off'), text: u.enabled ? 'enabled' : 'disabled' }),
    ]);
    var cmd = el('p', { class: 'row-cmd', text: [u.command].concat(u.args || []).join(' ') });
    var desc = u.description ? el('p', { class: 'row-summary', text: u.description }) : null;

    var exposedRows = exposed.length
      ? exposed.map(function (e) {
          return el('div', { class: 'exposed-row' }, [
            el('span', { class: 'tool', text: e.tool }),
            el('span', { class: 'arrow', text: '→' }),
            el('span', { class: 'as', text: e.as || (u.id + '_' + e.tool) }),
            e.category ? el('span', { class: 'chip', text: e.category }) : null,
            el('span', { class: 'badge ' + (e.enabled ? 'on' : 'off'), text: e.enabled ? 'on' : 'off' }),
          ]);
        })
      : [el('div', { class: 'exposed-row' }, [el('span', { class: 'none', text: 'No exposed tools.' })])];
    var exposedBlock = el('div', { class: 'exposed' }, [el('p', { class: 'exposed-title', text: 'Exposed tools' })].concat(exposedRows));

    var enableSwitch = makeSwitch(u.enabled, false, function (input) {
      var want = input.checked;
      driveSwitch(input, '/api/mcp/state', { id: u.id, action: want ? 'enable' : 'disable' },
        function () { u.enabled = want; card.classList.toggle('is-disabled', !want); loadMcps(); },
        function () { input.checked = !want; });
    });

    // Discovered-tools area (filled by the Discover button) — a LIVE connect + tools/list, then a
    // per-tool Lean (enabled) + Hot toggle keyed by each tool's SURFACED name (what the gateway reads).
    var discovered = el('div', { class: 'discovered', hidden: true });
    var discoverBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Connect to this upstream and list its tools' }, ['Discover tools']);
    discoverBtn.addEventListener('click', function () {
      discoverBtn.disabled = true;
      var label = discoverBtn.textContent; discoverBtn.textContent = 'Discovering…';
      postJson('/api/mcp/discover', { id: u.id }).then(function (res) {
        discoverBtn.disabled = false; discoverBtn.textContent = label;
        if (!res || res.ok !== true) {
          toast((res && res.error) || 'Discover failed', 'error');
          renderDiscovered(discovered, []);
          discovered.hidden = false;
          return;
        }
        var n = res.tools ? res.tools.length : 0;
        toast(n + ' tool' + (n === 1 ? '' : 's') + ' discovered on ' + u.id, 'good');
        renderDiscovered(discovered, res.tools || []);
        discovered.hidden = false;
      }).catch(function (e) { discoverBtn.disabled = false; discoverBtn.textContent = label; toast('Request failed: ' + errText(e), 'error'); });
    });

    var controls = el('div', { class: 'row-controls' }, [
      toggleGroup('Enabled', 'enable', enableSwitch),
      discoverBtn,
      removeButton('Remove upstream "' + u.id + '" (and its exposed tools)?', function () {
        postJson('/api/mcp/state', { id: u.id, action: 'remove' }).then(function (res) {
          if (!res || res.ok !== true) { toast((res && res.error) || 'Remove failed', 'error'); return; }
          toast('Removed upstream ' + u.id, 'good');
          loadMcps(); refreshStatus();
        }).catch(function (e) { toast('Request failed: ' + errText(e), 'error'); });
      }),
    ]);

    card.appendChild(head);
    if (desc) card.appendChild(desc);
    card.appendChild(cmd);
    card.appendChild(exposedBlock);
    card.appendChild(controls);
    card.appendChild(discovered);
    return card;
  }

  // Render the LIVE-discovered tools of one upstream, each with a Lean (enabled) + Hot toggle keyed
  // by its SURFACED name (an enabled expose `as` else `<upstream>_<tool>`) — the exact key the running
  // gateway reads, so a toggle here is byte-identical to editing tools.state.json.
  function renderDiscovered(container, tools) {
    container.innerHTML = '';
    if (!tools.length) {
      container.appendChild(el('p', { class: 'none', text: 'No tools discovered (the upstream did not connect, or advertises none).' }));
      return;
    }
    container.appendChild(el('p', { class: 'exposed-title', text: 'Discovered tools — curate lean visibility / promote hot' }));
    tools.forEach(function (t) {
      var leanSwitch = makeSwitch(t.enabled, true, function (input) {
        var want = input.checked;
        driveSwitch(input, '/api/tools/state', { id: t.name, enabled: want },
          // Disabling a hot upstream tool drops it from the surface too — refresh the panel.
          function () { t.enabled = want; loadSurface(); }, function () { input.checked = !want; });
      });
      var hotSwitch = makeSwitch(t.hot, true, function (input) {
        var want = input.checked;
        driveSwitch(input, '/api/tools/state', { id: t.name, hot: want },
          function () { t.hot = want; loadSurface(); }, function () { input.checked = !want; });
      });
      container.appendChild(el('div', { class: 'discovered-row' }, [
        el('span', { class: 'tool mono', text: t.tool }),
        el('span', { class: 'arrow', text: '→' }),
        el('span', { class: 'as mono', text: t.name }),
        t.description ? el('span', { class: 'disc-desc', text: t.description }) : null,
        toggleGroup('Lean', 'lean', leanSwitch),
        toggleGroup('Hot', 'hot', hotSwitch),
      ]));
    });
  }

  function applyMcpFilter() {
    var shown = filterList(upstreams, $('#search-mcps').value, function (u) {
      return u.id + ' ' + (u.command || '') + ' ' + (u.args || []).join(' ') + ' ' + (u.description || '');
    });
    renderInto('#mcp-list', '#mcps-empty', '#count-mcps', shown, upstreams.length, renderUpstream, 'No upstreams match your search.');
  }

  function loadMcps() {
    return getJson('/api/upstreams').then(function (data) {
      upstreams = (data && Array.isArray(data.upstreams)) ? data.upstreams : [];
      var expose = (data && Array.isArray(data.expose)) ? data.expose : [];
      exposeByUpstream = {};
      expose.forEach(function (e) { (exposeByUpstream[e.upstream] = exposeByUpstream[e.upstream] || []).push(e); });
      applyMcpFilter();
    }).catch(function (e) {
      $('#mcp-list').innerHTML = '';
      $('#mcps-empty').hidden = false;
      $('#mcps-empty').textContent = 'Failed to load upstreams: ' + errText(e);
    });
  }

  // Dynamic expose-entry rows in the MCP add form.
  function addExposeRow() {
    var row = el('div', { class: 'expose-input-row' }, [
      el('input', { type: 'text', class: 'x-tool', placeholder: 'tool', spellcheck: 'false' }),
      el('input', { type: 'text', class: 'x-as', placeholder: 'as (optional)', spellcheck: 'false' }),
      el('input', { type: 'text', class: 'x-cat', placeholder: 'category', spellcheck: 'false' }),
      el('button', { type: 'button', class: 'btn-remove btn-sm', title: 'Remove row', onclick: function () { row.remove(); } }, ['×']),
    ]);
    $('#m-expose-rows').appendChild(row);
  }
  function collectExpose() {
    var out = [];
    $('#m-expose-rows').querySelectorAll('.expose-input-row').forEach(function (r) {
      var tool = r.querySelector('.x-tool').value.trim();
      if (!tool) return;
      var item = { tool: tool };
      var as = r.querySelector('.x-as').value.trim(); if (as) item.as = as;
      var cat = r.querySelector('.x-cat').value.trim(); if (cat) item.category = cat;
      out.push(item);
    });
    return out;
  }
  function resetMcpForm() {
    ['#m-id', '#m-command', '#m-args', '#m-description'].forEach(function (s) { $(s).value = ''; });
    $('#m-transport').value = 'stdio';
    $('#m-expose-rows').innerHTML = '';
  }

  function submitMcp(ev) {
    ev.preventDefault();
    var id = $('#m-id').value.trim(), command = $('#m-command').value.trim();
    if (!id) { toast('Upstream id is required', 'error'); return; }
    if (!command) { toast('Command is required', 'error'); return; }
    var argsRaw = $('#m-args').value.trim();
    var upstream = { id: id, command: command, transport: $('#m-transport').value || 'stdio' };
    if (argsRaw) upstream.args = argsRaw.split(/\s+/);
    var desc = $('#m-description').value.trim(); if (desc) upstream.description = desc;
    var payload = { upstream: upstream };
    var expose = collectExpose();
    if (expose.length) payload.expose = expose;
    var submit = $('#m-submit'); submit.disabled = true;
    postJson('/api/mcp/add', payload).then(function (res) {
      submit.disabled = false;
      if (!res || res.ok !== true) { toast((res && res.error) || 'Add failed', 'error'); return; }
      toast('Added upstream ' + id, 'good');
      resetMcpForm(); mcpForm.open(false);
      loadMcps(); refreshStatus();
    }).catch(function (e) { submit.disabled = false; toast('Request failed: ' + errText(e), 'error'); });
  }

  /* ══════════════════════════════ HOOKS ══════════════════════════════ */
  var EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact'];
  var hooks = [];

  function renderHook(h) {
    var hasId = !!h.id;
    var card = el('div', { class: 'row' + (h.enabled ? '' : ' is-disabled'), 'data-id': h.id || '' });

    var head = el('div', { class: 'row-head' }, [
      el('span', { class: 'row-name mono', text: h.id || '(tool gate)' }),
      el('span', { class: 'chip', text: h.event || '?' }),
      hasId ? null : el('span', { class: 'badge', text: 'auto' }),
    ]);
    var meta = el('p', { class: 'row-cmd', text: 'matcher: ' + (h.matcher && h.matcher.length ? h.matcher : '* (all)') });
    var desc = h.description ? el('p', { class: 'row-summary', text: h.description }) : null;

    var controls;
    if (hasId) {
      var enableSwitch = makeSwitch(h.enabled, false, function (input) {
        var want = input.checked;
        driveSwitch(input, '/api/hooks/state', { id: h.id, action: want ? 'enable' : 'disable' },
          function () { h.enabled = want; card.classList.toggle('is-disabled', !want); },
          function () { input.checked = !want; });
      });
      controls = el('div', { class: 'row-controls' }, [
        toggleGroup('Enabled', 'enable', enableSwitch),
        removeButton('Remove hook "' + h.id + '"? (its script file is left in place)', function () {
          postJson('/api/hooks/state', { id: h.id, action: 'remove' }).then(function (res) {
            if (!res || res.ok !== true) { toast((res && res.error) || 'Remove failed', 'error'); return; }
            toast('Removed hook ' + h.id, 'good');
            loadHooks(); refreshStatus();
          }).catch(function (e) { toast('Request failed: ' + errText(e), 'error'); });
        }),
      ]);
    } else {
      // Tool Pre/Post gate (no id) — managed from the Tools tab; show state read-only.
      controls = el('div', { class: 'row-controls' }, [
        el('span', { class: 'badge ' + (h.enabled ? 'on' : 'off'), text: h.enabled ? 'enabled' : 'disabled' }),
        el('span', { class: 'managed-note', text: 'managed on Tools tab' }),
      ]);
    }

    card.appendChild(head);
    if (desc) card.appendChild(desc);
    card.appendChild(meta);
    card.appendChild(controls);
    return card;
  }

  function applyHookFilter() {
    var shown = filterList(hooks, $('#search-hooks').value, function (h) {
      return (h.id || '') + ' ' + (h.event || '') + ' ' + (h.matcher || '') + ' ' + (h.description || '');
    });
    renderInto('#hook-list', '#hooks-empty', '#count-hooks', shown, hooks.length, renderHook, 'No hooks match your search.');
  }

  function loadHooks() {
    return getJson('/api/hooks').then(function (data) {
      hooks = (data && Array.isArray(data.hooks)) ? data.hooks : [];
      applyHookFilter();
    }).catch(function (e) {
      $('#hook-list').innerHTML = '';
      $('#hooks-empty').hidden = false;
      $('#hooks-empty').textContent = 'Failed to load hooks: ' + errText(e);
    });
  }

  function resetHookForm() {
    ['#h-id', '#h-matcher', '#h-command', '#h-scripttext'].forEach(function (s) { $(s).value = ''; });
    $('#h-event').value = EVENTS[2]; // PreToolUse default
  }

  function submitHook(ev) {
    ev.preventDefault();
    var id = $('#h-id').value.trim(), command = $('#h-command').value.trim();
    if (!id) { toast('Hook id is required', 'error'); return; }
    if (!command) { toast('Command is required', 'error'); return; }
    var entry = { id: id, event: $('#h-event').value, command: command };
    var matcher = $('#h-matcher').value.trim(); if (matcher) entry.matcher = matcher;
    var body = $('#h-scripttext').value; if (body && body.length) entry.scriptText = body;
    var submit = $('#h-submit'); submit.disabled = true;
    postJson('/api/hooks/add', { entry: entry }).then(function (res) {
      submit.disabled = false;
      if (!res || res.ok !== true) { toast((res && res.error) || 'Add failed', 'error'); return; }
      toast('Added hook ' + id + ' (disabled — enable it to fire)', 'good');
      resetHookForm(); hookForm.open(false);
      loadHooks(); refreshStatus();
    }).catch(function (e) { submit.disabled = false; toast('Request failed: ' + errText(e), 'error'); });
  }

  /* ══════════════════════════════ LOGS ══════════════════════════════ */
  // The activity log is a toggleable JSONL store (DEFAULT OFF). This tab binds an on/off
  // switch to /api/logs/config and shows the most recent records newest-first.
  var logConfig = { enabled: false, path: '' };
  var logEntries = [];

  // Reflect the current config in the switch, status word, and (when on) the log path.
  function updateLogStatus() {
    $('#log-enabled').checked = !!logConfig.enabled;
    var status = $('#log-status');
    status.textContent = logConfig.enabled ? 'logging is on' : 'logging is off';
    status.className = 'log-status' + (logConfig.enabled ? ' on' : '');
    $('#log-path').textContent = (logConfig.enabled && logConfig.path) ? logConfig.path : '';
  }

  function loadLogConfig() {
    return getJson('/api/logs/config').then(function (cfg) {
      logConfig = {
        enabled: !!(cfg && cfg.enabled),
        path: (cfg && typeof cfg.path === 'string') ? cfg.path : '',
      };
      updateLogStatus();
    }).catch(function () {
      logConfig = { enabled: false, path: '' };
      updateLogStatus();
    });
  }

  // Classify a record for its small type badge. The gateway emits type:'gate' / type:'tool';
  // fall back defensively (a record carrying a `decision` is a gate, else a tool).
  function logKind(e) {
    var t = e && e.type;
    if (t === 'gate' || t === 'tool' || t === 'config' || t === 'auth' || t === 'client' || t === 'mcp') return t;
    if (e && e.decision != null) return 'gate';
    if (e && (e.tool || e.ok != null)) return 'tool';
    return 'event';
  }
  // The status word + tone per kind: gate → allow/deny, tool → ok/fail (blocked counts as fail).
  function logStatusOf(e, kind) {
    if (kind === 'gate') {
      var d = (e && e.decision) || '?';
      return { text: d, tone: d === 'deny' ? 'bad' : (d === 'allow' ? 'good' : '') };
    }
    if (kind === 'auth') {
      var ev = (e && e.event) || '?';
      return { text: ev, tone: ev === 'deny' ? 'bad' : (ev === 'allow' ? 'good' : '') };
    }
    if (kind === 'tool') {
      if (e && e.blocked === true) return { text: 'blocked', tone: 'bad' };
      if (e && e.ok === true) return { text: 'ok', tone: 'good' };
      if (e && e.ok === false) return { text: 'fail', tone: 'bad' };
      return { text: 'run', tone: '' };
    }
    // config / client / mcp / event — show the event name, neutral tone
    return { text: (e && e.event) || kind, tone: '' };
  }

  function renderLogEntry(e) {
    var kind = logKind(e);
    var st = logStatusOf(e, kind);
    var name = (e && (e.tool || e.name || e.id || e.client || e.path)) || '—';

    var head = el('div', { class: 'log-head' }, [
      el('span', { class: 'log-badge ' + kind, text: kind }),
      el('span', { class: 'log-name mono', text: name }),
      el('span', { class: 'badge ' + (st.tone === 'good' ? 'on' : st.tone === 'bad' ? 'bad' : 'off'), text: st.text }),
      el('span', { class: 'log-ts', text: (e && e.ts) || '' }),
    ]);

    // Secondary line: the most useful remaining field(s) for the kind.
    var detailText = '';
    if (kind === 'gate') {
      if (e && e.reason) detailText = String(e.reason);
    } else if (kind === 'tool') {
      var bits = [];
      if (e && e.mode) bits.push('mode: ' + e.mode);
      if (e && typeof e.durationMs === 'number') bits.push(e.durationMs + ' ms');
      detailText = bits.join('  ·  ');
    } else if (kind === 'auth') {
      var ab = [];
      if (e && e.error) ab.push(String(e.error));
      if (e && e.status) ab.push('HTTP ' + e.status);
      if (e && e.path) ab.push(e.path);
      detailText = ab.join('  ·  ');
    } else if (kind === 'config') {
      var cb = [];
      ['enabled', 'hidden', 'hot', 'action', 'mode', 'on', 'hook', 'issuer'].forEach(function (k) {
        if (e && e[k] !== undefined) cb.push(k + ': ' + e[k]);
      });
      if (e && e.via) cb.push('via ' + e.via);
      detailText = cb.join('  ·  ');
    } else {
      var eb = [];
      ['client', 'protocolVersion'].forEach(function (k) { if (e && e[k] !== undefined) eb.push(k + ': ' + e[k]); });
      detailText = eb.join('  ·  ');
    }

    var card = el('div', { class: 'row log-row' }, [head]);
    if (detailText) card.appendChild(el('p', { class: 'log-detail', text: detailText }));
    return card;
  }

  function renderLogEntries() {
    var list = $('#log-list');
    list.innerHTML = '';
    // Newest first — tail() returns file order (oldest→newest), so reverse for display.
    var rows = logEntries.slice().reverse();
    rows.forEach(function (e) { list.appendChild(renderLogEntry(e)); });
    var empty = $('#logs-empty');
    if (rows.length === 0) {
      empty.hidden = false;
      empty.innerHTML = '';
      if (!logConfig.enabled) {
        empty.appendChild(el('p', {}, ['Logging is off.']));
        empty.appendChild(el('p', { class: 'muted' }, ['Flip the switch above to start recording gate decisions and tool runs.']));
      } else {
        empty.appendChild(el('p', {}, ['No entries yet.']));
        empty.appendChild(el('p', { class: 'muted' }, ['Gate decisions and tool runs will appear here once activity is logged.']));
      }
    } else {
      empty.hidden = true;
    }
    $('#count-logs').textContent = rows.length ? String(rows.length) : '';
  }

  function loadLogEntries() {
    return getJson('/api/logs').then(function (data) {
      logEntries = (data && Array.isArray(data.entries)) ? data.entries : [];
      renderLogEntries();
    }).catch(function (e) {
      $('#log-list').innerHTML = '';
      logEntries = [];
      $('#logs-empty').hidden = false;
      $('#logs-empty').innerHTML = '';
      $('#logs-empty').appendChild(el('p', {}, ['Failed to load logs: ' + errText(e)]));
    });
  }

  function loadLogs() { return loadLogConfig().then(loadLogEntries); }

  /* ══════════════════════════════ AUTH (OAuth 2.1) ══════════════════════════════ */
  // Opt-in OAuth: the panel shows the optional jose dependency's install state + an Install button,
  // and an enable+config form. Reads /api/auth; writes /api/auth/config and /api/oauth/install. The
  // core gateway stays zero-dependency — jose is fetched only if the operator chooses to.
  var authState = { config: { enabled: false }, joseInstalled: false, josePin: 'jose', configError: null, ready: true };

  function renderAuth() {
    var c = authState.config || {};
    $('#auth-josepin').textContent = 'jose@' + (authState.josePin || '');

    // Dependency state + Install button.
    var depState = $('#auth-dep-state');
    var installBtn = $('#auth-install-btn');
    if (authState.joseInstalled) {
      depState.textContent = '✓ jose@' + (authState.josePin || '') + ' installed — OAuth is available';
      depState.className = 'auth-dep-state is-good';
      installBtn.hidden = true;
    } else {
      depState.textContent = '○ OAuth dependency not installed — the core gateway is zero-dependency until you add it';
      depState.className = 'auth-dep-state is-off';
      installBtn.hidden = false;
    }

    // Form fields.
    $('#auth-enabled').checked = !!c.enabled;
    $('#auth-issuer').value = c.issuer || '';
    $('#auth-audience').value = c.audience || '';
    $('#auth-jwksuri').value = c.jwksUri || '';
    $('#auth-algorithms').value = (Array.isArray(c.algorithms) ? c.algorithms : []).join(', ');
    $('#auth-scopes').value = (Array.isArray(c.requiredScopes) ? c.requiredScopes : []).join(', ');
    $('#auth-clock').value = (typeof c.clockToleranceSec === 'number') ? c.clockToleranceSec : '';

    // Ready / misconfigured badge — only meaningful when auth is enabled.
    var badge = $('#auth-ready-badge');
    if (c.enabled && !authState.ready) {
      badge.hidden = false;
      badge.className = 'auth-ready-badge is-bad';
      badge.textContent = '⚠ ' + (authState.configError || 'not ready — the HTTP host will refuse to start');
    } else if (c.enabled && authState.ready) {
      badge.hidden = false;
      badge.className = 'auth-ready-badge is-good';
      badge.textContent = '✓ active';
    } else {
      badge.hidden = true;
    }
  }

  function loadAuth() {
    return getJson('/api/auth').then(function (data) {
      authState = {
        config: (data && data.config) || { enabled: false },
        joseInstalled: !!(data && data.joseInstalled),
        josePin: (data && data.josePin) || '',
        configError: (data && data.configError) || null,
        ready: !(data && data.ready === false),
      };
      renderAuth();
    }).catch(function (e) {
      $('#auth-dep-state').textContent = 'Failed to load auth status: ' + errText(e);
    });
  }

  // Parse a comma/space-separated field into a trimmed, non-empty string array.
  function splitList(v) {
    return (v || '').split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function submitAuth(ev) {
    ev.preventDefault();
    var patch = {
      enabled: $('#auth-enabled').checked,
      issuer: $('#auth-issuer').value.trim(),
      audience: $('#auth-audience').value.trim(),
      jwksUri: $('#auth-jwksuri').value.trim(),
      algorithms: splitList($('#auth-algorithms').value),
      requiredScopes: splitList($('#auth-scopes').value),
    };
    var clock = parseInt($('#auth-clock').value, 10);
    if (!isNaN(clock) && clock >= 0) patch.clockToleranceSec = clock;

    var btn = $('#auth-save'); btn.disabled = true;
    postJson('/api/auth/config', patch).then(function (res) {
      btn.disabled = false;
      if (!res || res.ok !== true) { toast((res && res.error) || 'Save failed', 'error'); return; }
      toast(patch.enabled ? 'OAuth config saved — auth enabled' : 'OAuth config saved', 'good');
      // Refresh from the server so the ready/misconfigured badge reflects the persisted state.
      loadAuth();
    }).catch(function (e) { btn.disabled = false; toast('Request failed: ' + errText(e), 'error'); });
  }

  function installOauth() {
    var btn = $('#auth-install-btn');
    var logBox = $('#auth-install-log');
    btn.disabled = true;
    var label = btn.textContent; btn.textContent = 'Installing…';
    logBox.hidden = false; logBox.textContent = 'Running npm install jose@' + (authState.josePin || '') + ' …';
    postJson('/api/oauth/install', {}).then(function (res) {
      btn.disabled = false; btn.textContent = label;
      var out = (res && (res.stderr || res.stdout)) || (res && res.message) || '';
      logBox.textContent = (res && res.message ? res.message + '\n\n' : '') + out;
      if (res && res.ok) {
        toast('OAuth dependency installed — you can enable auth now', 'good');
        loadAuth();
      } else {
        toast((res && res.message) || 'Install failed', 'error');
      }
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = label;
      logBox.textContent = 'Install request failed: ' + errText(e);
      toast('Install failed: ' + errText(e), 'error');
    });
  }

  /* ══════════════════════════════ tabs + wiring ══════════════════════════════ */
  var loaded = { mcps: false, hooks: false, logs: false, auth: false };
  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-tab') === name); });
    $('#view-tools').classList.toggle('is-active', name === 'tools');
    $('#view-mcps').classList.toggle('is-active', name === 'mcps');
    $('#view-hooks').classList.toggle('is-active', name === 'hooks');
    $('#view-logs').classList.toggle('is-active', name === 'logs');
    $('#view-auth').classList.toggle('is-active', name === 'auth');
    if (name === 'mcps' && !loaded.mcps) { loaded.mcps = true; loadMcps(); }
    if (name === 'hooks' && !loaded.hooks) { loaded.hooks = true; loadHooks(); }
    if (name === 'logs' && !loaded.logs) { loaded.logs = true; loadLogs(); }
    if (name === 'auth' && !loaded.auth) { loaded.auth = true; loadAuth(); }
  }

  // Populate the hook event dropdown.
  EVENTS.forEach(function (e) { $('#h-event').appendChild(el('option', { value: e, text: e })); });
  $('#h-event').value = EVENTS[2];

  document.querySelectorAll('.tab').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });

  // Search inputs.
  $('#search-tools').addEventListener('input', applyToolFilter);
  $('#show-hidden').addEventListener('change', applyToolFilter);
  $('#search-mcps').addEventListener('input', applyMcpFilter);
  $('#search-hooks').addEventListener('input', applyHookFilter);

  // Add forms.
  var toolForm = wireAddForm('#addbtn-tools', '#addform-tools', '#t-cancel', resetToolForm);
  var mcpForm = wireAddForm('#addbtn-mcps', '#addform-mcps', '#m-cancel', resetMcpForm);
  var hookForm = wireAddForm('#addbtn-hooks', '#addform-hooks', '#h-cancel', resetHookForm);

  $('#addform-tools').addEventListener('submit', submitTool);
  $('#addform-mcps').addEventListener('submit', submitMcp);
  $('#addform-hooks').addEventListener('submit', submitHook);
  $('#t-mode').addEventListener('change', syncToolFields);
  $('#t-invoke-type').addEventListener('change', syncToolFields);
  $('#m-add-expose').addEventListener('click', addExposeRow);
  syncToolFields();

  // Logs: bind the on/off switch to the config, and a manual refresh.
  $('#log-enabled').addEventListener('change', function () {
    var input = $('#log-enabled');
    var want = input.checked;
    driveSwitch(input, '/api/logs/config', { enabled: want },
      function (res) {
        if (res && res.config) {
          logConfig = { enabled: !!res.config.enabled, path: res.config.path || logConfig.path };
        } else {
          logConfig.enabled = want;
        }
        updateLogStatus();
        loadLogEntries();
      },
      function () { input.checked = !want; });
  });
  $('#logs-refresh').addEventListener('click', loadLogs);

  // Auth: the install button + the config form.
  $('#auth-install-btn').addEventListener('click', installOauth);
  $('#auth-form').addEventListener('submit', submitAuth);

  // Pre-seed the authored empty-state HTML BEFORE any load runs, so a first-load FAILURE (whose catch
  // writes error text straight into the empty div, bypassing renderInto) can't get cached by a later
  // renderInto as the canonical "nothing configured" message.
  ['#tools-empty', '#mcps-empty', '#hooks-empty', '#logs-empty'].forEach(function (sel) {
    var node = $(sel);
    if (node && emptyOriginal[sel] === undefined) emptyOriginal[sel] = node.innerHTML;
  });

  // Boot.
  refreshStatus();
  loadTools();
  loadSurface();
})();
