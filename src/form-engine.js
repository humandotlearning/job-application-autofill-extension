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
import { composedParent, composedClosest, composedContains, composedText, queryAll, rootElementById, deepActiveElement, eventControl, isExtensionElement, withDomSnapshot, domMemo, createDomIndex } from './dom.js';

const IGNORED_TYPES = new Set(['hidden', 'password', 'file', 'submit', 'button', 'reset', 'image', 'search']);
const SECRET_MARKER = /(?:password|passcode|passwd|pwd|secret|token|csrf|auth[_-]?token)/i;
const CUSTOM_WIDGET_SELECTOR = '[role="combobox"], button[aria-haspopup="listbox"]';
const EMPTY_CUSTOM_WIDGET_VALUE = /^(?:choose|select)\b/i;
const CUSTOM_WIDGET_PROMPT_LABEL = /^(?:choose|select)(?:\s+(?:one|an?\s+option|an?\s+answer|a\s+value))?$/i;
const trackedDocuments = new WeakSet();
const controlHandles = new WeakMap();
const documentHandles = new WeakMap();
const applicationSelections = new WeakMap();
const applicationFieldSelections = new WeakMap();

function documentIdentity(document) {
  controlHandle(document.documentElement);
  return documentHandles.get(document).id;
}

export function clearApplicationSelection(document) { applicationSelections.delete(document); applicationFieldSelections.delete(document); }

export function selectApplicationField(document, element) {
  if (!element?.isConnected || element.ownerDocument !== document || isExtensionElement(element) || !isSupported(element) || !isVisible(element)) return null;
  clearApplicationSelection(document);
  applicationFieldSelections.set(document, {element, documentId: documentIdentity(document)});
  return {documentId: documentIdentity(document), regionId: null};
}

function isUtilityRegion(region) {
  const label = [region.id, region.getAttribute('role'), region.getAttribute('aria-label'), region.getAttribute('name'),
    ...queryAll(region, 'h1,h2,h3,legend').filter(el => composedClosest(el, 'form,[role="form"]') === region).map(composedText),
    ...queryAll(region, 'button,input[type="submit"]').filter(el => composedClosest(el, 'form,[role="form"]') === region).map(actionLabel)].join(' ');
  return /\b(?:subscribe|newsletter|job.?alerts?|login|sign.?in)\b/i.test(label)
    || region.getAttribute('role') === 'search' || /^search$/i.test(region.id || '');
}

function applicationRegions(document) {
  return domMemo(document, 'regions', () => {
    const controls = queryAll(document, 'input,textarea,select,[role="combobox"]')
      .filter(el => (isSupported(el) || el.matches(CUSTOM_WIDGET_SELECTOR)) && isVisible(el));
    const forms = queryAll(document, 'form,[role="form"]').filter(isVisible);
    const candidates = forms.filter(form => {
      const owned = controls.filter(el => (composedClosest(el, 'form,[role="form"]') || el.form) === form);
      return owned.length && !isUtilityRegion(form);
    });
    const outside = controls.filter(el => !composedClosest(el, 'form,[role="form"],[role="search"],nav'));
    if (outside.length) {
      const mains = [...new Set(outside.map(el => composedClosest(el, 'main,[role="main"]') || document))];
      candidates.push(...mains.filter(root => !candidates.some(form => composedContains(root, form))));
    }
    return {candidates, controls};
  });
}

export function selectApplicationRegion(document, element) {
  return withDomSnapshot(document, () => {
    if (!element?.isConnected || element.ownerDocument !== document || isExtensionElement(element) || !isVisible(element)) return null;
    const {candidates, controls} = applicationRegions(document);
    const control = controls.find(el => el === element || composedContains(el, element));
    if (!control) return null;
    const owner = composedClosest(control, 'form,[role="form"]') || control.form;
    const region = candidates.includes(owner) ? owner : candidates.find(root => composedContains(root, control));
    if (!region) return null;
    applicationFieldSelections.delete(document);
    applicationSelections.set(document, {region, documentId: documentIdentity(document)});
    return {documentId: documentIdentity(document), regionId: region === document ? 'document' : controlHandle(region)};
  });
}

export function applicationDestination(document) {
  return withDomSnapshot(document, () => {
    const root = applicationRoot(document);
    return {documentId: documentIdentity(document), regionId: root.nodeType === 11 ? null : root === document ? 'document' : controlHandle(root)};
  });
}

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
  const fieldSelection = applicationFieldSelections.get(document);
  if (fieldSelection && fieldSelection.documentId === documentIdentity(document) && fieldSelection.element.isConnected) return document.createDocumentFragment();
  if (fieldSelection) applicationFieldSelections.delete(document);
  const selection = applicationSelections.get(document);
  if (selection && selection.documentId === documentIdentity(document)
    && (selection.region === document || selection.region.isConnected)) return selection.region;
  if (selection) applicationSelections.delete(document);
  const {candidates} = applicationRegions(document);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return document.createDocumentFragment();
  return document;
}

