import './ui/styles.css';
import { registerSW } from 'virtual:pwa-register';
import { App, exposeDebug } from './app/app';

function fatal(err: unknown): void {
  console.error(err);
  const boot = document.getElementById('boot');
  if (boot) {
    boot.classList.remove('hidden');
    const msg = err instanceof Error ? err.message : String(err);
    boot.innerHTML = `<div class="boot-title">PLANET X</div><div class="boot-sub" style="animation:none;color:#e2583f">UPLINK FAILED</div><div style="max-width:420px;text-align:center;color:#84969b;font-size:13px;line-height:1.5;padding:0 20px">${msg.replace(/</g, '&lt;')}<br/>WebGL2 is required. Try a recent Chrome, Edge or Firefox.</div>`;
  }
}

function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

if (!hasWebGL2()) {
  fatal(new Error('This device or browser does not support WebGL2.'));
} else {
  try {
    const app = new App();
    exposeDebug(app);
    app.start().catch(fatal);
  } catch (err) {
    fatal(err);
  }
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  registerSW({ immediate: true });
}
