// Minimal Chrome DevTools Protocol client (Node 22 global WebSocket and fetch, no packages).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
export const findChrome = custom => [custom, ...CHROME_PATHS].find(p => p && existsSync(p)) || null;

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await res.json()).filter(t => t.type === 'page');
}

export async function isUp(port) {
  try { await listTargets(port); return true; } catch { return false; }
}

// Starts a separate Chrome with its own profile so the user's normal Chrome is never touched.
export async function launchChrome({ chromePath, port, profileDir, url, headless = false }) {
  const exe = findChrome(chromePath);
  if (!exe) throw new Error('ไม่พบ Google Chrome หรือ Microsoft Edge ในเครื่อง');
  mkdirSync(profileDir, { recursive: true });
  const args = [`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking', ...(headless ? ['--headless=new', '--disable-gpu'] : ['--new-window']), url];
  const child = spawn(exe, args, { detached: !headless, stdio: 'ignore' });
  if (!headless) child.unref();
  // Wait until the start page is the active tab (the first target is about:blank for a moment).
  for (let i = 0; i < 75; i++) {
    const pages = await listTargets(port).catch(() => null);
    if (pages && pages.some(p => p.url !== 'about:blank')) return child;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('เปิด Chrome แล้วแต่เชื่อมต่อไม่ได้');
}

export class Page {
  static async attach(target) {
    const p = new Page();
    p.target = target;
    p.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, bad) => { p.ws.onopen = ok; p.ws.onerror = () => bad(new Error('เชื่อมต่อหน้าเว็บไม่ได้')); });
    p.seq = 0; p.waiting = new Map(); p.dialogs = []; p.closed = false;
    p.ws.onmessage = e => p.#onMessage(JSON.parse(e.data));
    p.ws.onclose = () => { p.closed = true; for (const [, w] of p.waiting) w.reject(new Error('หน้าเว็บถูกปิด')); };
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    return p;
  }

  #onMessage(m) {
    if (m.id && this.waiting.has(m.id)) {
      const w = this.waiting.get(m.id); this.waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
    } else if (m.method === 'Page.javascriptDialogOpening') {
      // alert/confirm would freeze the page; record the text and answer it. confirm() is declined
      // unless the engine explicitly armed acceptNextConfirm.
      this.dialogs.push({ type: m.params.type, message: m.params.message });
      const accept = m.params.type === 'alert' || (m.params.type === 'confirm' && this.acceptNextConfirm);
      this.acceptNextConfirm = false;
      this.send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
    }
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('หน้าเว็บถูกปิด'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, { awaitPromise = false } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  // Calls fn(arg) in the page; fn must be self-contained.
  call(fn, arg) {
    return this.eval(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`, { awaitPromise: true });
  }

  url() { return this.eval('location.href'); }

  async waitReady(timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.eval(`document.readyState === 'complete' && location.href !== 'about:blank'`).catch(() => false)) return;
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('รอหน้าเว็บโหลดนานเกินไป');
  }

  // Run an action that submits a form or navigates, and wait until the new document has loaded.
  async navigateBy(action, { timeout = 60000 } = {}) {
    const mark = `m${Date.now()}${Math.random()}`;
    await this.eval(`window.__llan = ${JSON.stringify(mark)}`);
    await action();
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      await new Promise(r => setTimeout(r, 250));
      try {
        const state = await this.eval(`[window.__llan === ${JSON.stringify(mark)}, document.readyState]`);
        if (!state[0] && state[1] === 'complete') return;
      } catch { /* document is being replaced */ }
    }
    throw new Error('รอหน้าเว็บโหลดนานเกินไป');
  }

  goto(url, opts) { return this.navigateBy(() => this.send('Page.navigate', { url }), opts); }

  async screenshot() {
    const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: true });
    return Buffer.from(r.data, 'base64');
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}
