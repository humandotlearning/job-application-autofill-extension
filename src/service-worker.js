chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'JOB_AUTOFILL_LEARNED' || !Array.isArray(message.records)) return false;
  chrome.storage.local.get({ pendingLearnedAnswers: [] }).then(({ pendingLearnedAnswers }) => {
    const merged = [...pendingLearnedAnswers];
    let added = 0;
    for (const record of message.records) {
      const duplicate = merged.find((item) => item.key === record.key && item.answer === record.answer);
      if (!duplicate) {
        merged.push({ ...record, learnedAt: new Date().toISOString() });
        added += 1;
      }
    }
    return chrome.storage.local.set({ pendingLearnedAnswers: merged }).then(() => added);
  }).then((added) => {
    chrome.runtime.sendMessage({ type: 'JOB_AUTOFILL_LEARNED_SAVED', added }).catch(() => {});
    sendResponse({ ok: true, added });
  }).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'JOB_AUTOFILL_APPROVE_SAFE_LEARNED') return false;
  chrome.storage.local.get({ pendingLearnedAnswers: [], answerRecords: [] }).then((stored) => {
    const approved = stored.pendingLearnedAnswers.filter((record) => record.sensitivity === 'safe')
      .map((record) => ({ ...record, status: 'verified', sensitivity: 'safe' }));
    const existing = new Map(stored.answerRecords.map((record) => [record.key, record]));
    for (const record of approved) existing.set(record.key, record);
    const remaining = stored.pendingLearnedAnswers.filter((record) => record.sensitivity !== 'safe');
    return chrome.storage.local.set({ answerRecords: [...existing.values()], pendingLearnedAnswers: remaining });
  }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  if (chrome.storage.local.setAccessLevel) {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
});
