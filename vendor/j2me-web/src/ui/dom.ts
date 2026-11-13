type Child = Node | string | null | undefined | false;

interface Props {
  class?: string;
  text?: string;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: any) => void>>;
  attrs?: Record<string, string>;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) el.setAttribute(name, value);
  for (const [event, handler] of Object.entries(props.on ?? {})) el.addEventListener(event, handler as EventListener);
  for (const child of children) if (child) el.append(child);
  return el;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  if (toastTimer) clearTimeout(toastTimer);
  const el = h('div', { class: 'toast', text: message, attrs: { role: 'alert' } });
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 5000);
}
