/** 全局提示条（shared 基础能力）。 */
let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, durationMs = 2600): void {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'app-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(timer);
  timer = setTimeout(() => el?.classList.remove('is-visible'), durationMs);
}
