import {
  chooseRecord,
  decideDisposition,
  canonicalConcept,
  inferSensitivity,
  isOpaqueIdentifier,
  normalizeText,
  shouldReviewDecision,
  slugify,
  validateFillValue,
} from './core.js';

const IGNORED_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image', 'search']);
const SECRET_MARKER = /(?:password|passcode|passwd|pwd|secret|token|csrf|auth[_-]?token)/i;
const CUSTOM_WIDGET_SELECTOR = '[role="combobox"], button[aria-haspopup="listbox"]';
const EMPTY_CUSTOM_WIDGET_VALUE = /^(?:choose|select)\b/i;
const CUSTOM_WIDGET_PROMPT_LABEL = /^(?:choose|select)(?:\s+(?:one|an?\s+option|an?\s+answer|a\s+value))?$/i;
const trackedDocuments = new WeakSet();
const controlHandles = new WeakMap();
const documentHandles = new WeakMap();

function controlHandle(element) {
  const document = element.ownerDocument;
  const location = document.location?.href || '';
  let state = documentHandles.get(document);
  if (!state || state.location !== location) {
    state = { location, id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, next: 0 };
    documentHandles.set(document, state);
  }
  let handle = controlHandles.get(element);
  if (!handle?.startsWith(`${state.id}:`)) {
    handle = `${state.id}:${++state.next}`;
    controlHandles.set(element, handle);
  }
  return handle;
}

function applicationRoot(document) {
  const candidates = [...document.querySelectorAll('form')].filter(isVisible).map((form) => {
    const label = `${form.id} ${form.getAttribute('aria-label') || ''} ${form.getAttribute('name') || ''} ${form.querySelector('h1,h2,legend')?.textContent || ''}`;
    const action = [...form.querySelectorAll('button,input[type="submit"]')].map(actionLabel).join(' ');
    const score = /subscribe|search|newsletter|alert/i.test(label + action) ? -1
      : (/application|candidate|apply|employment|education/i.test(label) ? 5 : 0) + (/submit application|apply now/i.test(action) ? 3 : 0);
    return { form, score };
  }).sort((a, b) => b.score - a.score);
  if (candidates[0]?.score > 0 && candidates[0].score === candidates[1]?.score) {
    const focused = document.activeElement?.closest?.('form');
    return candidates.some((candidate) => candidate.form === focused && candidate.score === candidates[0].score) ? focused : document.createDocumentFragment();
  }
  return candidates[0]?.score > 0 && candidates[0].score > (candidates[1]?.score ?? -1) ? candidates[0].form : document;
}

function inApplication(document, element) {
  const root = applicationRoot(document);
  if (root !== document) return root.contains(element) || element.form === root;
  const owner = element.closest('form,[role="search"],nav');
  return !owner || !/search|subscribe|newsletter|job.?alert/i.test(`${owner.id} ${owner.getAttribute('role')} ${owner.getAttribute('aria-label') || ''}`);
}

function ensureEditTracking(document) {
  if (trackedDocuments.has(document)) return;
  const markEdited = (event) => {
    let element = event.target;
    if (!element || element.__jobApplicationAutofillDispatch || (document.__jobApplicationFilling && !event.isTrusted)) return;
    if (event.type === 'click') {
      const listbox = element.closest?.('[role="option"]')?.closest('[role="listbox"]');
      if (!listbox?.id) return;
      element = customWidgetElements(document).find((widget) => String(widget.getAttribute('aria-controls') || widget.getAttribute('aria-owns') || '').split(/\s+/).includes(listbox.id));
      if (!element) return;
      delete element.__jobApplicationSearchQuery;
    }
    if (event.type === 'blur' && !element.__jobApplicationUserEdited) return;
    delete element.__jobApplicationCommittedLabel;
    element.__jobApplicationUserEdited = true;
    element.__jobApplicationUserCompleted = event.type !== 'input';
  };
  document.addEventListener('input', markEdited, true);
  document.addEventListener('change', markEdited, true);
  document.addEventListener('blur', markEdited, true);
  document.addEventListener('click', markEdited, true);
  trackedDocuments.add(document);
}

export function extractJobContext(document) {
  const readable = (node, limit = 16000) => {
    if (!node || !isVisible(node)) return '';
    const copy = node.cloneNode(true);
    for (const child of copy.querySelectorAll('script,style,nav,footer,form,input,textarea,select,button,[hidden],[aria-hidden="true"]')) child.remove();
    return String(copy.textContent || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  };
  const description = [...document.querySelectorAll('[itemprop="description"],.job-description,#job-description,[data-testid="job-description"],.posting-page .section-wrapper,.posting-description')]
    .map(node => readable(node)).filter(Boolean).join('\n').slice(0, 16000);
  return {
    title: document.title || '', domain: document.location?.hostname || '',
    role: readable(document.querySelector('[itemprop="title"],h1'), 300),
    company: readable(document.querySelector('[itemprop="hiringOrganization"],.company-name'), 300),
    jobDescription: description,
  };
}

function textFromIds(document, ids = '') {
  return String(ids)
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() || '')
    .filter(Boolean)
    .join(' ');
}

function labelText(label) {
  const copy = label.cloneNode(true);
  for (const child of copy.querySelectorAll('input,textarea,select,button,[role="combobox"],[role="listbox"]')) child.remove();
  return String(copy.textContent || '').replace(/\s+/g, ' ').trim();
}

function nearbyQuestion(element) {
  const controls = 'input:not([type="hidden"]),textarea,select,[role="combobox"],button[aria-haspopup="listbox"]';
  for (let wrapper = element.parentElement, depth = 0; wrapper && depth < 6; wrapper = wrapper.parentElement, depth++) {
    if (wrapper.matches('form,section,main,body')) break;
    const peers = [...wrapper.querySelectorAll(controls)].filter(isVisible);
    if (peers.some(peer => peer !== element && !(element.type === 'radio' && peer.type === 'radio' && peer.name === element.name))) break;
    const candidates = [...wrapper.querySelectorAll('.application-label .text,h3,h4,[role="heading"],legend,label')]
      .filter(node => isVisible(node) && !node.contains(element) && !node.querySelector(controls)
        && !node.matches('[for]') && !node.closest('[role="alert"],.error,.help,.hint')
        && Boolean(node.compareDocumentPosition(element) & 4));
    const labels = [...new Set(candidates.map(labelText).filter(text => text && text.length <= 500))];
    if (labels.length > 1) return '';
    if (labels.length === 1) return labels[0];
  }
  return '';
}

function questionMetadata(document, element) {
  const native = [...(element.labels || [])].map(labelText).filter(Boolean).join(' ');
  if (element.type === 'radio') {
    const group = element.closest('fieldset,[role="radiogroup"],[role="group"]');
    const explicit = group && (textFromIds(document, group.getAttribute('aria-labelledby')) || group.getAttribute('aria-label') || group.querySelector(':scope > legend')?.textContent?.trim());
    if (explicit) return { label: explicit, labelSource: 'group', labelConfidence: 'high' };
    const peers = radioGroup(document, element);
    const aria = peer => textFromIds(document, peer.getAttribute('aria-labelledby')) || peer.getAttribute('aria-label') || '';
    const shared = aria(element);
    if (shared && peers.length > 1 && peers.every(peer => aria(peer) === shared)) return { label: shared, labelSource: 'shared-aria', labelConfidence: 'high' };
    const nearby = nearbyQuestion(element);
    return { label: nearby || element.name || element.id || '', labelSource: nearby ? 'nearby-question' : 'identity', labelConfidence: nearby ? 'high' : 'low' };
  }
  const explicit = native || element.getAttribute('aria-label') || textFromIds(document, element.getAttribute('aria-labelledby'));
  const nearby = !explicit && nearbyQuestion(element);
  return { label: explicit || nearby || element.getAttribute('placeholder') || element.name || element.id || '',
    labelSource: explicit ? 'explicit' : nearby ? 'nearby-question' : 'identity', labelConfidence: explicit || nearby ? 'high' : 'low' };
}

