// Learning is enabled only by the worker for the selected application frame.
export function createLearningSession(document, { capture, send, delayMs = 350 }) {
  let applicationId = null;
  let timer;
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
    clearTimeout(timer);
    timer = setTimeout(() => { flush().catch(() => {}); }, delayMs);
  }
  const checkpoint = () => { flush().catch(() => {}); };
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
      for (const name of ['input', 'change', 'blur', 'click']) document.removeEventListener(name, schedule, true);
      document.removeEventListener('submit', checkpoint, true);
      document.removeEventListener('visibilitychange', checkpoint, true);
      document.defaultView?.removeEventListener('pagehide', checkpoint);
    },
  };
}
