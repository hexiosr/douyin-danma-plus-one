// ==UserScript==
// @name         抖音直播弹幕 +1
// @namespace    https://github.com/hexiosr/douyin-danma-plus-one
// @version      1.1.2
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
    clearTimeout(chipTimer);
    // 列表节点可能被抖音整块替换，顺便重新绑定滚动容器。
    chipTimer = setTimeout(() => { bindScroller(); syncChips(); }, 150);
  }

  syncChips();
  new MutationObserver(scheduleSync)
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // 抖音在滚动后会把聊天列表写回底部，拦不住事件就冻住元素自己的 scrollTop 赋值：
  // 用户往上翻后位置定住，翻回底部再解冻，恢复新弹幕自动跟随。
  const topAccessor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  let scroller = null;
  let frozenEl = null;
  let lastDir = 0;
  let pointerHeld = false;
  let bottomBtn = null;

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
      const el = frozenEl;
      unfreezeList();
      if (el) el.scrollTop = el.scrollHeight;
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

  window.addEventListener('resize', () => { if (frozenEl) placeBottomBtn(); });

  window.addEventListener('pointerup', () => {
    if (frozenEl && atBottom(frozenEl)) unfreezeList();
  }, { passive: true, capture: true });

  function chatScroller() {
    const list = [...document.querySelectorAll('.webcast-chatroom___list')]
      .find(el => el.querySelector(ITEM_SELECTOR) && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY));
    if (list) return list;
    let el = document.querySelector(ITEM_SELECTOR)?.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return null;
  }

  function atBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  }

  function freezeList(el) {
    if (!topAccessor || !el || frozenEl === el) return;
    unfreezeList();
    frozenEl = el;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get() { return topAccessor.get.call(this); },
      set() {},
    });
    // scrollTo/scrollBy 也是站点滚到底的入口，一并挡住。
    el.scrollTo = () => {};
    el.scrollBy = () => {};
    placeBottomBtn();
  }

  function unfreezeList() {
    const el = frozenEl;
    frozenEl = null;
    if (bottomBtn) bottomBtn.style.display = 'none';
    if (!el) return;
    delete el.scrollTop;
    delete el.scrollTo;
    delete el.scrollBy;
  }

  function bindScroller() {
    const el = chatScroller();
    if (!el) return;
    if (el !== scroller) {
      scroller = el;
      lastDir = 0;
    }
    if (frozenEl && (!frozenEl.isConnected || frozenEl !== el)) unfreezeList();
  }

  // 事件统一在 document 捕获阶段处理：抖音自己会拦滚轮事件，挂在列表上不保险。
  function onWheel(event) {
    const el = scroller;
    if (!el || !el.isConnected) return;
    if (!(event.target instanceof Node) || !el.contains(event.target)) return;
    lastDir = Math.sign(event.deltaY);
    if (el.scrollHeight <= el.clientHeight + 4) return;
    // 本来就往下滚/已在底部时保持自动跟随，其余情况先冻住。
    if (event.deltaY > 0 && atBottom(el)) return;
    freezeList(el);
  }

  function onTouchMove(event) {
    const el = scroller;
    if (!el || !el.isConnected || frozenEl === el) return;
    if (!(event.target instanceof Node) || !el.contains(event.target)) return;
    if (el.scrollHeight <= el.clientHeight + 4 || atBottom(el)) return;
    freezeList(el);
  }

  function onPointerDown(event) {
    const el = scroller;
    if (!el || !el.isConnected || !(event.target instanceof Node) || !el.contains(event.target)) return;
    pointerHeld = true;
    if (event.target !== el) return;
    // 点在滚动条/列表空白处时目标是列表本身，说明用户在手动拖动。
    if (el.scrollHeight <= el.clientHeight + 4 || atBottom(el)) return;
    freezeList(el);
  }

  function onListScroll(event) {
    const el = scroller;
    if (!el || event.target !== el) return;
    if (atBottom(el)) {
      // 冻结期间站点写不进 scrollTop，能滚到底只可能是用户在滚。
      if (frozenEl === el && (pointerHeld || lastDir >= 0)) unfreezeList();
      return;
    }
    // 拖滚动条时按滚动实时判断，不依赖滚轮。
    if (frozenEl !== el && pointerHeld && el.scrollHeight > el.clientHeight + 4) freezeList(el);
  }

  document.addEventListener('wheel', onWheel, { passive: true, capture: true });
  document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
  document.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
  document.addEventListener('scroll', onListScroll, { passive: true, capture: true });
  window.addEventListener('pointerup', () => { pointerHeld = false; }, { passive: true, capture: true });
  window.addEventListener('pointercancel', () => { pointerHeld = false; }, { passive: true, capture: true });

  bindScroller();
  setInterval(bindScroller, 1500);

  // 抖音自己的「N 条新消息」按钮：先解冻，站点滚到底才生效。
  document.addEventListener('click', event => {
    if (!frozenEl) return;
    const target = event.target instanceof Element ? event.target : null;
    const room = target?.closest('.webcast-chatroom');
    if (!room) return;
    for (let el = target, i = 0; el && el !== room && i < 5; i++, el = el.parentElement) {
      if (/^(\d+\s*条|有)?新消息$/.test((el.textContent || '').trim())) {
        unfreezeList();
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
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 2200);
  }
  document.addEventListener('fullscreenchange', () => {
    if (toastEl) (document.fullscreenElement || document.documentElement).appendChild(toastEl);
    if (frozenEl) {
      if (bottomBtn) (document.fullscreenElement || document.documentElement).appendChild(bottomBtn);
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
