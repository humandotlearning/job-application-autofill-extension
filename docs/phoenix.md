# Local AI traces with Arize Phoenix

## Start and inspect

1. From the project folder run `powershell -ExecutionPolicy Bypass -File scripts/start-phoenix.ps1`.
2. Reload this unpacked extension at `chrome://extensions` to load the tracing code.
3. In Settings, leave **Save AI traces to local Phoenix** enabled (the default).
4. Use an AI action such as Generate answer, Rewrite, or Fill this page when AI assistance is needed.
5. Open http://127.0.0.1:6006 and select **job-autofill**. Select a trace to inspect Input, Output and attributes.

Local matching and cached answers make no AI request and create no trace. Historical calls cannot be recovered; collection starts after reloading the extension. The synthetic setup check is named `phoenix_setup_check`.

## What is captured

- Exact JSON request body, including system/user prompts, selected candidate evidence, model parameters, schemas, and screenshot data when sent to the provider.
- Raw response body, including provider errors and malformed JSON.
- Model, provider, HTTP status, start/end time, and usage tokens when returned by the provider.
- The operation name: form_interpretation, answer_planner, answer_suggestions, answer_rewriter, or learning_review.
- Background planner and suggestion calls from the same application are grouped in Phoenix Sessions by tab ID and application start time. Each HTTP call is a separate trace, including screenshot fallback attempts.

This records the provider HTTP boundary. Subsequent local validation/rejection and form interactions are not captured as spans. A successful HTTP response may still be rejected by the extension's validation.

## Storage and stopping

Phoenix listens at 127.0.0.1:6006 and persists data in this project's `.phoenix/` directory. Full prompts and responses may contain personal application data. API authorization headers are never included. This directory and the Python environment are ignored by Git. Removing the extension does not remove Phoenix data.

Turn off **Save AI traces to local Phoenix** to stop capture. Stop a foreground server with Ctrl+C. Use Phoenix's UI to delete traces you no longer need.

Delivery is best-effort: Phoenix must be running when a request finishes; missed traces are not queued for later. Exports time out after 750 ms and cannot replace the AI result with a tracing error. Missing exports generate a warning in the extension service worker console.

## Reinstall

Requires Python 3.10+ and uv (verified with Python 3.13.3):

```powershell
$env:UV_CACHE_DIR = Join-Path (Get-Location) '.phoenix-uv-cache'
uv venv .venv-phoenix
uv pip install --python .venv-phoenix\Scripts\python.exe -r requirements-phoenix.txt
powershell -ExecutionPolicy Bypass -File scripts/start-phoenix.ps1
```

Phoenix is pinned in `requirements-phoenix.txt`. No Python relay, cloud account, or JavaScript tracing package is required: the extension sends JSON spans to Phoenix's native create-spans REST API.

To verify without calling an AI provider, run `node scripts/check-phoenix.mjs` while Phoenix is running. It saves a synthetic trace and asserts that the exact input/output can be read back.

The setup also leaves Phoenix's standard gRPC ingestion listener on port 4317; the extension uses only the HTTP API on 127.0.0.1:6006.
