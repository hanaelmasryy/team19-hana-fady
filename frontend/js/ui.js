// Small DOM helpers for the screens. Owner: Hana Fady (issue #10).
// Everything is created with createElement + textContent, never innerHTML,
// so text from the database is always shown as text and can't run as script.

(function (root) {
  // el('button', { type: 'button', className: 'secondary', onClick: fn }, 'Save')
  function el(tag, props = {}, ...children) {
    const node = root.document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'className') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node && typeof value !== 'string') node[key] = value; // e.g. disabled, value
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof root.Node ? child : root.document.createTextNode(String(child)));
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // A message area: <p class="message" role="status" hidden></p>
  function showMessage(node, text, kind = 'ok') {
    node.textContent = text;
    node.className = `message ${kind}`;
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.hidden = false;
  }

  function hideMessage(node) {
    node.hidden = true;
    node.textContent = '';
  }

  // "2026-11-23T19:27:50Z" -> "23 Nov 2026" (local date)
  function formatDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Runs an async action with the button disabled, so a double click can't send it twice.
  async function busy(button, action) {
    if (button.disabled) return undefined;
    button.disabled = true;
    try {
      return await action();
    } finally {
      button.disabled = false;
    }
  }

  // Waits until the user stops typing (search boxes).
  function debounce(fn, ms = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  root.ui = { el, clear, showMessage, hideMessage, formatDate, busy, debounce };
})(window);