function labelFor(document, element) {
  if (element.type === 'radio') {
    const legend = element.closest('fieldset')?.querySelector('legend')?.textContent?.trim();
    if (legend) return legend;
  }
  const nativeLabel = [...(element.labels || [])]
    .map(labelText)
    .filter(Boolean)
    .join(' ');
  return nativeLabel
    || element.getAttribute('aria-label')
    || textFromIds(document, element.getAttribute('aria-labelledby'))
    || element.getAttribute('placeholder')
    || element.getAttribute('name')
    || element.id
    || '';
}

function isSupported(element) {
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return false;
  if (element.getAttribute('role') === 'combobox' || element.getAttribute('aria-haspopup') === 'listbox') return false;
  if (element.disabled || element.readOnly) return false;
  if (IGNORED_TYPES.has(String(element.type || '').toLowerCase())) return false;
  return !SECRET_MARKER.test(`${element.name || ''} ${element.id || ''} ${element.autocomplete || ''}`);
}

function isVisible(element) {
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
    const style = current.getAttribute('style') || '';
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return false;
    const computed = current.ownerDocument.defaultView?.getComputedStyle?.(current);
    if (computed && (computed.display === 'none' || computed.visibility === 'hidden' || computed.contentVisibility === 'hidden')) return false;
  }
  return true;
}

function hasNativeFormAction(element) {
  // Use the live native type/form owner: missing or invalid button types submit,
  // and the form attribute can associate a control outside the form subtree.
  const control = element.closest?.('button, input');
  return Boolean(control?.form && ['submit', 'reset', 'image'].includes(control.type));
}

function customWidgetElements(document) {
  return [...document.querySelectorAll(CUSTOM_WIDGET_SELECTOR)]
    .filter((element) => !hasNativeFormAction(element))
    .filter((element) => inApplication(document, element) && !element.disabled && !element.readOnly)
    .filter((element) => isVisible(element))
    .filter((element) => element.closest('form, main, [role="main"]') || hasNearbyFormControl(element))
    .filter((element) => element.getAttribute('aria-label') || element.getAttribute('name')
      || textFromIds(document, element.getAttribute('aria-labelledby')) || associatedLabelText(document, element) || hasNearbyFormControl(element));
}

function hasNearbyFormControl(element) {
  return [...(element.parentElement?.children || [])]
    .some((sibling) => sibling !== element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(sibling.tagName));
}

function customWidgetValue(element) {
  const selectedOptions = customWidgetOptions(element.ownerDocument, element)
    .filter((option) => option.getAttribute('aria-selected') === 'true')
    .map(customOptionText)
    .filter(Boolean);
  const typedValue = element.__jobApplicationSearchQuery || (element.getAttribute('aria-expanded') === 'true' && element.__jobApplicationUserEdited) ? '' : element.value;
  const value = String(selectedOptions.length ? selectedOptions.join(', ') : (element.getAttribute('aria-valuetext') || element.__jobApplicationCommittedLabel || typedValue || element.textContent || ''))
    .replace(/\s+/g, ' ').trim();
  return EMPTY_CUSTOM_WIDGET_VALUE.test(value) || isOpaqueIdentifier(value) ? '' : value;
}

function customWidgetRequired(element) {
  return element.getAttribute('aria-required') === 'true'
    || /\brequired\b/i.test(element.getAttribute('aria-label') || '')
    || Boolean(element.required);
}

function visibleText(element) {
  return String(element?.textContent || '').replace(/\s+/g, ' ').trim();
}

function associatedLabelText(document, element) {
  const labels = [...(element.labels || [])]
    .map(labelText)
    .filter(Boolean);
  if (labels.length) return labels.join(' ');
  if (!element.id) return '';
  const explicit = [...document.querySelectorAll('label')]
    .filter((label) => label.getAttribute('for') === element.id)
    .map((label) => visibleText(label))
    .filter(Boolean);
  return explicit.join(' ');
}

function nearestFieldGroupLabel(element) {
  const group = element.closest('fieldset, [role="group"]');
  if (!group) return '';
  for (const current of [group]) {
    const candidates = [...current.querySelectorAll('label, legend')]
      .map((candidate) => visibleText(candidate))
      .filter(Boolean);
    const unique = [...new Set(candidates)];
    if (unique.length === 1) return unique[0];
  }
  return '';
}

function fieldContext(element) {
  const group = element.closest('fieldset, [role="group"], section, form');
  if (!group) return {};
  const heading = group.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > [role="heading"]');
  const section = visibleText(heading);
  const contextText = `${section} ${group.id} ${group.getAttribute('data-automation-id') || ''}`;
  const entityType = /employment|work.?experience|work.?history/i.test(contextText) ? 'employment'
    : /education|school|university/i.test(contextText) ? 'education' : '';
  const entityId = group.getAttribute('data-entity-id') || (entityType || /reference|referee|emergency|supervisor/i.test(contextText) ? group.id || group.getAttribute('name') : '')
    || (entityType ? `${entityType}-${[...element.ownerDocument.querySelectorAll('fieldset,[role="group"],section')].indexOf(group) + 1}` : '');
  return {
    ...(section ? { section } : {}),
    ...(entityId ? { entityId } : {}),
    ...(entityType ? { entityType } : {}),
  };
}

