export function isComposer(element) {
  if (!(element instanceof HTMLElement)) return false;
  const editor = element.closest('[contenteditable="true"][role="textbox"],textarea');
  if (!editor || editor.closest('[data-pff-host]')) return false;
  const label = editor.getAttribute("aria-label") || "";
  return editor.hasAttribute("data-lexical-editor") || /message|tin nhắn|nhắn tin/i.test(label)
    || (/\/messages(?:\/|$)|\/t\//.test(location.pathname) && !/search|tìm kiếm|comment|bình luận/i.test(label));
}

export function installFocusGuard(config, count) {
  const original = HTMLElement.prototype.focus;
  let owner = null, selection = null, touched = 0, composing = false, restoring = false;
  const activeLock = () => config().focusGuard && owner?.isConnected && Date.now() - touched < 30000;
  const rememberSelection = () => {
    if (!owner?.isConnected) return;
    const s = document.getSelection();
    if (s?.rangeCount && owner.contains(s.anchorNode) && owner.contains(s.focusNode)) selection = s.getRangeAt(0).cloneRange();
  };
  const remember = event => {
    if (!isComposer(event.target)) return;
    owner = event.target.closest('[contenteditable="true"][role="textbox"],textarea'); touched = Date.now(); rememberSelection();
  };
  // A real user action releases the lock before Facebook handles it.
  document.addEventListener("pointerdown", event => {
    if (event.isTrusted && !owner?.contains(event.target)) { owner = null; selection = null; composing = false; }
  }, true);
  document.addEventListener("keydown", event => {
    if (event.isTrusted && ["Tab", "Escape"].includes(event.key)) { owner = null; selection = null; composing = false; }
  }, true);
  document.addEventListener("input", remember, true);
  document.addEventListener("keyup", remember, true);
  document.addEventListener("compositionstart", event => { if (isComposer(event.target)) { remember(event); composing = true; } }, true);
  document.addEventListener("compositionend", event => { composing = false; remember(event); }, true);
  document.addEventListener("selectionchange", rememberSelection);
  HTMLElement.prototype.focus = function (...args) {
    if (!restoring && activeLock() && this !== owner && isComposer(this)) { count("focusBlocked"); return; }
    return Reflect.apply(original, this, args);
  };
  document.addEventListener("focusin", event => {
    if (restoring || !activeLock() || event.target === owner || !isComposer(event.target)) return;
    restoring = true;
    try {
      original.call(owner, { preventScroll: true });
      if (!composing && selection && owner.contains(selection.startContainer) && owner.contains(selection.endContainer)) {
        const s = document.getSelection(); s.removeAllRanges(); s.addRange(selection);
      }
      count("focusBlocked");
    } finally { restoring = false; }
  }, true);
}

export function installReloadGuard(config, count) {
  const hidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  let lastIntent = 0, returnedAt = 0, wasHidden = false;
  const feed = () => !/\/messages(?:\/|$)|\/t\/|\/login|\/checkpoint|\/settings|\/dialog|\/recover|\/logout/.test(location.pathname)
    && /(^|\.)facebook\.com$/.test(location.hostname);
  const enabled = () => config().antiReload && feed();
  const nativeHidden = () => hidden?.get?.call(document) ?? false;
  const intent = event => { if (event.isTrusted) lastIntent = Date.now(); };
  add.call(document, "pointerdown", intent, true); add.call(document, "keydown", intent, true);
  add.call(document, "visibilitychange", () => {
    if (nativeHidden()) wasHidden = true;
    else if (wasHidden) { returnedAt = Date.now(); wasHidden = false; }
  }, true);
  for (const [key, descriptor, fake] of [["hidden", hidden, false], ["visibilityState", visibility, "visible"]]) {
    if (descriptor?.get) Object.defineProperty(document, key, { configurable: true,
      get() { return enabled() ? fake : descriptor.get.call(this); } });
  }
  const wrapped = new WeakMap();
  const selected = (target, type) => ((target === document || target === window) && ["visibilitychange", "webkitvisibilitychange"].includes(type))
    || (target === window && ["focus", "blur"].includes(type));
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!listener || !selected(this, type)) return Reflect.apply(add, this, arguments);
    let proxy = wrapped.get(listener);
    if (!proxy) {
      proxy = function (event) {
        if (enabled()) { count("reloadSignalsBlocked"); return; }
        if (typeof listener === "function") return listener.call(this, event);
        return listener.handleEvent(event);
      };
      wrapped.set(listener, proxy);
    }
    return add.call(this, type, proxy, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    return remove.call(this, type, selected(this, type) && listener ? wrapped.get(listener) || listener : listener, options);
  };
  if (window.navigation) add.call(window.navigation, "navigate", event => {
    if (!enabled() || !event.cancelable || event.userInitiated || Date.now() - lastIntent < 2000) return;
    const destination = new URL(event.destination.url);
    if (destination.origin !== location.origin) return;
    // Never block authentication, back/forward, user clicks or unrelated routes.
    const sameDocumentURL = destination.pathname === location.pathname && destination.search === location.search;
    const backgroundHomeReset = destination.pathname === "/" && (nativeHidden() || Date.now() - returnedAt < 30000);
    if ((event.navigationType === "reload" && sameDocumentURL) ||
        (["push", "replace"].includes(event.navigationType) && backgroundHomeReset)) {
      event.preventDefault(); count("navigationsBlocked");
    }
  });
}
