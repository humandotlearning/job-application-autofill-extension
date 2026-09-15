// One short-lived index per synchronous inspection. Never cache across a fill/await.
const domSnapshots = new WeakMap();
const EXTENSION_UI = '[data-job-inline-autofill]';

export function composedParent(element) {
  return element?.assignedSlot || element?.parentElement || element?.getRootNode?.().host || null;
}

export function composedClosest(element, selector) {
  for (let current = element; current; current = composedParent(current)) {
    if (current.matches?.(selector)) return current;
  }
  return null;
}

export function composedContains(root, element) {
  for (let current = element; current; current = composedParent(current)) {
    if (current === root || current.getRootNode?.() === root) return true;
  }
  return false;
}

export function isExtensionElement(element) {
  return Boolean(composedClosest(element, EXTENSION_UI));
}

export function createDomIndex(document) {
  const elements = [], roots = [document], seen = new Set();
  function visit(node) {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.nodeType === 1) {
      if (node.matches(EXTENSION_UI)) return;
      elements.push(node);
      if (node.shadowRoot) { roots.push(node.shadowRoot); visit(node.shadowRoot); return; }
      if (node.tagName === 'SLOT') {
        const assigned = node.assignedNodes?.({flatten: true}) || [];
        if (assigned.length) { for (const child of assigned) visit(child); return; }
      }
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(document);
  return {elements, roots, queries: new Map(), memo: new Map(), order: new Map(elements.map((el, i) => [el, i]))};
}

export function withDomSnapshot(document, callback) {
  if (domSnapshots.has(document)) return callback(domSnapshots.get(document));
  const index = createDomIndex(document);
  domSnapshots.set(document, index);
  try { return callback(index); } finally { domSnapshots.delete(document); }
}

export function domMemo(document, key, compute) {
  const index = domSnapshots.get(document);
  if (!index) return compute();
  if (!index.memo.has(key)) index.memo.set(key, compute());
  return index.memo.get(key);
}

export function queryAll(root, selector) {
  if (!root) return [];
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  const index = domSnapshots.get(document) || createDomIndex(document);
  if (!index.queries.has(selector)) index.queries.set(selector, index.elements.filter(el => el.matches(selector)));
  return index.queries.get(selector).filter(el => el !== root && (root === document || composedContains(root, el)));
}

export function rootElementById(element, id) {
  if (!id) return null;
  // IDs are scoped to their tree. Do not accidentally resolve a sibling component's ID.
  return element.getRootNode?.().getElementById?.(id) || null;
}

export function deepActiveElement(document) {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement && !element.matches(EXTENSION_UI)) element = element.shadowRoot.activeElement;
  return element;
}

export function eventControl(event) {
  return event.composedPath?.().find(node => node?.nodeType === 1) || event.target;
}

export function composedText(element) {
  const seen = new Set();
  function read(node) {
    if (!node || seen.has(node)) return '';
    seen.add(node);
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType === 1 && node.matches('script,style,[hidden],[aria-hidden="true"],' + EXTENSION_UI)) return '';
    const assigned = node.tagName === 'SLOT' ? node.assignedNodes?.({flatten: true}) : null;
    const children = assigned?.length ? assigned : node.shadowRoot?.childNodes || node.childNodes || [];
    return [...children].map(read).join('');
  }
  return read(element).replace(/\s+/g, ' ').trim();
}
