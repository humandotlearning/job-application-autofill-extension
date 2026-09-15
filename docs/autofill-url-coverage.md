# Application URL coverage

Read-only audit on 2026-09-15. No fields were edited, no personal data was entered, no files were uploaded, and no application was submitted.

| URL / ATS | Status | Verified evidence |
|---|---|---|
| 100ms / Lever | Usable | Rendered Chrome form: resume, full name, email, phone, location autocomplete, company, links, college question, submit. |
| Neuron7 / Lever | Usable | Fetched rendered form text: same Lever core plus pronoun choices/custom text; location autocomplete reported no location found. |
| Point72 / Greenhouse | Usable | Rendered Chrome embedded form: split names, email/phone/country, resume/cover letter, education comboboxes, many required custom questions, checkboxes, reCAPTCHA, submit. |
| Twilio / Greenhouse | Usable | Fetched rendered form text: preferred first name, city/location, resume/cover letter, LinkedIn, multi-choice referral, authorization, two required acknowledgement checkboxes, submit. |
| Optum / Taleo | Usable job page | Rendered Chrome job detail with Apply buttons and signed-out state; application form not opened. |
| Nagarro GenAI+NLP / SmartRecruiters | Usable job page; application session expired in prior browser state | Rendered Chrome job page with “I'm interested”; prior session visibly reported inactivity expiry. |
| Nagarro GenAI / SmartRecruiters | Usable job page; application session expired in prior browser state | Rendered Chrome job page with “I'm interested”; same expiry behavior. |
| Treasure AI / Teamtailor | Usable job page; form unverified | Fetched page exposed “Apply for this job” and “Loading application form”; controls were not available in captured state. |
| Linde / CSOD | Already completed | Rendered Chrome page visibly said the application was successfully submitted; not a fresh-form fixture. |
| EY / SuccessFactors | Usable job page; form unverified | Rendered Chrome job detail with live Apply now action and cookie banner; application endpoint was not fetchable by web cache. |

## Fixture priorities

- Async custom combobox/listbox controls: Greenhouse country, education, location, authorization, sponsorship, referral, privacy, and demographic fields; Lever location autocomplete.
- Radio/checkbox groups and legal acknowledgements: Neuron7 pronouns, Point72 certifications/privacy, Twilio acknowledgements.
- Split names and preferred first name.
- Resume/CV and optional cover-letter file controls with an explicit upload pause.
- Weak or unlabeled Lever fields such as employer-specific fields, college, and free-form questions.
- Modal loading, one-click session expiry/restart, and contenteditable/manual-entry controls.

## Verification limits

Web fetches established page content. CUA accessibility-tree inspection established rendered Chrome content for SmartRecruiters, Taleo, Linde, EY, Lever 100ms, and Greenhouse Point72. No extension fill success was observed. Chrome `chrome://extensions/` was blocked by browser URL policy, so installed-extension UI could not be inspected.

## Subsequent live inline verification

On 2026-09-15 the Chrome connection recovered. A fresh Lever 100ms application was opened. GitHub and LinkedIn each filled through the installed extension's inline UI: focus field, select the correct saved candidate, click **Use and save reviewed answer** (three clicks per field). Both public profile URLs remained visible after focus moved away. These actions also saved reviewed aliases, as stated by the UI. No application was submitted or file uploaded.

The installed candidate list exposed a LinkedIn username as a URL answer and a GitHub Pages portfolio among GitHub candidates. These observations motivated the profile-value compatibility checks. They do not establish which source version is installed.

On Greenhouse Point72, the form rerendered and restored personal fields and an attached resume without agent entry. The LinkedIn field already contained the correct URL when focused; inline UI reported **Your answer is kept**. Preserve these values. This is evidence of non-overwrite behavior, not evidence that the extension filled the application.

Lever's **Edit in panel** action returned **Open the extension toolbar button to continue editing**. Whole-page Fill, installed bundle version, dynamic-option autofill, and before/after click reduction remain unverified. The source build identifies itself as `autofill-ux-3` so later live checks can distinguish it from previous scripts.
