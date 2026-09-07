import { canonicalConcept, chooseRecord, normalizeText, recordScopeCompatible, meaningCompatible, inferSensitivity } from './core.js';

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

export function retrieveEvidence(field, records = [], { limit = 3 } = {}) {
  const query = normalizeText(field.label);
  const tags = Object.entries(EXPERIENCE_TAGS).filter(([, regex]) => regex.test(query)).map(([tag]) => tag);
  return records.flatMap(record => {
    if (!recordScopeCompatible(field, record) || !meaningCompatible(field, record, { numericReview: false }) || !String(record.answer || '').trim()) return [];
    const exact = chooseRecord(field, [record]);
    const equivalent = exact?.score === 1;
    const reviewEquivalent = !equivalent && canonicalConcept(field.label) === canonicalConcept(record.question);
    const text = normalizeText(`${record.question} ${(record.aliases || []).join(' ')} ${String(record.answer).slice(0, 4000)}`);
    const overlap = tags.length ? tags.filter(tag => EXPERIENCE_TAGS[tag].test(text)) : narrativeOverlap(field, record);
    if (!equivalent && !reviewEquivalent && ((record.confirmationState && record.confirmationState !== 'confirmed') || record.sensitivity === 'legal' || inferSensitivity(record.question) !== 'safe'
      || /\b(no|not|never|without|lack)\b/.test(normalizeText(record.answer)) || record.answer.trim().split(/\s+/).length < 5
      || /why.*(?:join|company|work)|motivat/.test(normalizeText(record.question))
      || !overlap.length || (tags.length > 0 && overlap.length !== tags.length))) return [];
    return [{ sourceKey: record.key, sourceQuestion: record.question, answer: record.answer, excerpt: record.answer.slice(0, 400), provenance: record.provenance || 'saved record', kind: equivalent ? 'equivalent' : reviewEquivalent ? 'review' : 'related', requiresApproval: true,
      reason: !record.confirmationState ? 'Unconfirmed saved evidence — explicit approval required' : equivalent ? 'Saved answer requires confirmation' : reviewEquivalent ? 'Saved answer has units/context to review; no conversion performed' : `Related saved evidence: ${overlap.join(', ')}; not an asserted qualification`, score: equivalent ? 100 : overlap.length }];
  }).sort((a,b) => b.score - a.score || a.sourceKey.localeCompare(b.sourceKey)).slice(0, limit);
}
