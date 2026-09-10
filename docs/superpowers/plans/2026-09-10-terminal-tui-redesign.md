# Terminal TUI Side Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recast the extension side panel as a compact guided-terminal workflow with a centralized, easy-to-theme design-token layer.

**Architecture:** Preserve the existing DOM IDs, event wiring, rendering logic, and accessibility semantics. Add a small amount of presentational markup for brand/context framing, then express all visual decisions through CSS custom properties with dark amber and light variants; component selectors consume tokens rather than owning literal colors.

**Tech Stack:** Manifest V3 extension HTML/CSS, vanilla JavaScript, Node test runner, JSDOM static markup tests.

## Global Constraints

- Do not change autofill behavior, worker messages, storage formats, or run-state transitions.
- Keep every existing side-panel ID and control available to `src/sidepanel.js`.
- Centralize theme colors, typography, spacing, radii, borders, and shadows in `:root` and the light-mode override.
- Keep the narrow extension panel readable at the existing minimum width and retain keyboard focus visibility.
- Use amber only for active commands, attention states, and selected controls; keep surfaces graphite and information dense.

---

### Task 1: Lock the themeable TUI contract with a failing structure test

**Files:**

- Modify: `C:\Users\nithi\job-application-autofill-extension\.worktrees\terminal-tui-redesign\tests\extension-structure.test.js`

**Interfaces:**

- Consumes: `sidepanel.html` and `src/sidepanel.css` as text fixtures.
- Produces: assertions for the stable brand framing and semantic theme-token names used by the stylesheet.

- [x] **Step 1: Write the failing test**

```js
test('side panel exposes a themeable terminal UI token layer', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('sidepanel.html', root), 'utf8'),
    readFile(new URL('src/sidepanel.css', root), 'utf8'),
  ]);
  assert.match(html, /class="app-shell"/);
  assert.match(html, /class="brand-row"/);
  assert.match(html, /GUIDED COPILOT/);
  for (const token of ['--color-bg', '--color-surface', '--color-surface-raised', '--color-text', '--color-text-muted', '--color-border', '--color-accent', '--color-accent-soft', '--color-ok', '--color-warning', '--color-danger', '--font-mono', '--radius-control']) {
    assert.match(css, new RegExp(`${token}:`));
  }
  assert.match(css, /\.app-shell/);
  assert.match(css, /\.brand-row/);
  assert.match(css, /\.pill\s*\{/);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tests/extension-structure.test.js`

Expected: FAIL because the current panel has no `app-shell`/`brand-row` framing and does not expose the new semantic token names.

### Task 2: Add terminal framing without changing behavior

**Files:**

- Modify: `C:\Users\nithi\job-application-autofill-extension\.worktrees\terminal-tui-redesign\sidepanel.html`

**Interfaces:**

- Consumes: all existing IDs and controls required by `src/sidepanel.js`.
- Produces: `.app-shell`, `.app-header`, `.brand-row`, `.brand-mark`, `.brand-name`, `.brand-dot`, `.header-context`, and `.app-main` presentational hooks.

- [x] **Step 1: Add stable presentational hooks**

```html
<body class="app-shell">
  <header class="app-header">
    <div class="brand-row" aria-label="Job Application Autofill">
      <span class="brand-mark" aria-hidden="true">▣</span>
      <span class="brand-name">Job Application Autofill</span>
      <span class="brand-dot" aria-hidden="true"></span>
    </div>
    <div class="header-context">
      <span class="eyebrow">GUIDED COPILOT</span>
      <span class="header-prompt" aria-hidden="true">›_</span>
    </div>
    <h1>Job Application Autofill</h1>
    <p>Fill one page at a time, review what needs attention, then submit on the application site yourself.</p>
  </header>
  <main class="app-main">
```

- [x] **Step 2: Preserve all existing closing tags and IDs**

The only structural edits are the body/header/main classes and the new decorative brand/context rows; no button, input, section, details, or footer ID is removed or renamed.

### Task 3: Implement the tokenized TUI visual system

**Files:**

- Modify: `C:\Users\nithi\job-application-autofill-extension\.worktrees\terminal-tui-redesign\src\sidepanel.css`
- Modify: `C:\Users\nithi\job-application-autofill-extension\.worktrees\terminal-tui-redesign\src\sidepanel.js`

**Interfaces:**

- Consumes: the hooks from Task 2 and existing state classes/IDs from the current stylesheet and renderer.
- Produces: dark graphite/amber default styling, light-mode token overrides, compact command-like controls, visible focus states, and an amber action-required status.

- [x] **Step 1: Replace literal visual primitives with semantic tokens**

Define `--color-*`, `--font-*`, `--space-*`, and `--radius-*` values once in `:root`. Include `--color-accent-soft` for focus rings and hover fills so changing the accent does not require hunting through selectors.

- [x] **Step 2: Restyle the shell and hierarchy**

Use a compact header, thin dividers, 8px card radii, flat surfaces, boxed step markers, rectangular status pills, and a single high-salience primary command. Replace hardcoded input/background/border/shadow colors with tokens.

- [x] **Step 3: Restyle interaction states**

Use `:focus-visible` with the tokenized accent ring, `data-state` colors for save feedback, muted secondary buttons, amber primary buttons and action-required status, and reduced-motion support for the status pulse. Keep the state change presentation-only by retaining the existing status value and action dispatches.

- [x] **Step 4: Provide a complete light-mode token override**

Override semantic tokens—not individual component selectors—inside `@media (prefers-color-scheme: light)` so the same layout can switch palettes without markup or JavaScript changes.

### Task 4: Verify presentation changes and preserve behavior

**Files:**

- Test: `C:\Users\nithi\job-application-autofill-extension\.worktrees\terminal-tui-redesign\tests\extension-structure.test.js`
- Test: `C:\Users\nithi\job-application-autofill-extension\.worktrees\terminal-tui-redesign\tests\sidepanel.test.js`
- Verify: `C:\Users\nithi\job-application-autofill-extension\.worktrees\terminal-tui-redesign\src\sidepanel.js`
- Verify: `C:\Users\nithi\job-application-autofill-extension\.worktrees\terminal-tui-redesign\package.json`

**Interfaces:**

- Consumes: the final tokenized stylesheet and unchanged side-panel behavior.
- Produces: passing static structure, interaction, syntax, and full regression checks.

- [x] **Step 1: Run focused structure and side-panel tests**

Run: `node --test tests/extension-structure.test.js tests/sidepanel.test.js`

Expected: PASS with all structure and interaction assertions green.

- [x] **Step 2: Run syntax and full regression checks**

Run: `npm run check` and `npm test`

Expected: both commands exit 0 with no failures.

- [x] **Step 3: Review the diff for scope**

Run: `git diff --check` and `git diff --stat`

Expected: only the plan, side-panel markup, stylesheet, side-panel presentation state, and tests are changed; no worker, storage, or autofill logic is modified.

- [ ] **Step 4: Commit the isolated redesign**

```bash
git add sidepanel.html src/sidepanel.css tests/extension-structure.test.js docs/superpowers/plans/2026-09-10-terminal-tui-redesign.md
git commit -m "feat: add themeable terminal side panel"
```