function inApplication(document, element) {
  const root = applicationRoot(document);
  if (isExtensionElement(element)) return false;
  const selectedField = applicationFieldSelections.get(document)?.element;
  if (selectedField) return element === selectedField;
  if (root !== document) {
    const owner = composedClosest(element, 'form,[role="form"]') || element.form;
    if (owner && owner !== root && applicationRegions(document).candidates.includes(owner)) return false;
    return composedContains(root, element) || element.form === root;
  }
  const owner = composedClosest(element, 'form,[role="form"],[role="search"],nav');
  return !owner || !isUtilityRegion(owner);
}

function ensureEditTracking(document) {
  if (trackedDocuments.has(document)) return;
  const markEdited = (event) => {
    let element = eventControl(event);
    if (isExtensionElement(element)) return;
    if (!element || element.__jobApplicationAutofillDispatch || (document.__jobApplicationFilling && !event.isTrusted)) return;
    if (event.type === 'click') {
      const listbox = composedClosest(composedClosest(element, '[role="option"]'), '[role="listbox"]');
      if (!listbox?.id) return;
      element = customWidgetElements(document).find((widget) => widget.getRootNode() === listbox.getRootNode() && String(widget.getAttribute('aria-controls') || widget.getAttribute('aria-owns') || '').split(/\s+/).includes(listbox.id));
      if (!element) return;
      delete element.__jobApplicationSearchQuery;
    }
    if (event.type === 'blur' && !element.__jobApplicationUserEdited) return;
    if (event.type === 'input' || event.type === 'change') {
      element.__jobApplicationEditRevision = (element.__jobApplicationEditRevision || 0) + 1;
    }
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
  const description = [...queryAll(document, '[itemprop="description"],.job-description,#job-description,[data-testid="job-description"],.posting-page .section-wrapper,.posting-description')]
    .map(node => readable(node)).filter(Boolean).join('\n').slice(0, 16000);
  return {
    title: document.title || '', domain: document.location?.hostname || '',
    role: readable(document.querySelector('[itemprop="title"],h1'), 300),
    company: readable(document.querySelector('[itemprop="hiringOrganization"],.company-name'), 300),
    jobDescription: description,
  };
}

function textFromIds(element, ids = '') {
  return String(ids)
    .split(/\s+/)
    .map((id) => rootElementById(element, id) ? labelText(rootElementById(element, id)) : '')
    .filter(Boolean)
    .join(' ');
}

function cleanLabelString(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  // Phone widgets often append their complete country menu to the accessible
  // name. Keep the question and leave the menu entries in structured options.
  const phoneMenu = /^((?:phone|mobile|telephone)(?:\s+number)?)\s*[*:]?\s*Afghanistan\b.*\+93\s*Albania\b.*\+355/i.exec(text);
  if (phoneMenu) return phoneMenu[1];
  return text.replace(/\s*[*✱]+\s*$/, '').trim();
}

function labelText(label) {
  const excluded = 'script,style,input,textarea,select,button,[role="combobox"],[role="listbox"],[role="option"],[role="menu"],.iti__country-list,.country-list,[hidden],[aria-hidden="true"]';
  function read(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    // Explicit aria-labelledby references may themselves be hidden. Exclude
    // nested widget content without discarding the referenced label root.
    if (node !== label) {
      if (node.matches(excluded)) return '';
      const style = node.ownerDocument.defaultView?.getComputedStyle(node);
      if (style?.display === 'none' || style?.visibility === 'hidden' || style?.contentVisibility === 'hidden') return '';
    }
    const assigned = node.tagName === 'SLOT' ? node.assignedNodes?.({flatten: true}) : null;
    return [...(assigned?.length ? assigned : node.shadowRoot?.childNodes || node.childNodes)].map(read).join('');
  }
  return cleanLabelString(read(label));
}

function nearbyQuestion(element) {
  const controls = 'input:not([type="hidden"]),textarea,select,[role="combobox"],button[aria-haspopup="listbox"]';
  for (let wrapper = composedParent(element), depth = 0; wrapper && depth < 6; wrapper = composedParent(wrapper), depth++) {
    if (wrapper.matches('form,section,main,body')) break;
    const peers = [...queryAll(wrapper, controls)].filter(isVisible);
    if (peers.some(peer => peer !== element && !(['radio', 'checkbox'].includes(element.type) && peer.type === element.type
      && element.name && peer.name === element.name && peer.form === element.form))) break;
    const candidates = [...queryAll(wrapper, '.application-label .text,h3,h4,[role="heading"],legend,label')]
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
  if (checkboxGroup(document, element).length > 1) {
    const container = checkboxContainer(element);
    const heading = container?.querySelector(':scope > legend,.application-label');
    const question = container && (textFromIds(container, container.getAttribute('aria-labelledby'))
      || container.getAttribute('aria-label') || (heading && labelText(heading)));
    const nearby = question || nearbyQuestion(element);
    return {label: nearby || '', labelSource: nearby ? 'group' : 'identity', labelConfidence: nearby ? 'high' : 'low'};
  }
  if (element.type === 'radio') {
    const group = composedClosest(element, 'fieldset,[role="radiogroup"],[role="group"]');
    const explicit = group && (textFromIds(group, group.getAttribute('aria-labelledby')) || group.getAttribute('aria-label') || group.querySelector(':scope > legend')?.textContent?.trim());
    if (explicit) return { label: explicit, labelSource: 'group', labelConfidence: 'high' };
    const peers = radioGroup(document, element);
    const aria = peer => textFromIds(peer, peer.getAttribute('aria-labelledby')) || peer.getAttribute('aria-label') || '';
    const shared = aria(element);
    if (shared && peers.length > 1 && peers.every(peer => aria(peer) === shared)) return { label: shared, labelSource: 'shared-aria', labelConfidence: 'high' };
    const nearby = nearbyQuestion(element);
    return { label: nearby || element.name || element.id || '', labelSource: nearby ? 'nearby-question' : 'identity', labelConfidence: nearby ? 'high' : 'low' };
  }
  const explicit = cleanLabelString(native || element.getAttribute('aria-label') || textFromIds(element, element.getAttribute('aria-labelledby')));
  const nearby = !explicit && nearbyQuestion(element);
  const placeholder = cleanLabelString(element.getAttribute('placeholder'));
  return { label: explicit || nearby || placeholder || element.name || element.id || '',
    labelSource: explicit ? 'explicit' : nearby ? 'nearby-question' : placeholder ? 'placeholder' : 'identity',
    labelConfidence: explicit || nearby || (placeholder && !isOpaqueIdentifier(placeholder)) ? 'high' : 'low' };
}

function labelFor(document, element) {
  if (element.type === 'radio') {
    const legend = composedClosest(element, 'fieldset')?.querySelector('legend')?.textContent?.trim();
    if (legend) return legend;
  }
  const nativeLabel = [...(element.labels || [])]
    .map(labelText)
    .filter(Boolean)
    .join(' ');
  return nativeLabel
    || element.getAttribute('aria-label')
    || textFromIds(element, element.getAttribute('aria-labelledby'))
    || element.getAttribute('placeholder')
    || element.getAttribute('name')
    || element.id
    || '';
}

function isSupported(element) {
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return false;
  if (element.getAttribute('role') === 'combobox' || element.getAttribute('aria-haspopup') === 'listbox') return false;
  if (composedClosest(composedParent(element), CUSTOM_WIDGET_SELECTOR)) return false;
  if (isControlDisabled(element) || element.readOnly || element.getAttribute('aria-readonly') === 'true') return false;
  if (IGNORED_TYPES.has(String(element.type || '').toLowerCase())) return false;
  return !SECRET_MARKER.test(`${element.name || ''} ${element.id || ''} ${element.autocomplete || ''}`);
}

function isControlDisabled(element) {
  return Boolean(element.disabled || element.matches(':disabled') || composedClosest(element, '[aria-disabled="true"],[inert]'));
}

function isVisible(element) {
  return domMemo(element.ownerDocument, element, () => isVisibleUncached(element));
}

function isVisibleUncached(element) {
  for (let current = element; current; current = composedParent(current)) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
    const style = current.getAttribute('style') || '';
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return false;
    const computed = current.ownerDocument.defaultView?.getComputedStyle?.(current);
    if (computed && (computed.display === 'none' || computed.visibility === 'hidden' || computed.contentVisibility === 'hidden')) return false;
  }
  return true;
}

function visualRect(element) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

function hasNativeFormAction(element) {
  // Use the live native type/form owner: missing or invalid button types submit,
  // and the form attribute can associate a control outside the form subtree.
  const control = composedClosest(element, 'button, input');
  return Boolean(control?.form && ['submit', 'reset', 'image'].includes(control.type));
}

function customWidgetElements(document) {
  return domMemo(document, 'customWidgets', () => [...queryAll(document, CUSTOM_WIDGET_SELECTOR)]
    .filter((element) => !hasNativeFormAction(element))
    .filter((element) => inApplication(document, element) && !isControlDisabled(element) && !element.readOnly && element.getAttribute('aria-readonly') !== 'true')
    .filter((element) => isVisible(element))
    .filter((element) => composedClosest(element, 'form, main, [role="main"]') || hasNearbyFormControl(element))
    .filter((element) => element.getAttribute('aria-label') || element.getAttribute('name')
      || textFromIds(element, element.getAttribute('aria-labelledby')) || associatedLabelText(document, element) || hasNearbyFormControl(element)));
}

function hasNearbyFormControl(element) {
  return [...(element.parentElement?.children || [])]
    .some((sibling) => sibling !== element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(sibling.tagName));
}

function customWidgetValue(element) {
  const liveState = JSON.stringify([element.value || '', element.getAttribute('aria-valuetext') || '', composedText(element)]);
  if (element.__jobApplicationCommittedState !== liveState) delete element.__jobApplicationCommittedLabel;
  const selectedOptions = customWidgetOptions(element.ownerDocument, element)
    .filter((option) => option.getAttribute('aria-selected') === 'true')
    .map(customOptionText)
    .filter(Boolean);
  const typedValue = element.__jobApplicationSearchQuery || (element.getAttribute('aria-expanded') === 'true' && element.__jobApplicationUserEdited) ? '' : element.value;
  const value = String(selectedOptions.length ? selectedOptions.join(', ') : (element.getAttribute('aria-valuetext') || element.__jobApplicationCommittedLabel || typedValue || composedText(element) || ''))
    .replace(/\s+/g, ' ').trim();
  return EMPTY_CUSTOM_WIDGET_VALUE.test(value) || isOpaqueIdentifier(value) ? '' : value;
}

function customWidgetRequired(element) {
  return element.getAttribute('aria-required') === 'true'
    || /\brequired\b/i.test(element.getAttribute('aria-label') || '')
    || Boolean(element.required);
}

function visibleText(element) {
  return cleanLabelString(element?.textContent || '');
}

function associatedLabelText(document, element) {
  const labels = [...(element.labels || [])]
    .map(labelText)
    .filter(Boolean);
  if (labels.length) return labels.join(' ');
  if (!element.id) return '';
  const explicit = [...queryAll(document, 'label')]
    .filter((label) => label.getRootNode() === element.getRootNode() && label.getAttribute('for') === element.id)
    .map(labelText)
    .filter(Boolean);
  return explicit.join(' ');
}

function nearestFieldGroupLabel(element) {
  const group = composedClosest(element, 'fieldset, [role="group"]');
  if (!group) return '';
  for (const current of [group]) {
    const candidates = [...queryAll(current, 'label, legend')]
      .map((candidate) => visibleText(candidate))
      .filter(Boolean);
    const unique = [...new Set(candidates)];
    if (unique.length === 1) return unique[0];
  }
  return '';
}

function fieldContext(element) {
  const group = composedClosest(element, 'fieldset, [role="group"], section, form');
  if (!group) return {};
  const heading = group.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > [role="heading"]');
  const section = visibleText(heading);
  const contextText = `${section} ${group.id} ${group.getAttribute('data-automation-id') || ''}`;
  const entityType = /employment|work.?experience|work.?history/i.test(contextText) ? 'employment'
    : /education|school|university/i.test(contextText) ? 'education' : '';
  const entityId = group.getAttribute('data-entity-id') || (entityType || /reference|referee|emergency|supervisor/i.test(contextText) ? group.id || group.getAttribute('name') : '')
    || (entityType ? `${entityType}-${[...queryAll(element.ownerDocument, 'fieldset,[role="group"],section')].indexOf(group) + 1}` : '');
  return {
    ...(section ? { section } : {}),
    ...(entityId ? { entityId } : {}),
    ...(entityType ? { entityType } : {}),
  };
}

function customWidgetLabel(document, element) {
  const associated = associatedLabelText(document, element);
  if (associated) return associated;
  const labelledBy = textFromIds(element, element.getAttribute('aria-labelledby'));
  if (labelledBy) return labelledBy;
  const fieldGroupLabel = nearestFieldGroupLabel(element) || nearbyQuestion(element);
  if (fieldGroupLabel) return fieldGroupLabel;

  const displayed = customWidgetValue(element);
  const ariaLabel = cleanLabelString(element.getAttribute('aria-label') || '');
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
  return String(element.getAttribute('aria-label') || composedText(element) || '').replace(/\s+/g, ' ').trim();
}

function customOptionValue(element) {
  return String(element.getAttribute('data-value') || element.getAttribute('value') || '').trim();
}

function customOptionAliases(option) {
  const label = customOptionText(option);
  // SuccessFactors picklists prefix display labels with an ordinal ("4 - Bachelor's degree").
  const unnumbered = composedClosest(option, '.sf-list-select') ? label.replace(/^\d+\s+[-–—]\s+(?=[A-Za-z])/, '') : label;
  return [label, unnumbered, customOptionValue(option)].filter(Boolean).map(normalizeText);
}

function matchingCustomOptions(options, value) {
  const exact = options.filter((option) => [customOptionText(option), customOptionValue(option)].map(normalizeText).includes(value));
  return exact.length ? exact : options.filter((option) => customOptionAliases(option).includes(value));
}

function customWidgetOptions(document, element) {
  const ids = String(element.getAttribute('aria-controls') || element.getAttribute('aria-owns') || '').split(/\s+/).filter(Boolean);
  const listboxes = ids.length
    ? ids.map((id) => rootElementById(element, id)).filter(Boolean).flatMap((node) => node.matches('[role="listbox"]') ? [node] : [...queryAll(node, '[role="listbox"]')])
    : [...queryAll(document, '[role="listbox"]')];
  const visibleListboxes = listboxes
    .filter((listbox) => isVisible(listbox))
    .filter((listbox) => ids.length || (listboxes.length === 1 && ![...queryAll(document, CUSTOM_WIDGET_SELECTOR)].some((owner) => owner !== element && String(owner.getAttribute('aria-controls') || owner.getAttribute('aria-owns') || '').split(/\s+/).includes(listbox.id))));
  return visibleListboxes
    .flatMap((listbox) => [...queryAll(listbox, '[role="option"]')])
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
  return domMemo(document, 'formElements', () => queryAll(document, 'input, textarea, select').filter((element) => isSupported(element) && isVisible(element) && inApplication(document, element)));
}

function uniqueFields(document) {
  const fields = [];
  const seenRadioGroups = new Set();
  for (const [index, element] of formElements(document).entries()) {
    if (element.type === 'checkbox' && checkboxGroup(document, element)[0] !== element) continue;
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
  const checkboxes = checkboxGroup(document, element);
  if (checkboxes.length > 1) return checkboxes.map(optionText).filter(Boolean);
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
    const group = checkboxGroup(document, element);
    if (group.length > 1) return group.filter(candidate => candidate.checked).map(optionText).join(', ');
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
  const checkboxes = checkboxGroup(document, element);
  const grouped = checkboxes.length > 1;
  const type = grouped || element.tagName === 'SELECT' ? 'select' : element.tagName === 'TEXTAREA' ? 'textarea' : (element.type || 'text');
  const descriptor = {
    id: fieldIdentity(element, index, [...formElements(document), ...customWidgetElements(document)]),
    handle: controlHandle(element),
    multiple: grouped || Boolean(element.multiple),
    ...(grouped ? {widget: 'checkbox-group'} : {}),
    selectedValues: element.tagName === 'SELECT' ? [...element.selectedOptions].filter((option) => option.value).map((option) => option.value) : [],
    structuredOptions: element.tagName === 'SELECT' ? [...element.options].map((option) => ({ label: option.textContent.trim(), value: option.value, selected: option.selected, disabled: option.disabled })) : [],
    ...questionMetadata(document, element),
    helpText: textFromIds(element, element.getAttribute('aria-describedby')).slice(0, 2000),
    nearbyContext: nearbyQuestion(element).slice(0, 1000),
    type,
    autocomplete: element.autocomplete || '',
    placeholder: element.getAttribute('placeholder') || '',
    required: (grouped ? checkboxes : [element]).some(candidate => candidate.required || candidate.getAttribute('aria-required') === 'true'),
    currentValue: fieldValue(document, element),
    options: fieldOptions(document, element),
    constraints: constraintsFor(element),
    ...fieldContext(element),
  };
  if (element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' && !['checkbox', 'radio'].includes(String(element.type || '').toLowerCase()))) {
    descriptor.rawValue = String(element.value ?? '');
    descriptor.editRevision = element.__jobApplicationEditRevision || 0;
  }
  return descriptor;
}

export function collectFieldDescriptors(document) {
  return withDomSnapshot(document, () => collectFieldDescriptorsImpl(document));
}

function collectFieldDescriptorsImpl(document) {
  ensureEditTracking(document);
  const nativeFields = uniqueFields(document).map(({ element, index }) => ({ element, field: describeField(document, element, index) }));
  const customElements = customWidgetElements(document);
  const customFields = customElements
    .filter(element => !nativeFields.some(({element: native}) => native === element))
    .map((element, index) => ({ element, field: {
      id: fieldIdentity(element, formElements(document).length + index, [...formElements(document), ...customElements]),
      handle: controlHandle(element),
      multiple: element.getAttribute('aria-multiselectable') === 'true' || rootElementById(element, element.getAttribute('aria-controls'))?.getAttribute('aria-multiselectable') === 'true',
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
      return withDomSnapshot(document, index => index.order.get(left) - index.order.get(right));
    })
    .map(({ field }, formOrder) => ({ ...field, formOrder }));
  const groupKey = (field) => `${canonicalConcept(field.label)}:${field.entityId || ''}`;
  const confirmation = field => !field.entityType && canonicalConcept(field.label) === 'email' && /confirm|repeat|re.?enter/i.test(field.label);
  const counts = new Map();
  const occurrences = new Map();
  for (const field of fields) if (!confirmation(field)) counts.set(groupKey(field), (counts.get(groupKey(field)) || 0) + 1);
  return fields.map((field) => {
    if (confirmation(field)) return field;
    const key = groupKey(field);
    const occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    return counts.get(key) > 1 ? { ...field, entityId: `${field.entityId || 'entry'}-${occurrence}` } : field;
  });
}

export function descriptorForElement(document, element) {
  if (!element || element.ownerDocument !== document || !element.isConnected) return null;
  const handle = controlHandle(checkboxGroup(document, element)[0] || element);
  const described = collectFieldDescriptors(document).find((field) => field.handle === handle);
  if (described) return described;
  // Inline focus can scope one field without granting bulk-fill authority.
  if (deepActiveElement(document) !== element && document.__jobApplicationInlineFocusAnchor !== element) return null;
  const previous = applicationFieldSelections.get(document);
  const previousRegion = applicationSelections.get(document);
  if (!selectApplicationField(document, element)) return null;
  try { return collectFieldDescriptors(document).find(field => field.handle === handle) || null; }
  finally {
    if (previous) applicationFieldSelections.set(document, previous); else applicationFieldSelections.delete(document);
    if (previousRegion) applicationSelections.set(document, previousRegion);
  }
}

function dispatchFormEvents(element) {
  const view = element.ownerDocument.defaultView;
  element.__jobApplicationAutofillDispatch = true;
  try {
    for (const eventName of ['input', 'change', 'blur']) {
      element.dispatchEvent(new view.Event(eventName, { bubbles: true, composed: true }));
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
  if (element?.getAttribute('aria-invalid') === 'true') return false;
  const checkboxes = element && checkboxGroup(element.ownerDocument, element);
  if (checkboxes?.length > 1) return !checkboxes.some(candidate => candidate.getAttribute('aria-invalid') === 'true' || candidate.validity?.customError)
    && (!checkboxes.some(candidate => candidate.required || candidate.getAttribute('aria-required') === 'true') || checkboxes.some(candidate => candidate.checked));
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
  return formElements(document).filter((candidate) => candidate.type === 'radio' && (element.name ? candidate.name === element.name && candidate.form === element.form && candidate.getRootNode() === element.getRootNode() : candidate === element));
}

function checkboxContainer(element) {
  return composedClosest(element, '.application-question,fieldset,[role="group"]');
}

function checkboxGroup(document, element) {
  if (element?.type !== 'checkbox') return [];
  const container = checkboxContainer(element);
  if (!container && !element.name) return [element];
  const peers = formElements(document).filter(candidate => candidate.type === 'checkbox'
    && candidate.form === element.form && candidate.getRootNode() === element.getRootNode()
    && checkboxContainer(candidate) === container);
  const names = new Set(peers.map(candidate => candidate.name).filter(Boolean));
  // Lever includes a nameless Custom option alongside its named pronoun choices.
  // Generic fieldsets may instead contain unrelated consent checkboxes.
  return container?.matches('.application-question') && names.size <= 1 ? peers
    : peers.filter(candidate => element.name ? candidate.name === element.name : candidate === element);
}

function setCheckboxGroup(document, element, answer) {
  const group = checkboxGroup(document, element);
  const exact = group.find(candidate => normalizeText(optionText(candidate)) === normalizeText(answer));
  const requested = exact ? [exact] : String(answer).split(/\s*[,;]\s*/).map(value =>
    group.find(candidate => normalizeText(optionText(candidate)) === normalizeText(value)));
  if (!requested.length || requested.some(candidate => !candidate)) return false;
  for (const candidate of group) {
    candidate.__jobApplicationAutofillValue = String(answer);
    delete candidate.__jobApplicationUserEdited;
    if (candidate.checked !== requested.includes(candidate)) {
      candidate.checked = requested.includes(candidate);
      dispatchFormEvents(candidate);
    }
  }
  return true;
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
  if (!selectionCommitted && element.tagName !== 'INPUT') return {ok: false, unresolved: true, reason: 'The custom widget did not accept the selected option'};
  if (selectionCommitted) {
    element.__jobApplicationCommittedLabel = customOptionText(matches[0]);
    element.__jobApplicationCommittedState = JSON.stringify([element.value || '', element.getAttribute('aria-valuetext') || '', composedText(element)]);
  }
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
  if (element.type === 'checkbox') return { ok: checkboxGroup(document, element).length > 1
    ? setCheckboxGroup(document, element, answer) : setCheckbox(element, answer) };
  return { ok: setTextValue(element, answer) };
}

function elementsForField(document, fieldId) {
  const nativeElements = formElements(document);
  const nativeMatch = nativeElements.find((element, index) => fieldIdentity(element, index, [...nativeElements, ...customWidgetElements(document)]) === fieldId);
  if (nativeMatch) return [nativeMatch];
  const customFields = customWidgetElements(document);
  const generatedCustomIndex = customFields.findIndex((element, index) => fieldIdentity(element, nativeElements.length + index, [...nativeElements, ...customFields]) === fieldId);
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

export async function applyDecisions(document, decisions = [], { deadline = Infinity, beforeFill = () => true } = {}) {
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
    const hasExpectedRawValue = Object.hasOwn(decision, 'expectedRawValue');
    const hasExpectedEditRevision = Object.hasOwn(decision, 'expectedEditRevision');
    const rawValueMatches = !hasExpectedRawValue || String(element?.value ?? '') === String(decision.expectedRawValue);
    const editRevisionMatches = !hasExpectedEditRevision || (element?.__jobApplicationEditRevision || 0) === decision.expectedEditRevision;
    if (!beforeFill({field, element, decision}) || !rawValueMatches || !editRevisionMatches) {
      result.failed.push({ fieldId: field.id, reason: 'The field changed before the answer could be applied' });
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
  return String(element.getAttribute('aria-label') || composedText(element) || element.value || '').replace(/\s+/g, ' ').trim();
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
  const candidates = [...queryAll(document, 'button, input[type="submit"], input[type="button"], a, [role="button"]')];
  for (const [index, element] of candidates.entries()) {
    if (isControlDisabled(element) || !isVisible(element) || !inApplication(document, element)) continue;
    const label = actionLabel(element);
    if (!label) continue;
    const type = String(element.type || '').toLowerCase();
    const kind = actionKind(element, label);
    actions.push({ id: `action_${actions.length}`, handle: controlHandle(element), label, kind, type: type || element.tagName.toLowerCase() });
  }
  return actions;
}

export function isFinalApplicationSubmit(document, event) {
  const form = event?.target;
  if (!form || String(form.tagName || '').toLowerCase() !== 'form') return false;
  const root = applicationRoot(document);
  if (root !== document && root !== form) return false;
  if (root === document && !inApplication(document, form)) return false;
  const formActions = [...queryAll(document, 'button, input[type="submit"], input[type="button"]')]
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
  const visibleText = composedText(document.body);
  if ([...queryAll(document, 'input[type="file"]:not([disabled])')].some((element) => isVisible(element) && !(element.files?.length || element.value))) reasons.push('file_upload');
  const captchaElement = [...queryAll(document, '[id*="captcha" i], [class*="captcha" i], [id*="recaptcha" i], [class*="recaptcha" i]')].some(isVisible);
  if (captchaElement || /\bcaptcha\b/i.test(visibleText)) reasons.push('captcha');
  const loginPath = /(?:^|\/)(?:login|signin|sign-in)(?:\/|$)/i.test(document.location?.pathname || '');
  const loginForm = [...queryAll(document, 'form[action]')].some((form) => /login|signin|sign-in/i.test(form.action || form.getAttribute('action') || ''));
  const loginHeading = [...queryAll(document, 'h1, h2, h3')].some((element) => isVisible(element) && /^(?:sign in|log in|login)$/i.test(element.textContent.trim()));
  if ([...queryAll(document, 'input[type="password"]:not([disabled])')].some(isVisible) || loginPath || loginForm || loginHeading) reasons.push('login');
  const unresolvedCustomWidget = customWidgetElements(document)
    .some((element) => customWidgetRequired(element) && !customWidgetValue(element));
  const contentEditable = [...queryAll(document, '[contenteditable="true"]')].some(isVisible);
  if (contentEditable || unresolvedCustomWidget) reasons.push('unsupported_widget');
  const nextCount = collectActions(document).filter((action) => action.kind === 'next').length;
  const submitCount = collectActions(document).filter((action) => action.kind === 'submit').length;
  if (nextCount > 1 || submitCount > 1) reasons.push('ambiguous_navigation');
  return [...new Set(reasons)];
}

export function inspectDocument(document) {
  const started = Date.now();
  const inspection = withDomSnapshot(document, () => inspectDocumentImpl(document));
  inspection.discovery.elapsedMs = Date.now() - started;
  return inspection;
}

function inspectDocumentImpl(document) {
  const started = Date.now();
  const actions = collectActions(document);
  const fields = collectFieldDescriptors(document);
  const destination = applicationDestination(document);
  const root = applicationRoot(document);
  const dialog = composedClosest(root, 'dialog,[role="dialog"]');
  // Portal dialogs often put the application heading outside the form.
  // Restrict this hint to the selected region and its dialog, not the whole page.
  const applicationLabel = [...new Set([root, dialog].filter(node => node?.nodeType === 1))]
    .filter(isVisible)
    .flatMap(node => [node.getAttribute('aria-label'), textFromIds(node, node.getAttribute('aria-labelledby')),
      ...queryAll(node, 'h1,h2,h3,legend').filter(isVisible).map(labelText)])
    .filter(Boolean).join(' ').slice(0, 1000);
  const {candidates, controls} = applicationRegions(document);
  const view = document.defaultView;
  const regions = candidates.map(region => ({
    regionId: region === document ? 'document' : controlHandle(region),
    rect: visualRect(region === document ? document.documentElement : region),
  })).filter(region => region.rect);
  const redactions = queryAll(document, 'input,textarea,select,[contenteditable="true"],iframe')
    .filter(isVisible).map(visualRect).filter(Boolean);
  return {
    page: extractJobContext(document),
    applicationLabel,
    fields,
    actions,
    pauseReasons: pauseReasons(document),
    destination,
    visualContext: {
      viewport: {width: Number(view?.innerWidth) || 0, height: Number(view?.innerHeight) || 0},
      regions,
      redactions,
    },
    discovery: {code: !destination.regionId ? 'ambiguous_form' : fields.length ? 'ready' : 'no_supported_controls',
      regionCount: candidates.length, controlCount: controls.length,
      shadowRootCount: withDomSnapshot(document, index => index.roots.length - 1), elapsedMs: Date.now() - started},
  };
}

export function validateDocument(document) {
  return withDomSnapshot(document, () => validateDocumentImpl(document));
}

function validateDocumentImpl(document) {
  const requiredEmpty = [];
  const invalid = [];
  for (const field of collectFieldDescriptors(document)) {
    const element = elementForField(document, field.id);
    if (field.required && !field.currentValue) requiredEmpty.push({ fieldId: field.id, label: field.label, type: field.type });
    if (!checkValiditySafely(element) || element?.getAttribute('aria-invalid') === 'true') invalid.push({ fieldId: field.id, label: field.label, type: field.type });
  }
  return { ok: requiredEmpty.length === 0 && invalid.length === 0, requiredEmpty, invalid };
}

export function collectAnswerRecords(document, { finalize = false } = {}) {
  return withDomSnapshot(document, () => collectAnswerRecordsImpl(document, finalize));
}

function collectAnswerRecordsImpl(document, finalize) {
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
      const userEdited = (element?.type === 'radio' ? radioGroup(document, element)
        : element?.type === 'checkbox' ? checkboxGroup(document, element) : [element]).some(item => item?.__jobApplicationUserEdited);
      const provenance = userEdited
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
        userEdited,
        completed: field.labelConfidence !== 'low' && (finalize || element?.__jobApplicationUserCompleted !== false),
        ...(field.entityId ? { entityId: field.entityId } : {}),
        ...(field.entityType ? { entityType: field.entityType } : {}),
        ...(field.section ? { context: field.section } : {}),
        ...(repeated && !field.entityId ? { entityId: `entry-${occurrence}` } : {}),
      };
    }).filter((record) => record.answer && validateFillValue({ type: record.type }, record.answer).ok
      && !record.aliases.some((alias) => invalidIds.has(alias)));
}

export function focusField(document, fieldId, expectedHandle) {
  const element = elementForField(document, fieldId);
  if (!element || (expectedHandle !== undefined && controlHandle(element) !== expectedHandle)) return false;
  const className = 'job-autofill-focus-highlight';
  for (const highlighted of queryAll(document, `.${className}`)) highlighted.classList.remove(className);
  const targets = new Set([element]);
  for (const label of element.labels || []) targets.add(label);
  if (element.id) {
    for (const label of queryAll(document, 'label')) {
      if (label.getRootNode() === element.getRootNode() && label.htmlFor === element.id) targets.add(label);
    }
  }
  if (element.type === 'radio' || element.type === 'checkbox') {
    const group = composedClosest(element, 'fieldset,[role="radiogroup"],[role="group"]');
    if (group) targets.add(group);
  }
  for (const target of targets) target.classList?.add(className);
  const styleId = 'job-autofill-focus-highlight-style';
  const styleRoot = element.getRootNode();
  if (!styleRoot.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `.${className}{outline:3px solid #d7ff45!important;outline-offset:4px!important;box-shadow:0 0 0 6px rgba(215,255,69,.28)!important;border-radius:4px!important;}`;
    (styleRoot === document ? document.head : styleRoot)?.append(style);
  }
  element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  element.focus?.({ preventScroll: true });
  setTimeout(() => {
    for (const target of targets) target.classList?.remove(className);
  }, 4000);
  return true;
}

function findActionElement(document, actionId) {
  const actions = [...queryAll(document, 'button, input[type="submit"], input[type="button"], a, [role="button"]')];
  let index = 0;
  for (const element of actions) {
    if (isControlDisabled(element) || !isVisible(element) || !actionLabel(element) || !inApplication(document, element)) continue;
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
    const roots = new Set();
    const changedAt = () => { changed = Date.now(); };
    const observer = document.defaultView?.MutationObserver ? new document.defaultView.MutationObserver(records => {
      if (records.some(record => !isExtensionElement(record.target))) changedAt();
    }) : null;
    const refreshRoots = () => {
      for (const root of createDomIndex(document).roots) if (!roots.has(root)) {
        roots.add(root);
        observer?.observe(root === document ? document.documentElement : root, {childList: true, subtree: true, attributes: true, characterData: true});
        root.addEventListener('slotchange', changedAt);
        changedAt();
      }
    };
    const finish = (timedOut) => {
      clearTimeout(timer); observer?.disconnect();
      for (const root of roots) root.removeEventListener('slotchange', changedAt);
      resolve({timedOut});
    };
    let lastScan = 0;
    const check = () => {
      const now = Date.now();
      if (now - started >= timeoutMs) return finish(true);
      if (now - lastScan >= 100) { refreshRoots(); lastScan = Date.now(); }
      if (now - started >= minWaitMs && now - changed >= quietMs) return finish(false);
      timer = setTimeout(check, 25);
    };
    check();
  });
}
