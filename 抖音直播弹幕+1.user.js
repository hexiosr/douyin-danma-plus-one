// ==UserScript==
// @name         抖音直播弹幕 +1
// @namespace    https://github.com/hexiosr/douyin-danma-plus-one
// @version      1.2.1
// @description  在抖音直播聊天列表的每条弹幕旁加一个 +1，点击后发送相同内容
// @license      MIT
// @icon         https://cdn.jsdelivr.net/gh/hexiosr/douyin-danma-plus-one@main/icon.png
// @homepageURL  https://github.com/hexiosr/douyin-danma-plus-one
// @supportURL   https://github.com/hexiosr/douyin-danma-plus-one/issues
// @source       https://github.com/hexiosr/douyin-danma-plus-one
// @match        https://live.douyin.com/*
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const ITEM_SELECTOR = '.webcast-chatroom___item';
  const CONTENT_SELECTOR = '.webcast-chatroom___content-with-emoji-text';
  const ROOM_NOTICE_SELECTOR = '.webcast-chatroom__room-message';
  const EDITOR_SELECTOR = ".zone-container[contenteditable='true'], [data-slate-editor='true'][contenteditable='true']";
  const SEND_SELECTOR = ".webcast-chatroom___send-btn, [data-e2e='chat-send-btn'], [class*='send-btn'], [class*='sendBtn'], [class*='send_btn']";
  const SYSTEM_TEXT = /^(来了|为主播点赞了|关注了主播|加入了直播间|分享了直播间|送出)/;
  const MAX_TEXT = 500;
  const CHIP_CLASS = 'dy-plus-one-chip';

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function textOf(node) {
    let out = '';
    const walk = n => {
      if (n.nodeType === 3) { out += n.nodeValue || ''; return; }
      if (n.nodeType !== 1) return;
      if (n.classList?.contains('dy-plus-one-chip')) return;
      if (n.tagName === 'IMG') { out += n.getAttribute('alt') || ''; return; }
      if (/^(SCRIPT|STYLE|SVG|NOSCRIPT)$/.test(n.tagName)) return;
      for (const child of n.childNodes) walk(child);
    };
    walk(node);
    return out.replace(/\u200B/g, '').replace(/[ \t]+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el?.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' && Number(style.opacity) !== 0;
  }

  // 普通弹幕行 = 昵称 span（以冒号结尾）+ 内容 span；系统提示与进场/礼物消息没有这个结构。
  function messageText(item) {
    if (!item?.isConnected || item.querySelector(ROOM_NOTICE_SELECTOR)) return '';
    const line = item.querySelector('.webcast-chatroom___item-wrapper')?.firstElementChild || item.firstElementChild;
    if (!line) return '';
    const semantic = line.querySelector(CONTENT_SELECTOR);
    let text = semantic ? textOf(semantic) : '';
    if (!text) {
      const parts = [...line.children];
      const nickAt = parts.findIndex(el => {
        const label = textOf(el);
        return /[:：]\s*$/.test(label) && label.length <= 40;
      });
      if (nickAt < 0) return '';
      text = parts.slice(nickAt + 1).map(textOf).join('').trim();
    }
    if (!text || text.length > MAX_TEXT || SYSTEM_TEXT.test(text)) return '';
    return text;
  }

  let chipTimer = 0;

  // 每条普通弹幕行末尾插一个内联 +1，不再用遮住昵称的浮层。
  function ensureChip(item) {
    const text = messageText(item);
    const line = item.querySelector('.webcast-chatroom___item-wrapper')?.firstElementChild || item.firstElementChild;
    const existing = item.querySelector(`.${CHIP_CLASS}`);
    if (!text || !line) { existing?.remove(); return; }
    if (existing) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = CHIP_CLASS;
    btn.textContent = '+1';
    btn.title = '发送相同弹幕';
    btn.setAttribute('aria-label', '发送相同弹幕');
    Object.assign(btn.style, {
      display: 'inline-flex', alignItems: 'center', flex: 'none',
      margin: '0 0 0 6px', padding: '0 5px', border: '0', borderRadius: '8px',
      background: 'rgba(254,44,85,.92)', color: '#fff', cursor: 'pointer',
      font: '600 10px/16px system-ui,-apple-system,"Microsoft YaHei",sans-serif',
      verticalAlign: 'middle',
    });
    btn.addEventListener('pointerdown', event => event.stopPropagation());
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      // 节点可能被列表回收改成别的弹幕，点的时候重新读一次。
      const current = messageText(item);
      if (current) sendPlusOne(current, btn);
    });
    line.appendChild(btn);
  }

  function syncChips() {
    for (const item of document.querySelectorAll(ITEM_SELECTOR)) ensureChip(item);
  }

  function scheduleSync() {
    // 弹幕密集时 mutation 几乎不停，用节流保证 +1 按钮持续补上。
    if (chipTimer) return;
    chipTimer = setTimeout(() => {
      chipTimer = 0;
      bindScroller();
      syncChips();
    }, 120);
  }

  syncChips();
  new MutationObserver(scheduleSync)
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // 抖音会把新弹幕继续渲进可视区，锁 scrollTop 拦不住内容本身的变化。
  // 所以滚动时照常走实时列表，停手后再把当前列表克隆一份盖在原位，
  // 原列表藏起来继续跟到底；用户看到的是静止快照，继续滚动时再交回实时列表。
  const OVERLAY_CLASS = 'dy-plus-one-snapshot';
  const HIDDEN_CLASS = 'dy-plus-one-hidden';
  let scroller = null;
  let frozenEl = null;
  let overlay = null;
  let frozenHref = '';
  let bottomBtn = null;
  let idleTimer = 0;
  let pointerHeld = false;

  function inOverlay(node) {
    return node instanceof Element && !!node.closest(`.${OVERLAY_CLASS}`);
  }

  function clampTop(el, value) {
    return Math.max(0, Math.min(value, Math.max(0, el.scrollHeight - el.clientHeight)));
  }

  function ensureSnapshotStyle() {
    if (document.getElementById('dy-plus-one-snapshot-style')) return;
    const style = document.createElement('style');
    style.id = 'dy-plus-one-snapshot-style';
    style.textContent = `.${OVERLAY_CLASS},.${OVERLAY_CLASS} *{scrollbar-width:none!important}` +
      `.${OVERLAY_CLASS}::-webkit-scrollbar{display:none!important}` +
      `.${HIDDEN_CLASS}{visibility:hidden!important}`;
    (document.head || document.documentElement).appendChild(style);
  }

  // 用户停手后给当前画面拍快照；滚动过程中仍然走实时列表，历史弹幕照常加载。
  function noteScrollActivity() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (overlay || pointerHeld) return;
      const el = scroller;
      if (!el || !el.isConnected) return;
      if (el.scrollHeight <= el.clientHeight + 4 || atBottom(el)) return;
      // 正在选中弹幕准备复制时别拍快照，否则选区会丢。
      const selection = getSelection();
      if (selection && !selection.isCollapsed && el.contains(selection.anchorNode)) return;
      freezeSnapshot(el);
    }, 300);
  }

  function freezeSnapshot(el) {
    if (overlay || !el || !el.isConnected) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    ensureSnapshotStyle();
    const box = document.createElement('div');
    box.className = OVERLAY_CLASS;
    Object.assign(box.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      zIndex: '2147482900',
      background: 'transparent',
      margin: '0',
      padding: '0',
    });
    const clone = el.cloneNode(true);
    clone.removeAttribute('id');
    Object.assign(clone.style, {
      width: '100%',
      height: '100%',
      margin: '0',
      overflowY: 'auto',
      overflowX: 'hidden',
    });
    box.appendChild(clone);
    // 聊天面板的字体和颜色可能挂在祖先上，克隆后补一份。
    const cs = getComputedStyle(el);
    box.style.color = cs.color;
    box.style.font = cs.font;
    (document.fullscreenElement || document.documentElement).appendChild(box);

    // cloneNode 不带监听，把 +1 重新绑到克隆出来的行上。
    const liveItems = [...el.querySelectorAll(ITEM_SELECTOR)];
    const cloneItems = [...clone.querySelectorAll(ITEM_SELECTOR)];
    cloneItems.forEach((item, index) => {
      const chip = item.querySelector(`.${CHIP_CLASS}`);
      if (!chip) return;
      const source = liveItems[index];
      const text = source ? messageText(source) : '';
      if (!text) { chip.remove(); return; }
      chip.disabled = false;
      chip.textContent = '+1';
      chip.addEventListener('pointerdown', event => event.stopPropagation());
      chip.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        sendPlusOne(text, chip);
      });
    });

    clone.scrollTop = clampTop(clone, el.scrollTop);
    const prevVisibility = el.style.getPropertyValue('visibility');
    const prevPriority = el.style.getPropertyPriority('visibility');
    el.classList.add(HIDDEN_CLASS);
    el.style.setProperty('visibility', 'hidden', 'important');
    overlay = { box, clone, el, prevVisibility, prevPriority };
    frozenEl = el;
    frozenHref = location.href;
    placeBottomBtn();

    // 在快照上继续滚，说明还要往前翻：交回实时列表，让站点照常加载更早的弹幕。
    clone.addEventListener('wheel', event => {
      if (overlay?.clone !== clone) return;
      event.preventDefault();
      handBack(clone.scrollTop + event.deltaY);
    }, { passive: false });
    clone.addEventListener('touchend', () => {
      if (overlay?.clone === clone && atBottom(clone)) unfreezeSnapshot();
    }, { passive: true });
  }

  // 撤掉快照并把实时列表滚到指定位置，后续滚动重新走实时列表。
  function handBack(targetTop) {
    if (!overlay) return;
    const { box, el, prevVisibility, prevPriority } = overlay;
    box.remove();
    overlay = null;
    if (bottomBtn) bottomBtn.style.display = 'none';
    if (el && el.isConnected) {
      el.classList.remove(HIDDEN_CLASS);
      if (prevVisibility) el.style.setProperty('visibility', prevVisibility, prevPriority);
      else el.style.removeProperty('visibility');
      el.scrollTop = clampTop(el, targetTop);
    }
    frozenEl = null;
    noteScrollActivity();
  }

  function unfreezeSnapshot() {
    const el = overlay?.el;
    handBack(el ? el.scrollHeight : 0);
  }

  function placeOverlay() {
    if (!overlay || !overlay.el?.isConnected) return;
    const rect = overlay.el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const { box } = overlay;
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  function ensureBottomBtn() {
    if (bottomBtn?.isConnected) return bottomBtn;
    bottomBtn = document.createElement('button');
    bottomBtn.type = 'button';
    bottomBtn.textContent = '回到底部';
    bottomBtn.title = '恢复自动滚动';
    Object.assign(bottomBtn.style, {
      position: 'fixed', zIndex: '2147483000', display: 'none',
      padding: '4px 10px', border: '1px solid rgba(255,255,255,.28)', borderRadius: '999px',
      background: 'rgba(28,29,38,.9)', color: '#f5f6fa', cursor: 'pointer',
      font: '12px/18px system-ui,-apple-system,"Microsoft YaHei",sans-serif',
    });
    bottomBtn.addEventListener('pointerdown', event => event.stopPropagation());
    bottomBtn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      unfreezeSnapshot();
    });
    (document.fullscreenElement || document.documentElement).appendChild(bottomBtn);
    return bottomBtn;
  }

  function placeBottomBtn() {
    if (!frozenEl) return;
    const btn = ensureBottomBtn();
    const rect = frozenEl.getBoundingClientRect();
    btn.style.right = `${Math.max(10, Math.round(innerWidth - rect.right + 10))}px`;
    btn.style.bottom = `${Math.max(10, Math.round(innerHeight - rect.bottom + 10))}px`;
    btn.style.display = 'block';
  }

  window.addEventListener('resize', () => {
    if (frozenEl) placeBottomBtn();
    placeOverlay();
  });

  // 从事件目标往上找真正在滚的聊天容器，页面换布局也不会失去绑定。
  function scrollableFrom(node) {
    let el = node instanceof Element ? node : node && node.parentElement;
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (inOverlay(el)) return null;
      if (/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) &&
          el.scrollHeight > el.clientHeight + 4 && el.querySelector(ITEM_SELECTOR)) return el;
    }
    return null;
  }

  function scrollerFor(node) {
    if (scroller && scroller.isConnected && node instanceof Node && scroller.contains(node)) return scroller;
    return scrollableFrom(node);
  }

  function chatScroller() {
    const list = [...document.querySelectorAll('.webcast-chatroom___list')]
      .find(el => !inOverlay(el) && el.querySelector(ITEM_SELECTOR) && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY));
    return list || scrollableFrom([...document.querySelectorAll(ITEM_SELECTOR)].find(el => !inOverlay(el)));
  }

  function atBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  }

  function bindScroller() {
    const el = chatScroller();
    if (el) scroller = el;
  }

  // 事件统一在 document 捕获阶段处理：抖音自己会拦滚轮事件，挂在列表上不保险。
  function onWheel(event) {
    const el = scrollerFor(event.target);
    if (!el) return; // 快照里的滚动由快照自己交回实时列表
    scroller = el;
    if (el.scrollHeight <= el.clientHeight + 4) return;
    if (event.deltaY > 0 && atBottom(el)) { clearTimeout(idleTimer); return; }
    noteScrollActivity();
  }

  // 触屏同样松手后再拍快照。
  function onTouchEnd(event) {
    if (overlay) return;
    const el = scrollerFor(event.target);
    if (!el) return;
    scroller = el;
    if (el.scrollHeight <= el.clientHeight + 4 || atBottom(el)) return;
    noteScrollActivity();
  }

  document.addEventListener('wheel', onWheel, { passive: true, capture: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  document.addEventListener('pointerdown', () => {
    pointerHeld = true;
    clearTimeout(idleTimer);
  }, { passive: true, capture: true });
  document.addEventListener('pointerup', () => { pointerHeld = false; }, { passive: true, capture: true });
  document.addEventListener('pointercancel', () => { pointerHeld = false; }, { passive: true, capture: true });

  bindScroller();
  setInterval(() => {
    bindScroller();
    if (overlay && location.href !== frozenHref) unfreezeSnapshot();
  }, 1500);

  // 抖音自己的「N 条新消息」按钮：先解冻，站点滚到底才生效。
  document.addEventListener('click', event => {
    if (!overlay) return;
    const target = event.target instanceof Element ? event.target : null;
    if (inOverlay(target)) return;
    const room = target?.closest('.webcast-chatroom');
    if (!room) return;
    for (let el = target, i = 0; el && el !== room && i < 5; i++, el = el.parentElement) {
      if (/^(\d+\s*条|有)?新消息$/.test((el.textContent || '').trim())) {
        unfreezeSnapshot();
        return;
      }
    }
  }, true);

  function findEditor() {
    for (const scope of [...document.querySelectorAll('#chatInput')].filter(isVisible)) {
      const preferred = scope.querySelector(EDITOR_SELECTOR);
      const editor = preferred && isVisible(preferred)
        ? preferred
        : [...scope.querySelectorAll("[contenteditable='true'], textarea, input[type='text']")].find(isVisible);
      if (editor) return editor;
    }
    return [...document.querySelectorAll(EDITOR_SELECTOR)].find(isVisible) || null;
  }

  function findSend(editor) {
    const scope = editor.closest('#chatInput, .webcast-chatroom, [class*="chatroom"]');
    const byText = el => /^发送$/.test((el.textContent || '').trim());
    for (const root of [scope, document]) {
      if (!root) continue;
      const hit = [...root.querySelectorAll(SEND_SELECTOR)].find(isVisible);
      if (hit) return hit;
      const text = [...root.querySelectorAll('button, [role="button"], [class*="btn"], [class*="button"]')]
        .find(el => isVisible(el) && byText(el));
      if (text) return text;
    }
    return null;
  }

  function unavailable(el) {
    return !el || !el.isConnected || el.disabled || el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('disable') || el.classList.contains('disabled');
  }

  function readEditor(editor) {
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') return editor.value;
    return textOf(editor);
  }

  function normalize(input) {
    return String(input).replace(/[\u200B\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  }

  function sameText(value, text) {
    return normalize(value) === normalize(text);
  }

  function insertOnce(editor, text) {
    editor.focus({ preventScroll: true });
    const selection = getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    // execCommand 走编辑器原生插入流程，Slate 等受控编辑器才会同步内部状态。
    try { inserted = document.execCommand('insertText', false, text); } catch { inserted = false; }
    if (sameText(readEditor(editor), text)) return true;
    // 表情等会被站点改写成图片，只要确实写进去了就算成功。
    if (inserted && readEditor(editor).trim()) return true;
    // 有的编辑器自己处理 beforeinput，需要先发事件再补 input。
    editor.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: text,
    }));
    if (sameText(readEditor(editor), text) || readEditor(editor).trim()) return true;
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: text,
    }));
    return sameText(readEditor(editor), text);
  }

  async function writeEditor(editor, text) {
    if (!editor?.isConnected || editor.disabled || editor.readOnly ||
        editor.getAttribute('aria-disabled') === 'true') return false;
    const plain = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';
    if (!plain && editor.getAttribute('contenteditable') !== 'true') return false;
    if (plain && editor.maxLength >= 0 && text.length > editor.maxLength) return false;
    if (plain) {
      editor.focus({ preventScroll: true });
      const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(editor, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      return editor.value === text;
    }
    // 编辑器刚聚焦、刚清空或页面刚重绘时可能拒绝一次输入，重试几次。
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(120);
      if (!editor.isConnected) return false;
      if (insertOnce(editor, text)) return true;
    }
    return false;
  }

  let toastEl = null;
  let toastTimer = 0;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', right: '16px', bottom: '96px', zIndex: '2147483647',
        padding: '7px 12px', border: '1px solid #444653', borderRadius: '8px',
        background: 'rgba(28,29,38,.94)', color: '#f5f6fa', pointerEvents: 'none',
        font: '13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif',
        transition: 'opacity .18s', opacity: '0',
      });
      (document.fullscreenElement || document.documentElement).appendChild(toastEl);
    }
    // 「回到底部」按钮常驻右下角，提示让到它上方，避免叠在一起。
    const btn = bottomBtn && bottomBtn.style.display !== 'none' ? bottomBtn.getBoundingClientRect() : null;
    toastEl.style.bottom = btn ? `${Math.round(innerHeight - btn.top + 8)}px` : '96px';
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 2200);
  }
  document.addEventListener('fullscreenchange', () => {
    const root = document.fullscreenElement || document.documentElement;
    if (toastEl) root.appendChild(toastEl);
    // 全屏布局会变，快照位置对不上，直接回到实时弹幕。
    if (overlay) { unfreezeSnapshot(); return; }
    if (frozenEl && bottomBtn) {
      root.appendChild(bottomBtn);
      placeBottomBtn();
    }
  });

  let busy = false;
  let lastSend = 0;

  function clearEditor(editor) {
    const plain = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';
    editor.focus({ preventScroll: true });
    if (plain) {
      const proto = editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(editor, '');
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
      return;
    }
    const selection = getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    try { document.execCommand('delete'); } catch { /* 清不掉时会提示手动清空 */ }
  }

  function enterEvent(type) {
    const event = new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter',
      bubbles: true, composed: true, cancelable: true,
    });
    // KeyboardEvent 构造器不认 keyCode/which，但有的站点只按这两个旧字段判断回车。
    const code = type === 'keypress' ? 13 : 0;
    Object.defineProperties(event, {
      keyCode: { get: () => 13 },
      which: { get: () => 13 },
      charCode: { get: () => code },
    });
    return event;
  }

  function pressEnter(editor) {
    editor.dispatchEvent(enterEvent('keydown'));
    editor.dispatchEvent(enterEvent('keypress'));
    editor.dispatchEvent(enterEvent('keyup'));
  }

  function clickElement(el) {
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    }
    el.dispatchEvent(new MouseEvent('mousedown', base));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', base));
  }

  async function waitCleared(ms) {
    const deadline = Date.now() + ms;
    do {
      await sleep(50);
      const current = findEditor();
      if (!current || !readEditor(current).trim()) return true;
    } while (Date.now() < deadline);
    return false;
  }

  async function sendPlusOne(text, chip) {
    if (busy) return;
    const editor = findEditor();
    if (!editor) { toast('未找到弹幕输入框，请先登录'); return; }
    if (unavailable(editor)) { toast('当前不能发言，请查看抖音提示'); return; }
    if (Date.now() - lastSend < 1200) { toast('发送太频繁，稍等一下'); return; }
    // 不管输入框里剩了什么，先清空，否则 +1 的内容填不进去。
    if (readEditor(editor).trim()) {
      clearEditor(editor);
      await sleep(40);
      if (readEditor(editor).trim()) { toast('输入框无法清空，请手动清空'); return; }
    }
    const maxLength = Number(editor.getAttribute('maxlength'));
    if (maxLength > 0 && text.length > maxLength) { toast('超过输入框字数限制，未发送'); return; }

    busy = true;
    chip.disabled = true;
    chip.textContent = '…';
    try {
      if (!(await writeEditor(editor, text))) { toast('未能写入输入框，请重试'); return; }
      await sleep(80);
      const written = normalize(readEditor(editor));
      if (!written) { toast('输入内容被清空，未发送'); return; }
      // 抖音按账号限制弹幕字数，超出的部分会被输入框直接吞掉，只发前半段没意义。
      const wanted = normalize(text);
      if (written.length < wanted.length && wanted.startsWith(written)) {
        toast(`抖音只允许 ${written.length} 个字，未能整条发送`);
        return;
      }
      // 抖音聊天框默认回车发送，先走回车；没反应再点发送按钮。
      lastSend = Date.now();
      editor.focus({ preventScroll: true });
      pressEnter(editor);
      if (await waitCleared(1600)) { toast('已发送 +1'); return; }
      const send = findSend(editor);
      if (send && send.isConnected && !send.disabled) {
        clickElement(send);
        if (await waitCleared(1600)) { toast('已发送 +1'); return; }
      }
      toast('已填入内容，请手动发送');
    } finally {
      busy = false;
      chip.disabled = false;
      chip.textContent = '+1';
    }
  }
})();
