import { canonicalConcept, chooseRecord, inferSensitivity, isOpaqueIdentifier, meaningCompatible, normalizeText, recordScopeCompatible, suggestionTargetKey } from './core.js';

const EXPERIENCE_TAGS = {
  ml: /\b(ml|machine learning|models?|computer vision)\b/,
  ai: /\b(ai|artificial intelligence)\b/,
  agents: /\b(llm|agents?|large language)\b/,
  pharma: /\b(pharma|pharmaceutical|clinical)\b/,
};

// Untagged discovery requires both shared subject matter and an action
// actually present in the answer; question wording alone is not evidence.
function narrativeOverlap(field, record) {
  const query = normalizeText(field.label);
  if (['radio', 'checkbox', 'select', 'select-one'].includes(field.type)
    || !/\b(describe|experience|tell|example|project)\b/.test(query)
    || inferSensitivity(query) !== 'safe') return [];
  const actions = text => new Set(normalizeText(text).split(' ').map(word => ({ built: 'build', building: 'build', developing: 'develop', developed: 'develop', designing: 'design', designed: 'design', deploying: 'deploy', deployed: 'deploy', leading: 'lead', led: 'lead', managing: 'manage', managed: 'manage', implementing: 'implement', implemented: 'implement' }[word] || word)).filter(word => /^(build|develop|design|deploy|lead|manage|implement)$/.test(word)));
  const queryActions = actions(query);
  const answerActions = actions(record.answer);
  if (![...queryActions].some(action => answerActions.has(action))) return [];
  const stop = new Set('describe experience tell us about your you a an the in of with and to for project projects example examples how have has did do work working build building built develop developing developed design designing designed deploy deploying deployed lead leading led manage managing managed implement implementing implemented'.split(' '));
  const topics = text => new Set(normalizeText(text).split(' ').filter(word => word.length > 2 && !stop.has(word)).map(word => word.replace(/s$/, '')));
  const requested = topics(query);
  const source = topics(`${record.question} ${record.answer}`);
  const overlap = [...requested].filter(topic => source.has(topic));
  return overlap.length >= 2 && overlap.length / requested.size >= 0.6 ? overlap : [];
}

function rankEvidence(field, records = [], { limit = 40 } = {}) {
  const query = normalizeText(field.label);
  const targetKey = suggestionTargetKey(field);
  const tags = Object.entries(EXPERIENCE_TAGS).filter(([, regex]) => regex.test(query)).map(([tag]) => tag);
  return records.flatMap(record => {
    if (record.semantic?.reusePolicy === 'never' || record.reusePolicy === 'never') return [];
    if (isOpaqueIdentifier(record.answer) || isOpaqueIdentifier(record.question) || isOpaqueIdentifier(record.key)
      || !recordScopeCompatible(field, record) || !meaningCompatible(field, record, { numericReview: false }) || !String(record.answer || '').trim()) return [];
    if (targetKey && record.suppressedFor?.includes(targetKey)) return [];
    const exact = chooseRecord(field, [record]);
    const equivalent = exact?.score === 1;
    const reviewEquivalent = !equivalent && canonicalConcept(field.label) === canonicalConcept(record.question);
    const fuzzyEquivalent = !equivalent && !reviewEquivalent && Number(exact?.score || 0) >= 0.5 && record.confirmationState === 'confirmed';
    const choiceField = ['select', 'select-one', 'radio', 'checkbox'].includes(normalizeText(field.type));
    const visibleOptions = Array.isArray(field.options)
      && field.options.some((option) => typeof option === 'string' && option.trim() && !isOpaqueIdentifier(option));
    const choiceMapping = choiceField && visibleOptions && !equivalent && !reviewEquivalent && Number(exact?.score || 0) >= 0.6;
    const text = normalizeText(`${record.question} ${(record.aliases || []).join(' ')} ${String(record.answer).slice(0, 4000)}`);
    const overlap = tags.length ? tags.filter(tag => EXPERIENCE_TAGS[tag].test(text)) : narrativeOverlap(field, record);
    if (!equivalent && !reviewEquivalent && !fuzzyEquivalent && !choiceMapping && ((record.confirmationState && record.confirmationState !== 'confirmed') || record.sensitivity === 'legal' || inferSensitivity(record.question) !== 'safe'
      || /\b(no|not|never|without|lack)\b/.test(normalizeText(record.answer)) || record.answer.trim().split(/\s+/).length < 5
      || /why.*(?:join|company|work)|motivat/.test(normalizeText(record.question))
      || !overlap.length || (tags.length > 0 && overlap.length !== tags.length))) return [];
    return [{ sourceKey: record.key, sourceId: record.id || record.key, sourceQuestion: record.question, answer: record.answer, excerpt: record.answer.slice(0, 400), provenance: record.provenance || 'saved record', kind: equivalent ? 'equivalent' : reviewEquivalent ? 'review' : choiceMapping ? 'choice_mapping' : fuzzyEquivalent ? 'review' : 'related', requiresApproval: true,
      reason: !record.confirmationState ? 'Unconfirmed saved evidence — explicit approval required' : equivalent ? 'Saved answer requires confirmation' : reviewEquivalent ? 'Saved answer has units/context to review; no conversion performed' : choiceMapping ? 'Saved answer may support a visible option mapping; explicit approval required' : `Related saved evidence: ${overlap.join(', ')}; not an asserted qualification`, score: equivalent ? 100 : fuzzyEquivalent ? Math.round(exact.score * 100) : choiceMapping ? Math.round((exact?.score || 0) * 100) : overlap.length }];
  }).sort((a,b) => b.score - a.score || String(a.sourceId).localeCompare(String(b.sourceId))).slice(0, limit);
}

