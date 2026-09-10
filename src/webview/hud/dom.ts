export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function button(text: string, className: string, title?: string): HTMLButtonElement {
  const element = el('button', className, text);
  element.type = 'button';
  if (title) element.title = title;
  return element;
}
