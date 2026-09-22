const CONTROL_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'listbox', 'option', 'button']);
const ATTACH_SETTLE_MS = 75;

function valueOf(value) {
  return String(value?.value ?? value ?? '');
}

function property(node, name) {
  return (node.properties || []).find(item => item.name === name)?.value?.value;
}

export function accessibilityControls(nodes = [], sessionId = null) {
  return nodes
    .map(node => {
      const role = valueOf(node.role);
      if (!CONTROL_ROLES.has(role)) return null;
      const name = valueOf(node.name).replace(/\s+/g, ' ').trim();
      return {
        id: String(node.nodeId || ''),
        ...(sessionId ? {sessionId} : {}),
        role,
        name,
        value: valueOf(node.value),
        required: property(node, 'required') === true,
        expanded: property(node, 'expanded'),
        disabled: property(node, 'disabled') === true,
      };
    })
    .filter(Boolean);
}

export function mergeAccessibilityInspection(inspection, controls = []) {
  const byName = new Map();
  for (const control of controls) {
    const key = control.name.toLowerCase();
    if (!key) continue;
    const entries = byName.get(key) || [];
    entries.push(control);
    byName.set(key, entries);
  }
  return {
    ...inspection,
    fields: (inspection.fields || []).map(field => {
      const matches = byName.get(String(field.label || '').toLowerCase()) || [];
      const accessibility = matches.length === 1 ? matches[0] : null;
      return accessibility ? {...field, accessibility} : field;
    }),
    accessibility: {available: true, controls},
  };
}

export function createBrowserController(browser = globalThis.chrome) {
  const attached = new Set();
  const childSessions = new Map();
  const childAttachJobs = new Map();
  const target = tabId => ({tabId});
  let listenersInstalled = false;

  function installListeners() {
    if (!browser?.debugger?.onEvent?.addListener || listenersInstalled) return;
    listenersInstalled = true;
    browser.debugger.onEvent.addListener((source, method, params) => {
      if (method !== 'Target.attachedToTarget' || !attached.has(source.tabId) || !params?.sessionId) return;
      const session = {...source, sessionId: params.sessionId};
      const sessions = childSessions.get(source.tabId) || new Map();
      sessions.set(params.sessionId, session);
      childSessions.set(source.tabId, sessions);
      // Flat sessions must recursively opt into child iframe targets.
      void enableChildFrames(session, true);
    });
    browser.debugger.onDetach?.addListener?.(source => {
      attached.delete(source.tabId);
      childSessions.delete(source.tabId);
      childAttachJobs.delete(source.tabId);
    });
  }

  function enableChildFrames(session, ignoreFailure = false) {
    const work = browser.debugger.sendCommand(session, 'Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{type: 'iframe', exclude: false}],
    });
    const tracked = ignoreFailure ? work.catch(() => {}) : work;
    const jobs = childAttachJobs.get(session.tabId) || new Set();
    jobs.add(tracked);
    childAttachJobs.set(session.tabId, jobs);
    void tracked.finally(() => jobs.delete(tracked)).catch(() => {});
    return tracked;
  }

  async function waitForChildFrames(tabId) {
    const deadline = Date.now() + ATTACH_SETTLE_MS;
    while (Date.now() < deadline) {
      await Promise.all([...((childAttachJobs.get(tabId) || new Set()))]);
      await new Promise(resolve => setTimeout(resolve, Math.min(10, deadline - Date.now())));
    }
  }

  async function attach(tabId) {
    if (!browser?.debugger?.attach || !browser?.debugger?.sendCommand) throw new Error('Browser control is unavailable');
    installListeners();
    if (!attached.has(tabId)) {
      await browser.debugger.attach(target(tabId), '1.3');
      attached.add(tabId);
      childSessions.set(tabId, new Map());
    }
  }

  async function detach(tabId) {
    if (!attached.delete(tabId)) return;
    try { await browser.debugger.detach?.(target(tabId)); } catch { /* Chrome can detach first. */ }
    childSessions.delete(tabId);
    childAttachJobs.delete(tabId);
  }

  async function observe(tabId) {
    try {
      await attach(tabId);
      if (browser?.debugger?.onEvent?.addListener) {
        await enableChildFrames(target(tabId));
        await waitForChildFrames(tabId);
      }
      const sessions = [target(tabId), ...(childSessions.get(tabId)?.values() || [])];
      const trees = await Promise.all(sessions.map(async session => {
        await browser.debugger.sendCommand(session, 'Accessibility.enable');
        const tree = await browser.debugger.sendCommand(session, 'Accessibility.getFullAXTree');
        return accessibilityControls(tree?.nodes, session.sessionId || null);
      }));
      return {ok: true, controls: trees.flat()};
    } catch (error) {
      return {ok: false, code: 'browser_control_unavailable', error: error?.message || 'Browser control is unavailable'};
    } finally {
      await detach(tabId);
    }
  }

  async function click(tabId, rect, frameId = 0) {
    if (frameId !== 0) return {ok: false, code: 'frame_control_unavailable'};
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
      return {ok: false, code: 'invalid_target'};
    }
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    try {
      await attach(tabId);
      await browser.debugger.sendCommand(target(tabId), 'Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1});
      await browser.debugger.sendCommand(target(tabId), 'Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1});
      return {ok: true};
    } catch (error) {
      return {ok: false, code: 'browser_control_unavailable', error: error?.message || 'Browser control is unavailable'};
    } finally {
      await detach(tabId);
    }
  }

  return {observe, click};
}
