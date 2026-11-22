import { FlightSession } from './types.js';

/**
 * Generates a self-contained, interactive HTML replay player for an Orbis Flight Session.
 * Zero external dependencies — runs 100% offline from local file:/// URLs.
 */
export function generateReplayHtml(session: FlightSession): string {
  const jsonPayload = JSON.stringify(session).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Orbis Flight Replay — ${session.id}</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f2937;
      --accent: #00e5ff;
      --accent-dim: rgba(0, 229, 255, 0.15);
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      background: #030712;
      border-bottom: 1px solid var(--card-border);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .brand-pill {
      background: var(--accent);
      color: #000;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 900;
    }
    .meta-badges {
      display: flex;
      gap: 12px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .meta-badge {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      padding: 4px 10px;
      border-radius: 6px;
    }
    .meta-badge strong { color: var(--text-main); }

    /* Control Bar */
    .controls {
      background: #0b1120;
      border-bottom: 1px solid var(--card-border);
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    button {
      background: var(--card-bg);
      color: var(--text-main);
      border: 1px solid var(--card-border);
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      transition: all 0.15s ease;
    }
    button:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .scrubber-container {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    input[type="range"] {
      flex: 1;
      height: 6px;
      border-radius: 3px;
      background: #1f2937;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .step-counter {
      font-family: monospace;
      font-size: 13px;
      color: var(--accent);
      min-width: 90px;
      font-weight: bold;
    }

    /* Main Split View */
    .workspace {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 420px;
      gap: 16px;
      padding: 16px 24px;
      overflow: hidden;
    }
    .panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .panel-header {
      padding: 10px 16px;
      border-bottom: 1px solid var(--card-border);
      background: rgba(0,0,0,0.2);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .panel-header .url-bar {
      font-family: monospace;
      font-size: 12px;
      color: var(--accent);
      text-transform: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 480px;
    }
    .panel-body {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      font-family: monospace;
      font-size: 13px;
      line-height: 1.5;
    }
    .action-map-line {
      padding: 3px 6px;
      border-radius: 4px;
      margin-bottom: 2px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .action-map-line.highlighted {
      background: var(--accent-dim);
      border: 1px solid var(--accent);
      color: #fff;
      font-weight: bold;
    }
    .card {
      background: #0d1526;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .card-title {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 6px;
      font-weight: bold;
    }
    .badge-ok { color: var(--success); font-weight: bold; }
    .badge-err { color: var(--danger); font-weight: bold; }
    .kbd-tip {
      font-size: 11px;
      color: #6b7280;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>⬡ ORBIS</span>
      <span class="brand-pill">FLIGHT RECORDER</span>
      <span style="font-size: 13px; color: var(--text-muted); font-weight: normal; margin-left: 8px;">
        ID: <strong>${session.id}</strong>
      </span>
    </div>
    <div class="meta-badges">
      <div class="meta-badge">Started: <strong>${session.startedAt}</strong></div>
      <div class="meta-badge">Total Steps: <strong id="meta-steps">${session.steps.length}</strong></div>
      <div class="meta-badge">Duration: <strong>${session.totalDurationMs || 0}ms</strong></div>
    </div>
  </header>

  <div class="controls">
    <button id="btn-prev">◀ Prev</button>
    <button id="btn-play">▶ Play</button>
    <button id="btn-next">Next ▶</button>

    <div class="scrubber-container">
      <input type="range" id="step-scrubber" min="0" max="${Math.max(0, session.steps.length - 1)}" value="0">
      <div class="step-counter" id="step-label">Step 1 / ${session.steps.length}</div>
    </div>

    <div class="kbd-tip">Tips: Use <strong>← / →</strong> keys to scrub, <strong>Space</strong> to play/pause</div>
  </div>

  <div class="workspace">
    <!-- Left Panel: Action Map & Visual Content -->
    <div class="panel">
      <div class="panel-header">
        <span>Distilled Action Map</span>
        <span class="url-bar" id="view-url">-</span>
      </div>
      <div class="panel-body" id="view-action-map"></div>
    </div>

    <!-- Right Panel: Step Telemetry & Diffs -->
    <div class="panel">
      <div class="panel-header">Step Telemetry & Diffs</div>
      <div class="panel-body" style="font-family: inherit;">
        <div class="card">
          <div class="card-title">Action Executed</div>
          <div id="telemetry-action" style="font-size: 14px; font-family: monospace;">-</div>
        </div>

        <div class="card">
          <div class="card-title">DOM Mutation Diff</div>
          <div id="telemetry-diff" style="font-size: 13px;">-</div>
        </div>

        <div class="card">
          <div class="card-title">Page Title & Timing</div>
          <div id="telemetry-timing" style="font-size: 13px; color: var(--text-muted);">-</div>
        </div>

        <div class="card">
          <div class="card-title">Console Logs & Warnings</div>
          <div id="telemetry-console" style="font-family: monospace; font-size: 12px; max-height: 200px; overflow-y: auto;">
            (No console errors)
          </div>
        </div>
      </div>
    </div>
  </div>

  <script id="session-data" type="application/json">${jsonPayload}</script>

  <script>
    const session = JSON.parse(document.getElementById('session-data').textContent);
    const steps = session.steps || [];
    let currentIndex = 0;
    let isPlaying = false;
    let playInterval = null;

    const scrubber = document.getElementById('step-scrubber');
    const stepLabel = document.getElementById('step-label');
    const viewUrl = document.getElementById('view-url');
    const viewActionMap = document.getElementById('view-action-map');
    const telAction = document.getElementById('telemetry-action');
    const telDiff = document.getElementById('telemetry-diff');
    const telTiming = document.getElementById('telemetry-timing');
    const telConsole = document.getElementById('telemetry-console');
    const btnPlay = document.getElementById('btn-play');

    function renderStep(index) {
      if (!steps.length) return;
      currentIndex = Math.max(0, Math.min(index, steps.length - 1));
      scrubber.value = currentIndex;
      stepLabel.textContent = 'Step ' + (currentIndex + 1) + ' / ' + steps.length;

      const step = steps[currentIndex];
      viewUrl.textContent = step.url || 'about:blank';
      viewUrl.title = step.url || '';

      // 1. Render Action Map with highlight
      viewActionMap.innerHTML = '';
      const actionText = step.actionMapText || '(Empty action map)';
      const lines = actionText.split('\\n');
      const targetId = step.action ? step.action.target : null;

      lines.forEach(line => {
        const div = document.createElement('div');
        div.className = 'action-map-line';
        if (targetId && (line.includes('[' + targetId + ']') || line.startsWith(targetId + ' ') || line.includes(targetId))) {
          div.classList.add('highlighted');
        }
        div.textContent = line;
        viewActionMap.appendChild(div);
      });

      // 2. Render Action details
      if (step.action) {
        const okBadge = step.action.success ? '<span class="badge-ok">✓ SUCCESS</span>' : '<span class="badge-err">✗ FAILED</span>';
        const valText = step.action.value ? ' value: "' + step.action.value + '"' : '';
        telAction.innerHTML = '<strong>' + step.action.type.toUpperCase() + '</strong> ' + (step.action.target || '') + valText + ' ' + okBadge;
      } else {
        telAction.textContent = 'Initial Navigation';
      }

      // 3. Render Diff
      if (step.diffSummary) {
        telDiff.innerHTML = 'Added: <strong>+' + step.diffSummary.addedNodes + '</strong> | Removed: <strong>-' + step.diffSummary.removedNodes + '</strong>' +
          (step.diffSummary.urlChanged ? ' <span style="color:var(--warning)">(URL Changed)</span>' : '');
      } else {
        telDiff.textContent = 'No DOM mutations detected';
      }

      // 4. Render Timing
      telTiming.innerHTML = 'Title: <strong>' + (step.title || 'Untitled') + '</strong><br>Latency: <strong>' + step.elapsedMs + 'ms</strong>';

      // 5. Render Console
      if (step.consoleLogs && step.consoleLogs.length > 0) {
        telConsole.innerHTML = step.consoleLogs.map(l =>
          '<div style="color:' + (l.type === 'error' ? 'var(--danger)' : 'var(--warning)') + '">[' + l.type.toUpperCase() + '] ' + l.text + '</div>'
        ).join('');
      } else {
        telConsole.innerHTML = '<span style="color:#6b7280;">(Zero console errors)</span>';
      }
    }

    scrubber.addEventListener('input', (e) => {
      renderStep(parseInt(e.target.value, 10));
    });

    document.getElementById('btn-prev').addEventListener('click', () => {
      if (currentIndex > 0) renderStep(currentIndex - 1);
    });

    document.getElementById('btn-next').addEventListener('click', () => {
      if (currentIndex < steps.length - 1) renderStep(currentIndex + 1);
    });

    function togglePlay() {
      isPlaying = !isPlaying;
      btnPlay.textContent = isPlaying ? '❚❚ Pause' : '▶ Play';
      if (isPlaying) {
        if (currentIndex >= steps.length - 1) currentIndex = 0;
        playInterval = setInterval(() => {
          if (currentIndex < steps.length - 1) {
            renderStep(currentIndex + 1);
          } else {
            togglePlay();
          }
        }, 1200);
      } else {
        clearInterval(playInterval);
      }
    }

    btnPlay.addEventListener('click', togglePlay);

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        if (currentIndex > 0) renderStep(currentIndex - 1);
      } else if (e.key === 'ArrowRight') {
        if (currentIndex < steps.length - 1) renderStep(currentIndex + 1);
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      }
    });

    // Initial render
    renderStep(0);
  </script>
</body>
</html>`;
}
