# Lilly Page Detection and Per-Page Saving

## Goal

Recognize the Lilly application page even when its footer contains a cookie-settings link, and let applicants save the values currently filled on any application step without submitting or navigating the site.

## Design

Frame discovery will use page and frame metadata to identify utility pages. It will not treat incidental footer-link text as a reason to reject an otherwise eligible form with application fields and one Next or Submit action.

The existing save action will accept an active waiting, review-ready, or final step. It will recapture the current visible values, update the local datasource and the run audit, and retain the step state except on the final page, where it continues to enter `answers_saved`. The panel will expose this as a secondary `Save filled values` action before the final page, so its primary Next/Check action remains unchanged.

## Safety and verification

Saving is local only: it never clicks a site control or calls a submission message. It captures only fields the existing content script exposes. Regression tests will cover the Lilly-like footer label, saving from an incomplete step, and the panel action visibility and dispatch.