function customWidgetLabel(document, element) {
  const associated = associatedLabelText(document, element);
  if (associated) return associated;
  const labelledBy = textFromIds(document, element.getAttribute('aria-labelledby'));
  if (labelledBy) return labelledBy;
  const fieldGroupLabel = nearestFieldGroupLabel(element) || nearbyQuestion(element);
  if (fieldGroupLabel) return fieldGroupLabel;

  const displayed = customWidgetValue(element);
  const ariaLabel = String(element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const withoutState = ariaLabel.replace(/\b(?:required|optional)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const normalizedLabel = normalizeText(withoutState);
  const normalizedValue = normalizeText(displayed);
  const withoutValue = displayed && normalizedLabel.endsWith(normalizedValue)
    ? withoutState.slice(0, withoutState.length - displayed.length).replace(/[,:-]\s*$/, '').trim()
    : withoutState;
  const fallback = withoutValue && !CUSTOM_WIDGET_PROMPT_LABEL.test(withoutValue)
    ? withoutValue
    : '';
  return fallback || (ariaLabel && !CUSTOM_WIDGET_PROMPT_LABEL.test(ariaLabel.replace(/\b(?:required|optional)\b/gi, ' ').replace(/\s+/g, ' ').trim()) ? ariaLabel : '')
    || element.getAttribute('name') || element.id || '';
}

function customOptionText(element) {
  return String(element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}

function customOptionValue(element) {
  return String(element.getAttribute('data-value') || element.getAttribute('value') || '').trim();
}

function customOptionAliases(option) {
  const label = customOptionText(option);
  // SuccessFactors picklists prefix display labels with an ordinal ("4 - Bachelor's degree").
  const unnumbered = option.closest('.sf-list-select') ? label.replace(/^\d+\s+[-–—]\s+(?=[A-Za-z])/, '') : label;
  return [label, unnumbered, customOptionValue(option)].filter(Boolean).map(normalizeText);
}

function matchingCustomOptions(options, value) {
  const exact = options.filter((option) => [customOptionText(option), customOptionValue(option)].map(normalizeText).includes(value));
  return exact.length ? exact : options.filter((option) => customOptionAliases(option).includes(value));
}

function customWidgetOptions(document, element) {
  const ids = String(element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
  const listboxes = ids.length
    ? ids.map((id) => document.getElementById(id)).filter(Boolean).flatMap((node) => node.matches('[role="listbox"]') ? [node] : [...node.querySelectorAll('[role="listbox"]')])
    : [...document.querySelectorAll('[role="listbox"]')];
  const visibleListboxes = listboxes
    .filter((listbox) => isVisible(listbox))
    .filter((listbox) => ids.length || (listboxes.length === 1 && ![...document.querySelectorAll(CUSTOM_WIDGET_SELECTOR)].some((owner) => owner !== element && String(owner.getAttribute('aria-controls') || owner.getAttribute('aria-owns') || '').split(/\s+/).includes(listbox.id))));
  return visibleListboxes
    .flatMap((listbox) => [...listbox.querySelectorAll('[role="option"]')])
    .filter((option) => isVisible(option) && option.getAttribute('aria-disabled') !== 'true' && !option.disabled);
}

function fieldIdentity(element, index, collection = []) {
  const base = element.id || element.name || `field_${controlHandle(element)}`;
  if (!element.id && !element.name) return base;
  const occurrence = collection.slice(0, index + 1)
    .filter((candidate) => (candidate.id || candidate.name || '') === base).length;
  return occurrence > 1 ? `${base}__${controlHandle(element)}` : base;
}

function formElements(document) {
  return [...document.querySelectorAll('input, textarea, select')].filter((element) => isSupported(element) && isVisible(element) && inApplication(document, element));
}

function uniqueFields(document) {
  const fields = [];
  const seenRadioGroups = new Set();
  for (const [index, element] of formElements(document).entries()) {
    if (element.type === 'radio' && element.name) {
      const group = radioGroup(document, element)[0];
      if (seenRadioGroups.has(group)) continue;
      seenRadioGroups.add(group);
    }
    fields.push({ element, index });
  }
  return fields;
}

function fieldOptions(document, element) {
  if (customWidgetElements(document).includes(element)) {
    return customWidgetOptions(document, element)
      .flatMap((option) => [customOptionText(option), customOptionValue(option)])
      .filter(Boolean)
      .filter((option, index, options) => options.findIndex((candidate) => normalizeText(candidate) === normalizeText(option)) === index);
  }
  if (element.tagName === 'SELECT') {
    return [...element.options]
      .flatMap((option) => [option.textContent.trim(), option.value.trim()])
      .filter(Boolean)
      .filter((option, index, options) => options.findIndex((candidate) => normalizeText(candidate) === normalizeText(option)) === index);
  }
  if (element.type === 'radio') {
    const group = radioGroup(document, element);
    return group.map((candidate) => optionText(candidate)).filter(Boolean);
  }
  if (element.type === 'checkbox') return ['Yes', 'No'];
  return [];
}

function optionText(element) {
  const label = [...(element.labels || [])].map((item) => item.textContent || '').join(' ').trim();
  return label || element.getAttribute('aria-label') || element.value || '';
}

function fieldValue(document, element) {
  if (customWidgetElements(document).includes(element)) return customWidgetValue(element);
  if (element.type === 'checkbox') {
    return element.checked ? 'Yes' : (element.__jobApplicationUserEdited || element.__jobApplicationAutofillValue != null ? 'No' : '');
  }
  if (element.type === 'radio') {
    const selected = radioGroup(document, element).find((candidate) => candidate.checked);
    return selected ? optionText(selected) : '';
  }
  if (element.tagName === 'SELECT') {
    if (element.multiple) return [...element.selectedOptions].filter((option) => option.value).map((option) => option.textContent.trim()).join(', ');
    const selected = element.selectedOptions?.[0];
    return selected?.value && !selected.disabled ? selected.textContent.trim() : '';
  }
  return String(element.value || '').trim();
}

function constraintsFor(element) {
  const constraints = {};
  for (const attribute of ['min', 'max', 'pattern']) {
    if (element.hasAttribute(attribute)) constraints[attribute] = element.getAttribute(attribute);
  }
  for (const attribute of ['minLength', 'maxLength']) {
    const htmlAttribute = attribute.toLowerCase();
    if (element.hasAttribute(htmlAttribute)) constraints[attribute] = Number(element.getAttribute(htmlAttribute));
  }
  return constraints;
}

function describeField(document, element, index) {
  const type = element.tagName === 'SELECT' ? 'select' : element.tagName === 'TEXTAREA' ? 'textarea' : (element.type || 'text');
  return {
    id: fieldIdentity(element, index, formElements(document)),
    handle: controlHandle(element),
    multiple: Boolean(element.multiple),
    selectedValues: element.tagName === 'SELECT' ? [...element.selectedOptions].filter((option) => option.value).map((option) => option.value) : [],
    structuredOptions: element.tagName === 'SELECT' ? [...element.options].map((option) => ({ label: option.textContent.trim(), value: option.value, selected: option.selected, disabled: option.disabled })) : [],
    ...questionMetadata(document, element),
    helpText: textFromIds(document, element.getAttribute('aria-describedby')).slice(0, 2000),
    nearbyContext: nearbyQuestion(element).slice(0, 1000),
    type,
    autocomplete: element.autocomplete || '',
    placeholder: element.getAttribute('placeholder') || '',
    required: Boolean(element.required),
    currentValue: fieldValue(document, element),
    options: fieldOptions(document, element),
    constraints: constraintsFor(element),
    ...fieldContext(element),
  };
}

export function collectFieldDescriptors(document) {
  ensureEditTracking(document);
  const nativeFields = uniqueFields(document).map(({ element, index }) => ({ element, field: describeField(document, element, index) }));
  const customElements = customWidgetElements(document);
  const customFields = customElements
    .filter((element, index) => !nativeFields.some(({ field }) => field.id === fieldIdentity(element, index, customElements)))
    .map((element, index) => ({ element, field: {
      id: fieldIdentity(element, index, customElements),
      handle: controlHandle(element),
      multiple: element.getAttribute('aria-multiselectable') === 'true' || document.getElementById(element.getAttribute('aria-controls'))?.getAttribute('aria-multiselectable') === 'true',
      structuredOptions: customWidgetOptions(document, element).map((option) => ({ label: customOptionText(option), value: customOptionValue(option), selected: option.getAttribute('aria-selected') === 'true', disabled: option.getAttribute('aria-disabled') === 'true' })),
      label: customWidgetLabel(document, element),
      labelSource: nearbyQuestion(element) === customWidgetLabel(document, element) ? 'nearby-question' : 'custom-widget',
      labelConfidence: customWidgetLabel(document, element) && ![element.name, element.id].includes(customWidgetLabel(document, element)) ? 'high' : 'low',
      type: 'select',
      widget: 'custom',
      autocomplete: element.getAttribute('autocomplete') || '',
      required: customWidgetRequired(element),
      currentValue: fieldValue(document, element),
      options: fieldOptions(document, element),
      constraints: {},
      ...fieldContext(element),
    } }));
  const fields = [...nativeFields, ...customFields]
    .sort(({ element: left }, { element: right }) => {
      const position = left.compareDocumentPosition?.(right) || 0;
      if (position & 4) return -1;
      if (position & 2) return 1;
      return 0;
    })
    .map(({ field }, formOrder) => ({ ...field, formOrder }));
  const groupKey = (field) => `${canonicalConcept(field.label)}:${field.entityId || ''}`;
  const counts = new Map();
  const occurrences = new Map();
  for (const field of fields) counts.set(groupKey(field), (counts.get(groupKey(field)) || 0) + 1);
  return fields.map((field) => {
    const key = groupKey(field);
    const occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    return counts.get(key) > 1 ? { ...field, entityId: `${field.entityId || 'entry'}-${occurrence}` } : field;
  });
}

function dispatchFormEvents(element) {
  const view = element.ownerDocument.defaultView;
  element.__jobApplicationAutofillDispatch = true;
  try {
    for (const eventName of ['input', 'change', 'blur']) {
      element.dispatchEvent(new view.Event(eventName, { bubbles: true }));
    }
  } finally {
    delete element.__jobApplicationAutofillDispatch;
  }
}

function setTextValue(element, value) {
  const view = element.ownerDocument.defaultView;
  const prototype = element.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement?.prototype : view.HTMLInputElement?.prototype;
  const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, String(value));
  else element.value = String(value);
  dispatchFormEvents(element);
  return element.value === String(value);
}

function checkValidityWithoutPattern(element) {
  const pattern = element.getAttribute('pattern');
  element.removeAttribute('pattern');
  try {
    return element.checkValidity();
  } finally {
    element.setAttribute('pattern', pattern);
  }
}

function checkValiditySafely(element) {
  if (typeof element?.checkValidity !== 'function') return true;
  const pattern = element.getAttribute('pattern');
  if (pattern !== null) {
    // HTML patterns use Unicode Sets mode. Chrome can log a malformed pattern
    // from checkValidity even when it does not throw an exception to our caller.
    let invalidPattern = false;
    try {
      new RegExp(pattern, 'v');
    } catch {
      invalidPattern = true;
    }
    if (invalidPattern) return checkValidityWithoutPattern(element);
  }
  try {
    return element.checkValidity();
  } catch (error) {
    const message = String(error?.message || '');
    const isInvalidPattern = element.hasAttribute('pattern')
      && (error?.name === 'SyntaxError' || /invalid regular expression|regular expression/i.test(message));
    if (!isInvalidPattern) throw error;

    return checkValidityWithoutPattern(element);
  }
}

function setSelectValue(element, answer) {
  if (element.multiple) {
    const values = String(answer).split(/\s*[,;]\s*/).map(normalizeText);
    const matches = [...element.options].filter((option) => !option.disabled && values.some((value) => [normalizeText(option.value), normalizeText(option.textContent)].includes(value)));
    if (matches.length !== values.length) return false;
    for (const option of element.options) option.selected = matches.includes(option);
    dispatchFormEvents(element);
    return [...element.selectedOptions].length === matches.length;
  }
  const expected = normalizeText(answer);
  const option = [...element.options].find((candidate) => normalizeText(candidate.value) === expected || normalizeText(candidate.textContent) === expected);
  if (!option) return false;
  element.value = option.value;
  dispatchFormEvents(element);
  return element.value === option.value;
}

function radioGroup(document, element) {
  return formElements(document).filter((candidate) => candidate.type === 'radio' && (element.name ? candidate.name === element.name && candidate.form === element.form : candidate === element));
}

function setRadioGroup(document, element, answer) {
  const expected = normalizeText(answer);
  const option = radioGroup(document, element).find((candidate) => normalizeText(candidate.value) === expected || normalizeText(optionText(candidate)) === expected);
  if (!option) return false;
  option.checked = true;
  dispatchFormEvents(option);
  return option.checked;
}

function setCheckbox(element, answer) {
  const expected = normalizeText(answer);
  if (!['yes', 'true', 'checked', 'no', 'false', 'unchecked'].includes(expected)) return false;
  element.checked = ['yes', 'true', 'checked'].includes(expected);
  dispatchFormEvents(element);
  return true;
}

function waitForCustomOptions(document, element, answer, timeoutMs = 1500) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const options = customWidgetOptions(document, element);
      const multiple = element.getAttribute('aria-multiselectable') === 'true'
        || options[0]?.closest('[role="listbox"]')?.getAttribute('aria-multiselectable') === 'true';
      const requested = multiple ? String(answer).split(/\s*[,;]\s*/).map(normalizeText).filter(Boolean) : [normalizeText(answer)];
      if ((options.length && requested.every((value) => matchingCustomOptions(options, value).length)) || Date.now() - startedAt >= timeoutMs) {
        resolve(options);
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

async function setCustomChoiceValue(document, element, answer, deadline = Infinity) {
  element.focus?.();
  if (hasNativeFormAction(element)) {
    return { ok: false, unresolved: true, reason: 'Refusing to activate a native submit/reset control' };
  }
  if (element.getAttribute('aria-expanded') !== 'true') element.click();
  const expected = normalizeText(answer);
  const initialText = normalizeText(element.textContent || '');
  const initialValue = String(element.value || '');
  if (element.tagName === 'INPUT' && element.getAttribute('aria-autocomplete')) {
    element.__jobApplicationSearchQuery = true;
    setTextValue(element, answer);
  }
  const options = await waitForCustomOptions(document, element, answer, Math.max(0, Math.min(1500, deadline - Date.now())));
  if (!options.length) {
    if (element.tagName === 'INPUT') setTextValue(element, '');
    return { ok: false, unresolved: true, reason: 'The custom widget did not reveal any options' };
  }
  const multiple = element.getAttribute('aria-multiselectable') === 'true'
    || options[0]?.closest('[role="listbox"]')?.getAttribute('aria-multiselectable') === 'true';
  const requested = multiple ? String(answer).split(/\s*[,;]\s*/).map(normalizeText).filter(Boolean) : [expected];
  const candidates = requested.map((value) => matchingCustomOptions(options, value));
  const matches = candidates.flat();
  if (candidates.some((options) => options.length !== 1) || new Set(matches).size !== matches.length) {
    return { ok: false, unresolved: true, reason: 'The custom widget does not expose one unique exact option' };
  }
  for (const match of matches) {
    if (Date.now() >= deadline) return { ok: false, unresolved: true, reason: 'Autofill deadline reached' };
    if (match.getAttribute('aria-selected') === 'true') continue;
    // Recheck after awaiting options and after every preceding selection.
    if (hasNativeFormAction(match)) {
      return { ok: false, unresolved: true, reason: 'Refusing to activate a native submit/reset option' };
    }
    match.click();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const selectionCommitted = matches.every((option) => option.getAttribute('aria-selected') === 'true')
    || (!element.__jobApplicationSearchQuery && (normalizeText(element.textContent || '') !== initialText
      || String(element.value || '') !== initialValue
      || Boolean(element.getAttribute('aria-valuetext'))));
  if (selectionCommitted) element.__jobApplicationCommittedLabel = customOptionText(matches[0]);
  const backingInput = [...(element.parentElement?.querySelectorAll('input, textarea') || [])].find((input) => input !== element);
  const acceptedSingleValues = multiple ? [expected] : [...new Set([expected, ...customOptionAliases(matches[0])])];
  if (element.tagName === 'INPUT') {
    const committed = matches.every((option) => option.getAttribute('aria-selected') === 'true')
      || acceptedSingleValues.includes(normalizeText(element.getAttribute('aria-valuetext')))
      || acceptedSingleValues.includes(normalizeText(backingInput?.value || ''))
      || (element.getAttribute('aria-expanded') === 'false' && acceptedSingleValues.includes(normalizeText(element.value)));
    if (!committed) return { ok: false, unresolved: true, reason: 'The searchable widget has no committed selection' };
    delete element.__jobApplicationSearchQuery;
  }
  if (backingInput) dispatchFormEvents(backingInput);
  dispatchFormEvents(element);
  const displayed = normalizeText(fieldValue(document, element));
  const backingValue = normalizeText(backingInput?.value || '');
  const displayedValues = fieldValue(document, element).split(/\s*[,;]\s*/).map(normalizeText).filter(Boolean);
  const expectedValues = requested.slice().sort();
  const displayedMatches = multiple
    ? displayedValues.slice().sort().join('|') === expectedValues.slice().sort().join('|')
    : acceptedSingleValues.includes(displayed) || acceptedSingleValues.includes(backingValue);
  if (!displayedMatches && backingValue !== expected) {
    return { ok: false, unresolved: true, reason: 'The custom widget did not accept the selected option' };
  }
  return { ok: true };
}

async function fillElement(document, element, answer, deadline = Infinity) {
  if (!element) return { ok: false, reason: 'The field control is no longer available' };
  element.__jobApplicationAutofillValue = String(answer);
  delete element.__jobApplicationUserEdited;
  if (customWidgetElements(document).includes(element)) return setCustomChoiceValue(document, element, answer, deadline);
  if (element.tagName === 'SELECT') return { ok: setSelectValue(element, answer) };
  if (element.type === 'radio') return { ok: setRadioGroup(document, element, answer) };
  if (element.type === 'checkbox') return { ok: setCheckbox(element, answer) };
  return { ok: setTextValue(element, answer) };
}

function elementsForField(document, fieldId) {
  const nativeElements = formElements(document);
  const nativeMatch = nativeElements.find((element, index) => fieldIdentity(element, index, nativeElements) === fieldId);
  if (nativeMatch) return [nativeMatch];
  const customFields = customWidgetElements(document);
  const generatedCustomIndex = customFields.findIndex((element, index) => fieldIdentity(element, index, customFields) === fieldId);
  if (generatedCustomIndex >= 0) return [customFields[generatedCustomIndex]];
  const byId = document.getElementById(fieldId);
  if (byId && (isSupported(byId) || customFields.includes(byId))) return [byId];
  return [...nativeElements, ...customFields]
    .filter((element) => element.name === fieldId || element.id === fieldId);
}

function elementForField(document, fieldId) {
  return elementsForField(document, fieldId)[0] || null;
}

function currentField(document, fieldId) {
  return collectFieldDescriptors(document).find((field) => field.id === fieldId) || null;
}

function effectiveSensitivity(field, decision) {
  const inferred = inferSensitivity(field.label, field.id);
  if (inferred === 'legal' || decision.sensitivity === 'legal') return 'legal';
  if (inferred === 'review' || decision.sensitivity === 'review') return 'review';
  return 'safe';
}

function addReviewIfNeeded(result, field, decision, value) {
  const effective = { ...decision, sensitivity: effectiveSensitivity(field, decision), value };
  if (value && shouldReviewDecision(effective, field)) result.reviewRequired.push({ ...effective, field });
}

function isExplicitCoverField(field = {}) {
  const label = normalizeText(`${field.label || ''} ${field.name || ''} ${field.id || ''}`);
  return /\bcover letter\b|\bcover message\b|\bmessage to hiring manager\b|\bnote to recruiter\b|\brecruiter message\b/.test(label);
}

function coverMessageDecision(field, coverMessages = []) {
  if (!isExplicitCoverField(field)) return null;
  const template = coverMessages.find((message) => String(message.body || '').trim());
  if (!template) return null;
  return {
    fieldId: field.id,
    action: 'fill',
    value: template.body,
    evidenceKeys: [`cover_message:${template.id}`],
    confidence: 'high',
    sensitivity: 'review',
    reason: 'Imported cover-message template; review before submitting',
  };
}

const PHONE_CONCEPTS = new Set(['phone_number', 'phone_extension', 'phone_country_code', 'phone_device_type']);

function phoneOptionEntries(field = {}) {
  const structured = Array.isArray(field.structuredOptions) && field.structuredOptions.length
    ? field.structuredOptions
    : (Array.isArray(field.options) ? field.options.map((option) => ({ label: option, value: option })) : []);
  return structured
    .filter((option) => !option.disabled)
    .map((option) => ({ label: String(option.label || '').trim(), value: String(option.value || '').trim() }))
    .filter((option) => option.label || option.value);
}

function phoneChoiceValue(entry = {}) {
  if (entry.label && !isOpaqueIdentifier(entry.label)) return entry.label;
  if (entry.value && !isOpaqueIdentifier(entry.value)) return entry.value;
  return '';
}

function phoneCallingCode(entry = {}) {
  const match = /(?:^|[^\d])\+(\d{1,3})(?!\d)/.exec(`${entry.value} ${entry.label}`);
  return match ? `+${match[1]}` : '';
}

function phoneBlockKey(field = {}) {
  return `${field.entityId || ''}|${field.section ? normalizeText(field.section) : 'phone'}`;
}

function phoneDecision(field, action, value, reason, evidenceKeys = [], transformation = null) {
  return {
    fieldId: field.id,
    action,
    value: action === 'fill' ? value : null,
    evidenceKeys,
    confidence: action === 'fill' ? 'high' : 'low',
    sensitivity: 'safe',
    ...(action === 'fill' && transformation ? { transformation } : {}),
    reason,
  };
}

function phoneBlockDecisions(fields, records, profile = {}) {
  const decisions = new Map();
  const groups = new Map();
  let previousWasPhone = false;
  let previousBaseKey = '';
  let blockIndex = 0;
  for (const field of fields) {
    const concept = canonicalConcept(field.label || field.id);
    if (!PHONE_CONCEPTS.has(concept)) {
      previousWasPhone = false;
      continue;
    }
    const baseKey = phoneBlockKey(field);
    if (!previousWasPhone || previousBaseKey !== baseKey) blockIndex += 1;
    const key = `${baseKey}|${blockIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(field);
    previousWasPhone = true;
    previousBaseKey = baseKey;
  }
  const source = chooseRecord({ label: 'Phone Number', type: 'tel', autocomplete: 'tel' }, records);
  for (const group of groups.values()) {
    const numberField = group.find((field) => canonicalConcept(field.label || field.id) === 'phone_number');
    const countryField = group.find((field) => canonicalConcept(field.label || field.id) === 'phone_country_code');
    const deviceField = group.find((field) => canonicalConcept(field.label || field.id) === 'phone_device_type');
    const sourceAnswer = String(source?.record?.answer || '').trim();
    const sourceDigits = sourceAnswer.replace(/\D/g, '');
    const sourceKey = source?.record?.key ? [source.record.key] : [];
    let splitPrefix = '';
    let splitEntry = null;
    let splitAmbiguous = false;
    if (countryField && /^\s*\+\d/.test(sourceAnswer)) {
      const matches = phoneOptionEntries(countryField)
        .map((entry) => ({ entry, prefix: phoneCallingCode(entry) }))
        .filter(({ prefix }) => prefix && sourceDigits.startsWith(prefix.replace(/\D/g, '')));
      if (matches.length === 1 && phoneChoiceValue(matches[0].entry)) {
        splitPrefix = matches[0].prefix;
        splitEntry = matches[0].entry;
      } else {
        splitAmbiguous = true;
      }
    }
    if (countryField) {
      if (splitEntry && phoneChoiceValue(splitEntry)) decisions.set(countryField.id, phoneDecision(countryField, 'fill', phoneChoiceValue(splitEntry), 'Matched the unique country calling-code option', sourceKey, 'map_option'));
      else if (splitAmbiguous || sourceAnswer) decisions.set(countryField.id, phoneDecision(countryField, 'ask_user', null, splitAmbiguous ? 'Country calling-code options are ambiguous' : 'No unique country calling-code option matches the stored number'));
    }
    if (numberField) {
      if (!sourceAnswer) decisions.set(numberField.id, phoneDecision(numberField, 'ask_user', null, 'No stored phone number is available'));
      else if (countryField && !splitEntry) decisions.set(numberField.id, phoneDecision(numberField, 'ask_user', null, 'Phone number cannot be split safely without a unique country calling code'));
      else {
        const value = splitPrefix ? sourceDigits.slice(splitPrefix.replace(/\D/g, '').length) : sourceAnswer;
        decisions.set(numberField.id, phoneDecision(numberField, 'fill', value, splitPrefix ? 'Split from the stored international number' : 'Copied the stored phone number', sourceKey, 'format_phone'));
      }
    }
    if (deviceField) {
      const desired = String(profile.defaults?.phoneDeviceType || 'Mobile').trim() || 'Mobile';
      const option = phoneOptionEntries(deviceField).find((entry) => normalizeText(entry.label) === normalizeText(desired) || normalizeText(entry.value) === normalizeText(desired));
      if (option && phoneChoiceValue(option)) decisions.set(deviceField.id, phoneDecision(deviceField, 'fill', phoneChoiceValue(option), 'Profile phone device preference', [], 'map_option'));
      else decisions.set(deviceField.id, phoneDecision(deviceField, 'ask_user', null, 'Profile phone device preference is not an available option'));
    }
  }
  return decisions;
}

function isChoiceField(field = {}) {
  return ['select', 'select-one', 'radio', 'checkbox'].includes(normalizeText(field.type));
}

function visibleChoiceLabels(field = {}) {
  const labels = Array.isArray(field.structuredOptions) && field.structuredOptions.length
    ? field.structuredOptions.map((option) => option.label)
    : (Array.isArray(field.options) ? field.options : []);
  return [...new Set(labels.filter((label) => typeof label === 'string' && label.trim() && !isOpaqueIdentifier(label)))];
}

export function requiresVisibleChoiceMatch(field = {}) {
  const text = normalizeText(`${field.label || ''} ${field.name || ''} ${field.id || ''}`);
  return /\bhow did you hear\b/.test(text);
}

export function exactVisibleChoice(field, answer) {
  return isChoiceField(field) && visibleChoiceLabels(field).some((label) => normalizeText(label) === normalizeText(answer));
}

function hiringCompanyDefault(field, profile = {}, page = {}) {
  const text = normalizeText(`${field.label || ''} ${field.name || ''} ${field.id || ''}`);
  // Do not turn referrals, professional references, or broad declarations
  // into company-relationship answers.
  if (/referr|professional reference|reference contact|conflict of interest/.test(text)) return null;
  // ATS pages commonly expose the employer in the title ("Acme Careers —
  // Apply"). Use only that deliberate title shape; a generic page title stays
  // unresolved rather than receiving a guess.
  const titleCompany = String(page.title || '').match(/^\s*(.+?)\s+(?:careers?|jobs?)\b/i)?.[1] || '';
  const company = normalizeText(field.targetCompany || page.company || titleCompany);
  const employers = (profile.employment || [])
    .map((entry) => normalizeText(entry.company))
    .filter(Boolean);
  if (!employers.length) return null;
  const employer = employers.find((entry) => company === entry || ` ${text} `.includes(` ${entry} `));
  if (/have you (?:ever |previously )?(?:worked (?:at|for|with)|been employed (?:at|by|with))|former employee|prior employment/.test(text)) {
    return employer ? { value: 'Yes', reason: 'Saved prior employer; confirm relationship' } : null;
  }
  if (/relative|family member|related to/.test(text) && profile.defaultsConfirmation?.relatedToHiringCompany === 'confirmed') {
    return { value: profile.defaults?.relatedToHiringCompany || 'No', reason: 'Profile company-relationship default' };
  }
  if (/know (?:anyone|someone)|friends? (?:or )?contacts?|any contacts? (?:at|in)/.test(text) && profile.defaultsConfirmation?.knownAtHiringCompany === 'confirmed') {
    return { value: profile.defaults?.knownAtHiringCompany || 'No', reason: 'Profile company-contact default' };
  }
  return null;
}

export function planDeterministicFill(fields, records, coverMessages = [], profile = {}, page = {}) {
  const phoneDecisions = phoneBlockDecisions(fields, records, profile);
  return fields.map((field) => {
    const phonePlan = phoneDecisions.get(field.id);
    if (phonePlan) return phonePlan;
    const coverDecision = coverMessageDecision(field, coverMessages);
    if (coverDecision) return coverDecision;
    const match = chooseRecord(field, records);
    const usableMatch = match && (!requiresVisibleChoiceMatch(field) || exactVisibleChoice(field, match.record.answer)) ? match : null;
    if (!usableMatch) {
      const defaultAnswer = hiringCompanyDefault(field, profile, page);
      if (defaultAnswer) return {
        fieldId: field.id,
        action: 'fill',
        value: defaultAnswer.value,
        evidenceKeys: [],
        confidence: 'high',
        sensitivity: 'review',
        reason: defaultAnswer.reason,
      };
      if (['full_name', 'generic_name'].includes(canonicalConcept(field.label))) {
        const first = chooseRecord({ ...field, label: 'First name', autocomplete: '', id: '', name: '', placeholder: '' }, records);
        const last = chooseRecord({ ...field, label: 'Last name', autocomplete: '', id: '', name: '', placeholder: '' }, records);
        if (first && last) return { fieldId: field.id, action: 'fill', value: `${first.record.answer} ${last.record.answer}`, evidenceKeys: [first.record.key, last.record.key], confidence: 'high', sensitivity: inferSensitivity(field.label), transformation: 'compose_name', reason: 'Composed from known first and last names' };
      }
      return {
        fieldId: field.id,
        action: 'ask_user',
        value: null,
        evidenceKeys: [],
        confidence: 'low',
        sensitivity: inferSensitivity(field.label, field.id),
        reason: 'No local answer matched this field',
      };
    }
    return {
      fieldId: field.id,
      action: 'fill',
      value: usableMatch.record.answer,
      evidenceKeys: [usableMatch.record.key],
      confidence: usableMatch.confidence === 'exact' ? 'high' : usableMatch.confidence,
      sensitivity: usableMatch.record.sensitivity || inferSensitivity(field.label, field.id),
      reason: usableMatch.reason,
      matchKind: usableMatch.score === 1 ? (usableMatch.reason.startsWith('concept:') ? 'concept' : 'exact') : 'fuzzy',
    };
  }).map((decision, index) => {
    const sources = (decision.evidenceKeys || []).map(key => records.find(record => record.key === key)).filter(Boolean);
    const decorated = { ...decision, handle: fields[index].handle,
      confirmationState: sources.length && sources.every(record => record.confirmationState === 'confirmed') ? 'confirmed' : 'unconfirmed',
      reusePolicy: sources.some(record => (record.semantic?.reusePolicy || record.reusePolicy) === 'never') ? 'never' : sources.some(record => (record.semantic?.reusePolicy || record.reusePolicy) === 'review_only') ? 'review_only' : 'allowed',
      matchKind: decision.matchKind || (decision.transformation ? 'derived' : 'exact'),
    };
    return { ...decorated, ...decideDisposition(decorated, fields[index]) };
  });
}

export async function applyDecisions(document, decisions = [], { deadline = Infinity } = {}) {
  const result = { applied: [], kept: [], reviewRequired: [], unresolved: [], failed: [] };
  for (const decision of decisions) {
    try {
    if (Date.now() >= deadline) { result.unresolved.push({ fieldId: decision.fieldId, reason: 'Autofill deadline reached' }); continue; }
    const field = currentField(document, decision.fieldId);
    if (!field || (decision.handle && decision.handle !== field.handle)) {
      result.failed.push({ fieldId: decision.fieldId, reason: 'Field is no longer on the page' });
      continue;
    }
    const element = elementForField(document, decision.fieldId);
    if (decision.action === 'keep') {
      result.kept.push({ fieldId: field.id, value: field.currentValue });
      addReviewIfNeeded(result, field, decision, field.currentValue);
      continue;
    }
    if (decision.action === 'ask_user') {
      result.unresolved.push({ fieldId: field.id, label: field.label, reason: decision.reason });
      addReviewIfNeeded(result, field, decision, field.currentValue);
      continue;
    }
    if (decision.action !== 'fill') {
      result.unresolved.push({ fieldId: field.id, label: field.label, reason: decision.reason || 'Unsupported decision action' });
      continue;
    }
    const current = field.currentValue;
    if (current && decision.approved !== true) {
      result.kept.push({ fieldId: field.id, value: current });
      addReviewIfNeeded(result, field, decision, current);
      continue;
    }
    const policy = decideDisposition(decision, field);
    if (policy.disposition !== 'autofill') {
      const issue = { ...decision, field, sensitivity: effectiveSensitivity(field, decision), reason: policy.reason, disposition: policy.disposition };
      if (policy.disposition === 'review') result.reviewRequired.push(issue);
      else result.unresolved.push({ ...issue, fieldId: field.id, label: field.label });
      continue;
    }
    // Custom options may be filtered, stale, or loaded only after opening/searching.
    // Validate their exact match against the live popup in setCustomChoiceValue.
    const validation = validateFillValue(field.widget === 'custom' ? { ...field, options: [] } : field, decision.value);
    if (!validation.ok) {
      result.failed.push({ fieldId: field.id, label: field.label, value: decision.value, reason: validation.reason });
      continue;
    }
    document.__jobApplicationFilling = true;
    const fillResult = await fillElement(document, element, decision.value, deadline);
    const immediateValue = fieldValue(document, element);
    await waitForDocumentSettled(document, { quietMs: 75, minWaitMs: 120, timeoutMs: Math.max(0, Math.min(400, deadline - Date.now())) });
    const retained = fieldValue(document, element);
    const expected = field.type === 'checkbox' ? (/^(yes|true|checked)$/i.test(String(decision.value)) ? 'Yes' : 'No') : String(decision.value).trim();
    const valuesEqual = (left, right) => field.multiple
      ? left.split(/\s*[,;]\s*/).sort().join('|') === right.split(/\s*[,;]\s*/).sort().join('|')
      : left === right;
    if (fillResult?.ok && (!valuesEqual(retained, field.widget === 'custom' ? immediateValue : expected) || !currentField(document, field.id) || currentField(document, field.id).handle !== field.handle)) {
      result.failed.push({ fieldId: field.id, reason: 'The control did not retain the exact approved value after settling' });
      continue;
    }
    if (!element.isConnected || !checkValiditySafely(element) || (field.widget !== 'custom' && !fieldValue(document, element))) {
      result.failed.push({ fieldId: field.id, reason: 'The control did not retain a valid value' });
      continue;
    }
    if (!fillResult?.ok) {
      const issue = { fieldId: field.id, label: field.label, value: decision.value, reason: fillResult?.reason || 'The page rejected this value' };
      if (fillResult?.unresolved) result.unresolved.push(issue);
      else result.failed.push(issue);
      continue;
    }
    const applied = { ...decision, field, value: decision.value };
    result.applied.push(applied);
    addReviewIfNeeded(result, field, decision, decision.value);
    } catch (error) {
      result.failed.push({ fieldId: decision.fieldId, reason: error.message });
    } finally { document.__jobApplicationFilling = false; }
  }
  return result;
}

function actionLabel(element) {
  return String(element.textContent || element.value || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}

function actionKind(element, label = actionLabel(element)) {
  const type = String(element.type || '').toLowerCase();
  const nextLabel = /^(next|continue|save and continue|proceed|review application|next step)\b/i.test(label);
  const formControl = element.tagName === 'BUTTON' || element.tagName === 'INPUT';
  return nextLabel
    ? 'next'
    : formControl && /\b(submit|apply|finish|complete application|send application)\b/i.test(label)
      ? 'submit'
      : 'other';
}

function collectActions(document) {
  const actions = [];
  const candidates = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')];
  for (const [index, element] of candidates.entries()) {
    if (element.disabled || !isVisible(element) || !inApplication(document, element)) continue;
    const label = actionLabel(element);
    if (!label) continue;
    const type = String(element.type || '').toLowerCase();
    const kind = actionKind(element, label);
    actions.push({ id: `action_${actions.length}`, label, kind, type: type || element.tagName.toLowerCase() });
  }
  return actions;
}

export function isFinalApplicationSubmit(document, event) {
  const form = event?.target;
  if (!form || String(form.tagName || '').toLowerCase() !== 'form') return false;
  const root = applicationRoot(document);
  if (root !== document && root !== form) return false;
  if (root === document && !inApplication(document, form)) return false;
  const formActions = [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')]
    .filter((control) => control.form === form && !control.disabled && isVisible(control))
    .map((control) => actionKind(control));
  const hasSingleFinalAction = formActions.filter((kind) => kind === 'submit').length === 1;
  const submitter = event?.submitter;
  if (submitter) {
    return submitter.form === form
      && actionKind(submitter) === 'submit'
      && hasSingleFinalAction;
  }
  return hasSingleFinalAction && !formActions.includes('next');
}

function pauseReasons(document) {
  const reasons = [];
  const visibleText = [...(document.body?.querySelectorAll('*') || [])]
    .filter(isVisible)
    .map((element) => element.textContent || '')
    .join(' ');
  if ([...document.querySelectorAll('input[type="file"]:not([disabled])')].some((element) => isVisible(element) && !(element.files?.length || element.value))) reasons.push('file_upload');
  const captchaElement = [...document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], [id*="recaptcha" i], [class*="recaptcha" i]')].some(isVisible);
  if (captchaElement || /\bcaptcha\b/i.test(visibleText)) reasons.push('captcha');
  const loginPath = /(?:^|\/)(?:login|signin|sign-in)(?:\/|$)/i.test(document.location?.pathname || '');
  const loginForm = [...document.querySelectorAll('form[action]')].some((form) => /login|signin|sign-in/i.test(form.action || form.getAttribute('action') || ''));
  const loginHeading = [...document.querySelectorAll('h1, h2, h3')].some((element) => isVisible(element) && /^(?:sign in|log in|login)$/i.test(element.textContent.trim()));
  if ([...document.querySelectorAll('input[type="password"]:not([disabled])')].some(isVisible) || loginPath || loginForm || loginHeading) reasons.push('login');
  const unresolvedCustomWidget = customWidgetElements(document)
    .some((element) => customWidgetRequired(element) && !customWidgetValue(element));
  const contentEditable = [...document.querySelectorAll('[contenteditable="true"]')].some(isVisible);
  if (contentEditable || unresolvedCustomWidget) reasons.push('unsupported_widget');
  const nextCount = collectActions(document).filter((action) => action.kind === 'next').length;
  const submitCount = collectActions(document).filter((action) => action.kind === 'submit').length;
  if (nextCount > 1 || submitCount > 1) reasons.push('ambiguous_navigation');
  return [...new Set(reasons)];
}

export function inspectDocument(document) {
  const actions = collectActions(document);
  return {
    page: extractJobContext(document),
    fields: collectFieldDescriptors(document),
    actions,
    pauseReasons: pauseReasons(document),
  };
}

export function validateDocument(document) {
  const requiredEmpty = [];
  const invalid = [];
  for (const field of collectFieldDescriptors(document)) {
    const element = elementForField(document, field.id);
    if (field.required && !field.currentValue) requiredEmpty.push({ fieldId: field.id, label: field.label, type: field.type });
    if (!checkValiditySafely(element) || element?.getAttribute('aria-invalid') === 'true') invalid.push({ fieldId: field.id, label: field.label, type: field.type });
  }
  return { ok: requiredEmpty.length === 0 && invalid.length === 0, requiredEmpty, invalid };
}

export function collectAnswerRecords(document) {
  ensureEditTracking(document);
  const fields = collectFieldDescriptors(document);
  const invalidIds = new Set(validateDocument(document).invalid.map((field) => field.fieldId));
  const occurrenceByKey = new Map();
  return fields
    .map((field) => {
      const concept = canonicalConcept(field.label || field.id);
      const baseKey = concept === 'generic_name' ? 'full_name' : /_compensation$/.test(concept) ? slugify(field.label) : concept;
      const occurrence = (occurrenceByKey.get(baseKey) || 0) + 1;
      occurrenceByKey.set(baseKey, occurrence);
      const repeated = occurrence > 1 || /__\d+$/.test(field.id);
      const element = elementForField(document, field.id);
      const provenance = (element?.type === 'radio' ? radioGroup(document, element).some((item) => item.__jobApplicationUserEdited) : element?.__jobApplicationUserEdited)
        || element?.__jobApplicationAutofillValue == null
        ? 'user'
        : 'autofill';
      return {
        key: field.entityType && field.entityId ? `${baseKey}__${slugify(field.entityId)}` : repeated ? `${baseKey}__entry_${occurrence}` : baseKey,
        question: field.label || field.id,
        answer: field.currentValue,
        formOrder: field.formOrder,
        aliases: [field.label, field.id].filter(Boolean),
        type: field.type,
        sensitivity: inferSensitivity(field.label, field.id),
        concept: concept === 'generic_name' ? 'full_name' : concept,
        provenance,
        userEdited: Boolean(element?.type === 'radio' ? radioGroup(document, element).some((item) => item.__jobApplicationUserEdited) : element?.__jobApplicationUserEdited),
        completed: field.labelConfidence !== 'low' && element?.__jobApplicationUserCompleted !== false,
        ...(field.entityId ? { entityId: field.entityId } : {}),
        ...(field.entityType ? { entityType: field.entityType } : {}),
        ...(field.section ? { context: field.section } : {}),
        ...(repeated && !field.entityId ? { entityId: `entry-${occurrence}` } : {}),
      };
    }).filter((record) => record.answer && validateFillValue({ type: record.type }, record.answer).ok
      && !record.aliases.some((alias) => invalidIds.has(alias)));
}

export function focusField(document, fieldId) {
  const element = elementForField(document, fieldId);
  if (!element) return false;
  const className = 'job-autofill-focus-highlight';
  for (const highlighted of document.querySelectorAll(`.${className}`)) highlighted.classList.remove(className);
  const targets = new Set([element]);
  for (const label of element.labels || []) targets.add(label);
  if (element.id) {
    for (const label of document.querySelectorAll('label')) {
      if (label.htmlFor === element.id) targets.add(label);
    }
  }
  if (element.type === 'radio' || element.type === 'checkbox') {
    const group = element.closest('fieldset,[role="radiogroup"],[role="group"]');
    if (group) targets.add(group);
  }
  for (const target of targets) target.classList?.add(className);
  const styleId = 'job-autofill-focus-highlight-style';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `.${className}{outline:3px solid #d7ff45!important;outline-offset:4px!important;box-shadow:0 0 0 6px rgba(215,255,69,.28)!important;border-radius:4px!important;}`;
    document.head?.append(style);
  }
  element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  element.focus?.({ preventScroll: true });
  setTimeout(() => {
    for (const target of targets) target.classList?.remove(className);
  }, 4000);
  return true;
}

function findActionElement(document, actionId) {
  const actions = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')];
  let index = 0;
  for (const element of actions) {
    if (element.disabled || !isVisible(element) || !actionLabel(element) || !inApplication(document, element)) continue;
    const action = collectActions(document).find((candidate) => candidate.id === `action_${index}`);
    if (action?.id === actionId) return { element, action };
    index += 1;
  }
  return null;
}

export function clickAction(document, actionId) {
  const found = findActionElement(document, actionId);
  if (!found || found.action.kind !== 'next') return { ok: false, error: 'Navigation action is unavailable or not a validated Next control' };
  found.element.click();
  return { ok: true, action: found.action };
}

export function waitForDocumentSettled(document, { quietMs = 150, minWaitMs = 400, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let changed = started;
    let timer;
    const observer = document.defaultView?.MutationObserver ? new document.defaultView.MutationObserver(() => { changed = Date.now(); }) : null;
    const finish = () => { clearTimeout(timer); observer?.disconnect(); resolve(); };
    const check = () => {
      const now = Date.now();
      if (now - started >= timeoutMs || (now - started >= minWaitMs && now - changed >= quietMs)) return finish();
      timer = setTimeout(check, 25);
    };
    if (document.documentElement) observer?.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    check();
  });
}
