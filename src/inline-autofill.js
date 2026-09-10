export function createInlineAutofill(document, {send, describe}) {
  const view = document.defaultView;
  let host, shadow, dialog, list, preview, status, use, generate, edit, hint;
  let target = null, snapshot = null, sessionId = null, requestId = null;
  let answers = [], index = -1, epoch = 0, acceptance = null;
  let loading = false, retry = false, composing = false, disposed = false, restoringFocus = false;
  let positionFrame = null, mutationObserver = null, resizeObserver = null;
  const listeners = [];
  const requestFrame = callback => view.requestAnimationFrame ? view.requestAnimationFrame(callback) : view.setTimeout(callback, 0);
  const cancelFrame = id => view.cancelAnimationFrame ? view.cancelAnimationFrame(id) : view.clearTimeout(id);
  const uniqueId = () => view.crypto.randomUUID();
  const message = payload => { try { return Promise.resolve(send(payload)); } catch (error) { return Promise.reject(error); } };

  function eligible(element) {
    if (!element?.isConnected || element.getRootNode() !== document
      || !((element.tagName === 'INPUT' && ['text', 'email', 'tel', 'url'].includes(element.type)) || element.tagName === 'TEXTAREA')) return null;
    const field = describe(document, element);
    return field && !field.widget && !field.multiple && ['text', 'textarea', 'email', 'tel', 'url'].includes(field.type) ? field : null;
  }
  function fingerprint(field) {
    if (!field) return null;
    return JSON.stringify([field.id, field.handle, field.rawValue, field.editRevision, field.label, field.type,
      field.options || [], field.constraints || {}, Boolean(field.multiple), field.widget || null]);
  }
  function activeField() {
    if (document.activeElement === host && !host.hidden && eligible(target)) return target;
    return eligible(document.activeElement) ? document.activeElement : null;
  }
  function isCurrent(version, element, expected) {
    return !disposed && epoch === version && target === element && activeField() === element
      && fingerprint(eligible(element)) === expected;
  }
  function listen(node, type, handler, options) {
    node?.addEventListener(type, handler, options);
    if (node) listeners.push(() => node.removeEventListener(type, handler, options));
  }
  function node(tag, text, attributes = {}) {
    const element = document.createElement(tag);
    if (text != null) element.textContent = text;
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  }
  function button(text, action) {
    const element = node('button', text, {type: 'button', tabindex: '-1'});
    element.addEventListener('click', action);
    return element;
  }
  function mount() {
    if (host) return;
    host = node('div', null, {'data-job-inline-autofill': ''});
    host.hidden = true;
    // A sibling of body also stays outside malformed pages whose body is a form.
    document.documentElement.append(host);
    shadow = host.attachShadow({mode: 'open'});
    shadow.append(node('style', `
      :host { all: initial; position: fixed; z-index: 2147483647; color-scheme: dark; }
      :host([hidden]) { display: none !important; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      [role=dialog] { max-height: inherit; overflow: auto; padding: 12px; border: 1px solid #344354;
        border-radius: 8px; background: #10161d; color: #f4f7fb; box-shadow: 0 10px 24px #0005;
        font: 13px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; }
      p { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
      [role=option] { padding: 8px; margin: 4px 0; border: 1px solid #202b37; border-radius: 5px; cursor: pointer; }
      [aria-selected=true] { border-color: #f5a000; background: #f5a00012; }
      [data-preview] { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; }
      button { padding: 6px 9px; margin: 4px 4px 0 0; border: 1px solid #344354; border-radius: 5px;
        color: #f4f7fb; background: #161e27; font: inherit; cursor: pointer; }
      button:disabled { opacity: .5; cursor: default; }
      :focus-visible { outline: 2px solid #ffb21a; outline-offset: 2px; }
      [role=status], small { display: block; color: #9aa7b7; margin-top: 8px; }
    `));
    dialog = node('section', null, {role: 'dialog', 'aria-label': 'Application answer suggestions'});
    list = node('div', null, {role: 'listbox', 'aria-label': 'Saved answers', tabindex: '-1'});
    preview = node('div', null, {'data-preview': ''});
    use = button('Use and save reviewed answer', accept);
    generate = button('Generate answer', generateAnswer);
    edit = button('Edit in panel', editInPanel);
    const close = button('Close', () => dismiss({returnFocus: true}));
    status = node('div', '', {role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true'});
    hint = node('small', 'Arrow keys choose an answer; Tab uses the selection. Alt+ArrowDown enters controls. Escape closes.');
    dialog.append(list, preview, use, generate, edit, close, hint, status);
    shadow.append(dialog);
  }
  function controlsMode(enabled) {
    for (const element of shadow.querySelectorAll('button, [role="listbox"]')) element.tabIndex = enabled ? 0 : -1;
  }
  function setStatus(text) { status.textContent = text; schedulePosition(); }
  function provenance(answer) {
    return answer.kind === 'generated' ? `Draft · Evidence: ${(answer.evidenceKeys || []).join(', ') || 'No candidate facts cited'}`
      : `Source: ${answer.sourceQuestion || 'Reviewed answer'} · ${answer.kind || 'saved'}`;
  }
  function render() {
    const kept = snapshot?.rawValue !== '';
    list.hidden = preview.hidden = generate.hidden = edit.hidden = hint.hidden = kept;
    list.replaceChildren();
    list.removeAttribute('aria-activedescendant');
    answers.forEach((answer, answerIndex) => {
      const option = node('div', null, {role: 'option', id: `inline-answer-${answerIndex}`, 'aria-selected': String(index === answerIndex)});
      option.append(node('p', String(answer.answer ?? '')), node('small', provenance(answer)));
      option.addEventListener('click', () => select(answerIndex));
      list.append(option);
    });
    updateSelection();
    generate.disabled = loading || !sessionId || snapshot?.rawValue !== '';
    edit.disabled = loading || !sessionId;
    schedulePosition();
  }
  function updateSelection() {
    [...list.children].forEach((option, optionIndex) => option.setAttribute('aria-selected', String(index === optionIndex)));
    const answer = answers[index];
    preview.textContent = answer ? `${answer.answer}\n${provenance(answer)}\n${answer.requiresApproval === false ? 'Review this draft before use.' : 'Using this answer also saves it as a reviewed answer.'}` : '';
    if (answer) list.setAttribute('aria-activedescendant', `inline-answer-${index}`);
    else list.removeAttribute('aria-activedescendant');
    use.textContent = answer?.requiresApproval === false ? 'Use draft' : 'Use and save reviewed answer';
    use.disabled = loading || !answer;
    use.hidden = !answer;
    schedulePosition();
  }
  function select(next) {
    if (loading || !answers.length || !isCurrent(epoch, target, fingerprint(snapshot))) return;
    index = (next + answers.length) % answers.length;
    updateSelection();
    setStatus(`Answer ${index + 1} of ${answers.length}. ${preview.textContent}`);
  }
  function cancelSession(id = sessionId, request = requestId) {
    if (id && request) message({type: 'JOB_INLINE_CANCEL', sessionId: id, requestId: request}).catch(() => {});
  }
  function stopObserving() {
    mutationObserver?.disconnect(); resizeObserver?.disconnect();
    mutationObserver = resizeObserver = null;
    if (positionFrame !== null) { cancelFrame(positionFrame); positionFrame = null; }
  }
  function dismiss({retainSession = false, returnFocus = false} = {}) {
    const previous = target;
    const popupFocused = host && document.activeElement === host;
    acceptance = null; epoch++;
    delete document.__jobApplicationInlineFocusAnchor;
    if (!retainSession) cancelSession();
    sessionId = requestId = null;
    target = snapshot = null; answers = []; index = -1; loading = false; retry = false;
    stopObserving();
    if (host) { host.hidden = true; controlsMode(false); }
    if ((returnFocus || popupFocused) && previous?.isConnected) {
      restoringFocus = true; previous.focus({preventScroll: true}); restoringFocus = false;
    }
  }
  function observe() {
    stopObserving();
    mutationObserver = new view.MutationObserver(() => {
      if (!eligible(target) || !host.isConnected) dismiss();
      else schedulePosition();
    });
    // Observe only the open anchor and its ancestor chain, not every page subtree.
    mutationObserver.observe(target, {attributes: true});
    for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) mutationObserver.observe(ancestor, {childList: true});
    if (view.ResizeObserver) { resizeObserver = new view.ResizeObserver(schedulePosition); resizeObserver.observe(target); }
    schedulePosition();
  }
  function schedulePosition() {
    if (!target || !host || host.hidden || positionFrame !== null) return;
    positionFrame = requestFrame(() => { positionFrame = null; position(); });
  }
  function position() {
    if (!target?.isConnected || !host?.isConnected) { dismiss(); return; }
    const rect = target.getBoundingClientRect();
    const viewport = view.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || view.innerWidth, height = viewport?.height || view.innerHeight;
    const popupWidth = Math.min(380, Math.max(280, rect.width), Math.max(0, width - 16));
    const below = Math.max(0, topEdge + height - rect.bottom - 14);
    const above = Math.max(0, rect.top - topEdge - 14);
    const desiredHeight = Math.min(360, dialog.scrollHeight || 300);
    const flip = below < desiredHeight && above > below;
    const popupHeight = Math.min(desiredHeight, flip ? above : below, Math.max(0, height - 16));
    host.style.width = `${popupWidth}px`;
    host.style.maxHeight = `${popupHeight}px`;
    host.style.left = `${Math.max(leftEdge + 8, Math.min(rect.left, leftEdge + width - popupWidth - 8))}px`;
    host.style.top = `${Math.max(topEdge + 8, Math.min(flip ? rect.top - popupHeight - 6 : rect.bottom + 6, topEdge + height - popupHeight - 8))}px`;
  }
  function show(element, field) {
    dismiss();
    mount();
    target = element; snapshot = field; host.hidden = false; controlsMode(false); observe();
    if (field.rawValue !== '') {
      render(); setStatus('Your answer is kept. Clear the field to choose a suggestion.'); return;
    }
    loading = true; requestId = uniqueId();
    const version = epoch, expected = fingerprint(field), request = requestId;
    render(); setStatus('Finding saved answers…');
    message({type: 'JOB_INLINE_QUERY', fieldId: field.id, handle: field.handle, requestId: request}).then(response => {
      if (!isCurrent(version, element, expected)) {
        if (response?.sessionId) cancelSession(response.sessionId, request);
        return;
      }
      if (!response?.ok || !response.sessionId) throw new Error(response?.error || 'Saved answers are unavailable. Click the field to retry.');
      if (response.requestId !== request) throw new Error('Saved answers changed. Click the field to retry.');
      sessionId = response.sessionId; answers = (response.candidates || []).slice(0, 3); index = -1; loading = false;
      render(); setStatus(response.error || (answers.length ? 'Choose an answer to review before using it.' : 'No saved answers. Generate an answer or edit in panel.'));
    }).catch(error => {
      if (!isCurrent(version, element, expected)) return;
      loading = false; retry = true; render(); setStatus(error.message);
    });
  }
  function activate(element) {
    if (disposed || composing || restoringFocus) return;
    if (element === host) return;
    const field = eligible(element);
    if (!field) { dismiss(); return; }
    if (target === element && !host?.hidden && fingerprint(field) === fingerprint(snapshot) && !retry) return;
    show(element, field);
  }
  function accept() {
    const answer = answers[index];
    if (loading || !answer || !sessionId || !isCurrent(epoch, target, fingerprint(snapshot)) || snapshot.rawValue !== '') return;
    const token = uniqueId(), version = epoch, element = target;
    acceptance = {token, element, expected: fingerprint(snapshot), answer: String(answer.answer), sessionId, candidateId: answer.candidateId};
    // Return focus before disabling/hiding the activated popup button.
    restoringFocus = true; element.focus({preventScroll: true}); restoringFocus = false;
    controlsMode(false);
    if (!isCurrent(version, element, fingerprint(snapshot))) { acceptance = null; return; }
    loading = true; requestId = uniqueId();
    const request = requestId;
    index = -1; render(); setStatus('Applying reviewed answer… Tab again to move on and cancel the pending write.');
    message({type: 'JOB_INLINE_ACCEPT', sessionId, requestId: request, candidateId: answer.candidateId, acceptanceToken: token}).then(response => {
      if (epoch !== version || target !== element) return;
      acceptance = null;
      if (!response?.ok) throw new Error(response?.error || 'The answer could not be applied. Click the field to retry.');
      dismiss();
    }).catch(error => {
      if (epoch !== version || target !== element) return;
      acceptance = null; loading = false;
      const busy = /Fill is in progress|Application is busy/i.test(error.message);
      retry = !busy;
      if (busy) index = answers.indexOf(answer);
      else answers = [];
      render(); setStatus(error.message);
    });
  }
  function beforeFill({field, element, decision, acceptanceToken} = {}) {
    if (acceptanceToken === undefined) return true;
    if (!acceptance || acceptance.token !== acceptanceToken) return false;
    const pending = acceptance;
    acceptance = null;
    return pending.element === element && activeField() === element && target === element && sessionId === pending.sessionId
      && fingerprint(eligible(element)) === pending.expected && fingerprint(field) === pending.expected
      && decision?.fieldId === field.id && String(decision.value) === pending.answer;
  }
  function generateAnswer() {
    if (loading || !sessionId || !isCurrent(epoch, target, fingerprint(snapshot)) || snapshot.rawValue !== '') return;
    const version = epoch, element = target, expected = fingerprint(snapshot), session = sessionId, selected = index;
    loading = true; index = -1; requestId = uniqueId(); const request = requestId;
    render(); setStatus('Generating an answer…');
    message({type: 'JOB_INLINE_GENERATE', sessionId, requestId}).then(response => {
      if (!isCurrent(version, element, expected)) return;
      if (!response?.ok) throw new Error(response?.error || 'Generation is unavailable. Open the panel for help.');
      if (response.sessionId !== session || response.requestId !== request) return;
      if (Array.isArray(response.candidates)) answers = response.candidates;
      loading = false; render();
      setStatus(response.error || response.generatedSuggestion?.missingContext || 'Choose a draft to review before using it.');
    }).catch(error => {
      if (!isCurrent(version, element, expected)) return;
      if (/Fill is in progress|Application is busy/i.test(error.message)) index = selected;
      loading = false; render(); setStatus(error.message);
    });
  }
  function editInPanel() {
    if (loading || !sessionId || !isCurrent(epoch, target, fingerprint(snapshot))) return;
    const payload = {type: 'JOB_INLINE_EDIT_IN_PANEL', sessionId};
    if (answers[index]) payload.candidateId = answers[index].candidateId;
    const element = target, field = snapshot, expected = fingerprint(snapshot);
    // The panel owns the continuing guarded session. Only this display/token is revoked.
    const response = message(payload);
    dismiss({retainSession: true});
    const version = epoch;
    response.then(reply => {
      if (!reply?.error) return;
      if (disposed || epoch !== version || document.activeElement !== element || fingerprint(eligible(element)) !== expected) return;
      target = element; snapshot = field; retry = true; host.hidden = false;
      observe(); render(); setStatus(reply.error);
    }).catch(() => {
      if (disposed || epoch !== version || document.activeElement !== element || fingerprint(eligible(element)) !== expected) return;
      target = element; snapshot = field; retry = true; host.hidden = false;
      observe(); render(); setStatus('Open the extension toolbar button to continue editing');
    });
  }
  function keydown(event) {
    if (composing || event.isComposing || event.keyCode === 229 || !target || host.hidden) return;
    const inPopup = event.composedPath().includes(host);
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault(); dismiss({returnFocus: inPopup}); return;
    }
    if (event.key === 'ArrowDown' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !inPopup) {
      event.preventDefault(); controlsMode(true); (answers.length ? list : generate.disabled ? edit.disabled ? shadow.querySelector('button:last-of-type') : edit : generate).focus(); return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Tab') {
      if (acceptance) { dismiss(); return; }
      if (!inPopup && index >= 0 && !loading) { event.preventDefault(); accept(); }
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && answers.length && !loading
      && (!inPopup || shadow.activeElement === list)) {
      event.preventDefault(); select(index < 0 ? (event.key === 'ArrowDown' ? 0 : answers.length - 1) : index + (event.key === 'ArrowDown' ? 1 : -1));
    }
  }
  listen(document, 'focusin', event => {
    if (event.target === host && target?.isConnected && !host.hidden) {
      document.__jobApplicationInlineFocusAnchor = target;
      controlsMode(true);
    } else {
      delete document.__jobApplicationInlineFocusAnchor;
      if (shadow) controlsMode(false);
    }
    activate(event.target);
  });
  listen(document, 'click', event => { if (!event.composedPath().includes(host)) activate(event.target); });
  listen(document, 'pointerdown', event => {
    if (target && event.target !== target && !event.composedPath().includes(host)) dismiss();
  }, true);
  listen(document, 'focusout', event => {
    if (restoringFocus || !target) return;
    if (event.relatedTarget === host || event.relatedTarget === target) return;
    if (event.composedPath().includes(host) && event.relatedTarget?.getRootNode() === shadow) return;
    dismiss();
  });
  listen(document, 'keydown', keydown, true);
  listen(document, 'input', event => {
    if (document.__jobApplicationFilling || event.target?.__jobApplicationAutofillDispatch || composing) return;
    if (event.target === target || event.target === document.activeElement) { acceptance = null; activate(event.target); }
  });
  listen(document, 'change', event => {
    if (event.target === target && !document.__jobApplicationFilling && !event.target.__jobApplicationAutofillDispatch) { acceptance = null; activate(event.target); }
  });
  listen(document, 'compositionstart', () => { composing = true; dismiss(); });
  listen(document, 'compositionend', () => { composing = false; });
  listen(view, 'pagehide', () => dismiss());
  listen(document, 'scroll', schedulePosition, true);
  listen(view, 'resize', schedulePosition);
  listen(view.visualViewport, 'resize', schedulePosition);
  listen(view.visualViewport, 'scroll', schedulePosition);
  function withExplicitFocus(focus) {
    // The worker is revealing a reviewed destination, not requesting new suggestions.
    // DOM focus events are synchronous; ordinary user focus resumes after this call.
    const previous = restoringFocus;
    restoringFocus = true;
    try { return focus(); }
    finally { restoringFocus = previous; }
  }
  return {activeField, beforeFill, withExplicitFocus, dispose() { if (disposed) return; dismiss(); disposed = true; listeners.forEach(remove => remove()); host?.remove(); }};
}
