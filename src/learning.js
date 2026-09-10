// Learning is enabled only by the worker for the selected application frame.
export function createLearningSession(document, { capture, send, onFinalSubmit, onRevalidate, validationDelayMs = 500, delayMs = 350 }) {
  let applicationId = null;
  let timer;
  let validationTimer;
  let lastSaved = '';
  let queue = Promise.resolve();
  function flush() {
    clearTimeout(timer);
    if (!applicationId || document.__jobApplicationFilling) return queue;
    const records = capture().filter((record) => record.provenance === 'user');
    if (!records.length) return queue;
    const signature = JSON.stringify(records);
    const id = applicationId;
    queue = queue.catch(() => {}).then(async () => {
      if (signature === lastSaved || applicationId !== id) return;
      const response = await send({ type: 'JOB_APP_LEARN', applicationId: id, records });
      if (!response?.ok) throw new Error(response?.error || 'Learning checkpoint was not saved');
      lastSaved = signature;
    });
    return queue;
  }
  function schedule(event) {
    if (!applicationId || document.__jobApplicationFilling || event.target?.__jobApplicationAutofillDispatch) return;
    if (typeof onRevalidate === 'function' && event.target?.closest?.('input,textarea,select,[role="combobox"],[role="option"],button[aria-haspopup="listbox"]')) {
      clearTimeout(validationTimer);
      const id=applicationId;
      validationTimer=setTimeout(()=>{if(applicationId===id && !document.__jobApplicationFilling) Promise.resolve(onRevalidate({applicationId:id})).catch(()=>{});},validationDelayMs);
    }
    clearTimeout(timer);
    timer = setTimeout(() => { flush().catch(() => {}); }, delayMs);
  }
  const checkpoint = (event) => {
    flush().catch(() => {});
    if (event?.type !== 'submit' || !applicationId || document.__jobApplicationFilling || typeof onFinalSubmit !== 'function') return;
    try {
      Promise.resolve(onFinalSubmit({ applicationId, records: capture(), event })).catch(() => {});
    } catch (_) {}
  };
  for (const name of ['input', 'change', 'blur', 'click']) document.addEventListener(name, schedule, true);
  document.addEventListener('submit', checkpoint, true);
  document.addEventListener('visibilitychange', checkpoint, true);
  document.defaultView?.addEventListener('pagehide', checkpoint);
  return {
    activate(id) {
      if (applicationId !== id) lastSaved = '';
      applicationId = id || null;
    },
    flush,
    dispose() {
      applicationId = null;
      clearTimeout(timer);
      clearTimeout(validationTimer);
      for (const name of ['input', 'change', 'blur', 'click']) document.removeEventListener(name, schedule, true);
      document.removeEventListener('submit', checkpoint, true);
      document.removeEventListener('visibilitychange', checkpoint, true);
      document.defaultView?.removeEventListener('pagehide', checkpoint);
    },
  };
}
