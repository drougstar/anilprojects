// Small DOM helpers shared by the tabs. No pop-ups: the in-app browser hides alert/confirm,
// so confirmations are in-page two-step buttons and dialogs use <dialog>.

export const $ = (sel, root = document) => root.querySelector(sel);

export const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value' && 'value' in n) n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};

// A button that asks once before acting: first tap arms it ("Delete?"), second tap confirms.
export function confirmButton(label, onConfirm, { armedLabel = `${label}? Tap again`, className = 'link danger' } = {}) {
  const b = el('button', { type: 'button', class: className }, label);
  let armed = false, timer = null;
  b.addEventListener('click', () => {
    if (!armed) { armed = true; b.textContent = armedLabel; b.classList.add('armed'); timer = setTimeout(disarm, 5000); return; }
    clearTimeout(timer); disarm(); onConfirm();
  });
  function disarm() { armed = false; b.textContent = label; b.classList.remove('armed'); }
  return b;
}

// Modal dialog. Returns the <dialog>; call .close() to dismiss. Backdrop tap closes it.
export function openDialog(title, body, { onClose, wide = false } = {}) {
  const closeBtn = el('button', { type: 'button', class: 'dialog-close', 'aria-label': 'Close', onclick: () => d.close() }, '×');
  const d = el('dialog', { class: 'dlg' + (wide ? ' wide' : '') },
    el('div', { class: 'dlg-body' }, el('div', { class: 'dlg-head' }, el('h3', {}, title), closeBtn), body));
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
  d.addEventListener('close', () => { d.remove(); onClose && onClose(); });
  document.body.append(d);
  d.showModal();
  return d;
}

export function toast(text, ms = 2500) {
  let host = $('#toast-host');
  if (!host) { host = el('div', { id: 'toast-host' }); document.body.append(host); }
  const t = el('div', { class: 'toast' }, text);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
}

// Labelled field with an explanation line under the input.
export function field(label, input, help) {
  return el('label', { class: 'field' }, el('span', { class: 'lbl' }, label), input, help ? el('small', { class: 'help' }, help) : null);
}
