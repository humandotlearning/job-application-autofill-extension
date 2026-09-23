import {applicationRoot, inspectDocument} from './form-engine.js';
import {composedContains, isExtensionElement, queryAll, rootElementById} from './dom.js';

const OMIT_TAGS = new Set(['script', 'style', 'link', 'meta', 'iframe', 'object', 'embed', 'img', 'svg', 'canvas', 'video', 'audio', 'template']);
const KEEP_ATTRIBUTES = new Set(['id', 'class', 'name', 'type', 'for', 'role', 'required', 'disabled', 'readonly', 'multiple', 'autocomplete', 'inputmode', 'placeholder', 'min', 'max', 'step', 'pattern', 'minlength', 'maxlength', 'hidden', 'contenteditable']);
const URL_PATTERN = /(?:\b[a-z][a-z\d+.-]*:\/\/|\/\/|www\.)[^\s<>"'`]+|\b[a-z][a-z\d+.-]*:[^\s<>"'`]+|\b[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+(?::\d+)?(?:[/?#][^\s<>"'`]+)?|(?<![\w/])\/(?:[a-z\d._~-]+\/)*[a-z\d._~-]+(?:[?#][^\s<>"'`]+)?|(?<![\w.])\.{1,2}\/[^\s<>"'`]+/gi;

export function scrubDebugText(value, enteredValues = []) {
  let text = String(value ?? '');
  for (const answer of enteredValues) {
    if (answer.trim().length >= 3) {
      text = text.replaceAll(answer, '[redacted]');
    } else if (/^[\p{L}\p{N}_]+$/u.test(answer.trim())) {
      const escaped = answer.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'giu'), '$1[redacted]');
    } else if (text.trim() === answer.trim()) {
      text = text.replace(answer.trim(), '[redacted]');
    }
  }
  return text.replace(URL_PATTERN, '[redacted URL]');
}

export function captureDebugSnapshot(document) {
  const inspection = inspectDocument(document);
  if (!inspection.destination?.regionId || !inspection.fields.length) throw new Error('Select a loaded application form before capturing it.');
  const root = applicationRoot(document);
  const entered = [...new Set(inspection.fields.flatMap(field => [field.rawValue, field.currentValue])
    .filter(value => typeof value === 'string' && value.trim()))]
    .sort((a, b) => b.length - a.length);
  const scrub = value => scrubDebugText(value, entered);
  const clean = value => {
    if (!value || typeof value !== 'object') return typeof value === 'string' ? scrub(value) : value;
    if (Array.isArray(value)) return value.map(clean);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
  };
  const cleanStatic = value => {
    if (typeof value === 'string') return scrubDebugText(value);
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(cleanStatic);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanStatic(item)]));
  };
  const copy = (node, preserveAnswerText = false) => {
    if (node.nodeType === 3) return document.createTextNode(scrubDebugText(node.textContent, preserveAnswerText ? [] : entered));
    if (node.nodeType !== 1 || isExtensionElement(node)) return null;
    const tag = node.localName;
    if (OMIT_TAGS.has(tag) || (tag === 'input' && ['hidden', 'password'].includes(node.type))) return null;
    const isChoice = tag === 'option' || node.getAttribute('role') === 'option';
    const preserveChildren = preserveAnswerText || isChoice || ['label', 'legend'].includes(tag);
    const clone = document.createElement(tag);
    for (const attribute of node.attributes) {
      const name = attribute.name.toLowerCase();
      if (KEEP_ATTRIBUTES.has(name) || (name.startsWith('aria-') && !['aria-valuenow', 'aria-valuetext', 'aria-selected', 'aria-checked'].includes(name))
        || (name === 'value' && (tag === 'option' || (tag === 'input' && ['radio', 'checkbox'].includes(node.type))))
        || (name === 'data-value' && node.getAttribute('role') === 'option')) {
        clone.setAttribute(name, scrubDebugText(attribute.value, isChoice ? [] : entered));
      }
    }
    if (node.shadowRoot) {
      const template = document.createElement('template');
      template.setAttribute('shadowrootmode', 'open');
      for (const child of node.shadowRoot.childNodes) { const safe = copy(child, preserveChildren); if (safe) template.content.append(safe); }
      clone.append(template);
    }
    if (tag !== 'textarea' && !node.hasAttribute('contenteditable')) {
      for (const child of node.childNodes) { const safe = copy(child, preserveChildren); if (safe) clone.append(safe); }
    }
    return clone;
  };
  const source = root === document ? document.body : root;
  let clone = copy(source);
  const external = new Set();
  for (const element of queryAll(source, '[aria-controls],[aria-owns],[aria-labelledby],[aria-describedby]')) {
    for (const name of ['aria-controls', 'aria-owns', 'aria-labelledby', 'aria-describedby']) {
      for (const id of String(element.getAttribute(name) || '').split(/\s+/).filter(Boolean)) {
        const referenced = rootElementById(element, id);
        if (referenced && referenced.getRootNode() === document && !composedContains(source, referenced)) external.add(referenced);
      }
    }
  }
  const extras = [...external].filter(node => ![...external].some(parent => parent !== node && parent.contains(node)));
  if (extras.length) {
    const wrapper = document.createElement('main');
    wrapper.append(clone);
    for (const node of extras) { const safe = copy(node); if (safe) wrapper.append(safe); }
    clone = wrapper;
  }
  const html = clone?.outerHTML || '';
  if (html.length > 500_000) throw new Error('This form is too large for a debug case. Capture a smaller form region.');
  return {
    html,
    inspection: {
      fields: inspection.fields.map(field => ({label: cleanStatic(field.label), type: field.type, required: field.required,
        options: cleanStatic(field.options), widget: cleanStatic(field.widget || ''), section: cleanStatic(field.section || ''),
        helpText: clean(field.helpText || ''), placeholder: clean(field.placeholder || ''), constraints: cleanStatic(field.constraints || {})})),
      actions: inspection.actions.map(action => ({label: cleanStatic(action.label), kind: action.kind, type: action.type})),
      discovery: clean(inspection.discovery),
      pauseReasons: clean(inspection.pauseReasons),
    },
    limitations: {closedShadowRoots: 'Closed shadow roots cannot be captured or replayed.'},
  };
}
