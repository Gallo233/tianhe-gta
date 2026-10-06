/**
 * Uncaught errors, rejected promises and a lost WebGL context. A frame that throws used to end the loop silently --
 * the HUD stays up over an empty canvas and nothing says why -- so each distinct error is shown on screen and, on
 * the dev server, appended to guangzhou/logs/client_errors.log through /__err (with the browser and the GPU).
 */
const seen = new Set<string>();
let gl: WebGL2RenderingContext | null = null;
let box: HTMLElement | null = null;

/** The renderer's context, for the GPU line of a report (asking the canvas for a context could create one). */
export function noteContext(context: WebGL2RenderingContext): void { gl = context; }

function gpuInfo(): Record<string, unknown> {
  if (!gl) return {};
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      lost: gl.isContextLost(),
      clipControl: !!gl.getExtension('EXT_clip_control'),
      floatTargets: !!gl.getExtension('EXT_color_buffer_float'),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
  } catch { return {}; }
}

function show(text: string): void {
  if (!box) {
    box = document.createElement('div');
    box.id = 'error-report';
    box.style.cssText = 'position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:100;max-width:min(720px,90vw);'
      + 'padding:12px 16px;border-radius:8px;background:rgba(120,20,20,0.92);color:#fff;font:13px/1.5 ui-monospace,Menlo,monospace;'
      + 'white-space:pre-wrap;word-break:break-word;box-shadow:0 6px 24px rgba(0,0,0,0.4);pointer-events:none';
    document.body.appendChild(box);
  }
  const lines = (box.dataset.lines ? box.dataset.lines.split('\n') : []).concat(text).slice(-4);
  box.dataset.lines = lines.join('\n');
  box.textContent = `出错了（截图发给开发者，按 F5 重新加载）\n${lines.join('\n')}`;
}

export function reportError(kind: string, err: unknown): void {
  const e = err instanceof Error ? err : null;
  const msg = e ? `${e.name}: ${e.message}` : String(err);
  if (seen.has(kind + msg)) return;
  seen.add(kind + msg);
  console.error(`[${kind}]`, err);
  show(`${kind}：${msg}`);
  if (!import.meta.env.DEV) return;
  const body = JSON.stringify({
    t: new Date().toISOString(), kind, msg, stack: e?.stack ?? '', url: location.href, ua: navigator.userAgent,
    view: [innerWidth, innerHeight, devicePixelRatio], gpu: gpuInfo(),
  });
  fetch('/__err', { method: 'POST', body }).catch(() => { /* server gone */ });
}

export function installErrorReport(canvas: HTMLCanvasElement): void {
  window.addEventListener('error', (ev) => reportError('脚本', ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError('异步', ev.reason));
  canvas.addEventListener('webglcontextlost', () => reportError('显卡', 'WebGL 上下文丢失（显存不足或 GPU 进程重启）'));
}
