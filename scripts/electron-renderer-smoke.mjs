import { app, BrowserWindow } from "electron";

app.on("ready", async () => {
  const window = new BrowserWindow({ width: 900, height: 600, show: true });
  await window.loadURL(`data:text/html,${encodeURIComponent(`
  <!doctype html><html><body>
    <main><h1>Meetless renderer smoke</h1>
      <label>Recording title <input data-testid="recording-title-input" aria-label="Recording title"></label>
      <button data-testid="recording-start" aria-label="Start recording">Start recording</button>
      <button data-testid="recording-stop" aria-label="Stop recording" hidden>Stop</button>
      <output data-testid="visible-state">idle</output>
    </main>
    <script>
      const title = document.querySelector('[data-testid="recording-title-input"]');
      const start = document.querySelector('[data-testid="recording-start"]');
      const stop = document.querySelector('[data-testid="recording-stop"]');
      const state = document.querySelector('[data-testid="visible-state"]');
      start.onclick = () => { if (!title.value.trim()) return; start.hidden = true; stop.hidden = false; state.textContent = 'recording'; };
      stop.onclick = () => { stop.hidden = true; start.hidden = false; state.textContent = 'saved'; };
    </script>
  </body></html>
  `)}`);
});

app.on("window-all-closed", () => app.quit());