// Keep the full ranked pool for model grounding; UI candidates remain distinct.
export function rankSuggestionEvidence(field, records = [], { limit = 40 } = {}) {
  const evidence = rankEvidence(field, records, { limit });
  const matched = evidence.map(item => records.find(record => (record.id || record.key) === item.sourceId && record.key === item.sourceKey)).filter(Boolean);
  if (matched.length || !isNarrativeDraftField(field)) return matched;

  const targetKey = suggestionTargetKey(field);
  const queryTokens = new Set(normalizeText([field.label, field.helpText, field.id].filter(Boolean).join(' ')).split(' ').filter(token => token.length > 2));
  return records
    .filter(record => isSafeNarrativeEvidence(field, record, targetKey))
    .map((record, index) => {
      const text = normalizeText([record.question, record.answer, ...(record.aliases || [])].filter(Boolean).join(' '));
      const overlap = text.split(' ').reduce((score, token) => score + Number(queryTokens.has(token)), 0);
      return { record, index, score: overlap };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(item => item.record);
}

function isNarrativeDraftField(field = {}) {
  return normalizeText(field.type) === 'textarea'
    || /\b(why|describe|explain|motivation|cover letter|additional information)\b/i.test(String(field.label || ''));
}

function isSafeNarrativeEvidence(field, record, targetKey) {
  const answer = String(record?.answer || '').trim();
  if (!answer || record?.semantic?.reusePolicy === 'never' || record?.reusePolicy === 'never'
    || isOpaqueIdentifier(record?.answer) || isOpaqueIdentifier(record?.question) || isOpaqueIdentifier(record?.key)
    || !recordScopeCompatible(field, record) || record?.confirmationState !== 'confirmed'
    || record?.sensitivity === 'legal' || inferSensitivity(record?.question) !== 'safe'
    || targetKey && record?.suppressedFor?.includes(targetKey)
    || /\b(no|not|never|without|lack)\b/.test(normalizeText(answer))
    || answer.split(/\s+/).length < 5 || /why.*(?:join|company|work)|motivat/.test(normalizeText(record?.question))) return false;
  return /\b(build|built|develop|developed|design|designed|deploy|deployed|lead|led|manage|managed|implement|implemented)\b/i.test(answer);
}

export function selectPlannerEvidence(fields = [], records = [], { limit = 20 } = {}) {
  const queues = fields.map(field => rankSuggestionEvidence(field, records, { limit }));
  const selected = [], seen = new Set();
  for (let depth = 0; selected.length < limit && queues.some(queue => depth < queue.length); depth++) {
    for (const queue of queues) {
      const record = queue[depth];
      if (!record) continue;
      const identity = record.id || record.key;
      if (seen.has(identity)) continue;
      seen.add(identity); selected.push(record);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

export function retrieveEvidence(field, records = [], { limit = 3 } = {}) {
  return searchEvidence(field, records, { limit: Math.min(3, limit) });
}

export function savedFieldCandidates(field, records, draftRecords = []) {
  const candidates = retrieveEvidence(field, records);
  for (const candidate of retrieveEvidence(field, draftRecords)) {
    if (!candidates.some(saved => saved.answer === candidate.answer)) {
      candidates.push({...candidate, kind: 'draft',
        reason: 'Previously entered, not yet saved for reuse — explicit approval required'});
    }
  }
  return candidates.slice(0, 3);
}

export function searchEvidence(field, records = [], { limit = 20 } = {}) {
  const seen = new Set();
  return rankEvidence(field, records, { limit: records.length }).filter(item => {
    const answer = String(item.answer).trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(answer)) return false;
    seen.add(answer); return true;
  }).slice(0, limit);
}
