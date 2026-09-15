// A lookup registry, not a persisted-key migration.
export const CONCEPT_REGISTRY = {
  generic_name: /^(?:name|your name|applicant name|candidate name)$/,
  first_name: /^(?:first|given|forename) name$/,
  last_name: /^(?:last|family) name$|^surname$/,
  full_name: /^(?:full|complete|legal) name$/,
  preferred_name: /^(?:preferred name|nickname|preferred first name)$/,
  date_of_birth: /^(?:dob|date of birth|birth date|birthday)$/,
  email: /^(?:email|email address|e mail)$/,
  phone_number: /^(?:phone|phone number|mobile|mobile number|telephone)$/,
  phone_extension: /^(?:(?:phone|telephone|mobile) )?extension$/,
  phone_country_code: /^(?:country code|country phone code|phone country code|country calling code|calling code)$/,
  phone_device_type: /^(?:phone|telephone|mobile) (?:device )?type$/,
  address_line_1_local: /^(?:address )?line 1 local$|^street local$/,
  address_line_2_local: /^(?:address )?line 2 local$/,
  address_line_3_local: /^(?:address )?line 3 local$/,
  address_line_1: /^(?:address )?line 1$|^street(?: address)?$/,
  address_line_2: /^(?:address )?line 2$/,
  address_line_3: /^(?:address )?line 3$/,
  city_local: /^city local$|^locality local$/,
  city: /^city$|^locality$/,
  postal_code: /^(?:postal|post|zip|pin) code$|^postcode$|^pincode$/,
  state: /^(?:state|state or territory|territory|region)$/,
  github_url: /^(?:(?:link|url) (?:to|for) (?:your |my )?)?github(?: profile)?(?: link| url)?$/,
  linkedin_url: /^(?:(?:link|url) (?:to|for) (?:your |my )?)?linkedin(?: profile)?(?: link| url)?$/,
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
  const cleaned = text.replace(/^(?:(?:what is|please enter|please provide|provide|enter) )?(?:your )?/, '')
    .replace(/\blinked in\b/g, 'linkedin').replace(/\bgit hub\b/g, 'github');
  return Object.entries(CONCEPT_REGISTRY).find(([, pattern]) => pattern.test(cleaned))?.[0] || cleaned.replace(/\s+/g, '_');
}
