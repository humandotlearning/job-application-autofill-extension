// A lookup registry, not a persisted-key migration.
export const CONCEPT_REGISTRY = {
  generic_name: /^(?:name|your name|applicant name|candidate name)$/,
  first_name: /^(?:first|given|forename) name$/,
  last_name: /^(?:last|family) name$|^surname$/,
  full_name: /^(?:full|complete|legal) name$/,
  preferred_name: /^(?:preferred name|nickname|preferred first name)$/,
  date_of_birth: /^(?:dob|date of birth|birth date|birthday)$/,
  email: /^(?:email|email address|e mail)$/,
  phone: /^(?:phone|phone number|mobile|mobile number|telephone)$/,
  github_url: /^(?:github|github profile|github url)$/,
  linkedin_url: /^(?:linkedin|linkedin profile|linkedin url)$/,
  portfolio_url: /^(?:portfolio|portfolio url|personal website|website)$/,
  current_employer: /^(?:current|present) (?:employer|company|organization)$/,
  current_location: /^(?:current|present) location$/,
  current_city: /^(?:current|present) city$/,
  notice_period: /^(?:notice period|notice duration)$/,
  start_date: /^(?:available start date|earliest start date|start date|date available)$/,
  availability: /^(?:availability|when can you start)$/,
  current_compensation: /^current (?:salary|ctc|compensation)$/,
  expected_compensation: /^(?:expected|desired) (?:salary|ctc|compensation)$/,
};

export function conceptForNormalized(text) {
  const cleaned = text.replace(/^(?:(?:what is|please enter|enter) )?(?:your )?/, '').replace(/\blinked in\b/g, 'linkedin').replace(/\bgit hub\b/g, 'github');
  return Object.entries(CONCEPT_REGISTRY).find(([, pattern]) => pattern.test(cleaned))?.[0] || cleaned.replace(/\s+/g, '_');
}
