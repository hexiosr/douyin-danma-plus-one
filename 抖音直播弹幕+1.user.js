// ==UserScript==
// @name         抖音直播弹幕 +1
// @namespace    https://github.com/hexiosr/douyin-danma-plus-one
// @version      1.1.5
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

  // 抖音在滚动后会把聊天列表写回底部。用户往上翻后冻住列表自身的 scrollTop 赋值；
  // 弹幕多时列表会回收/重排节点，这里再按画面里的弹幕把位置拉回来。
  const topAccessor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  let scroller = null;
  let frozenEl = null;
  let paused = false;
  let lastDir = 0;
  let pointerHeld = false;
  let lastUserInput = 0;
  let pauseRaf = 0;
  let lastSampleAt = 0;
  let samples = [];
  let lastFrozenSt = 0;
  let frozenHref = '';
  let bottomBtn = null;

  function itemEntries(el) {
    return [...el.querySelectorAll(ITEM_SELECTOR)].map(item => ({
      item,
      key: messageText(item) || textOf(item),
    }));
  }

  // 记录视口内的弹幕和位置，冻结期间当作锚点。
  function takeSamples(el) {
    samples = [];
    const top = el.getBoundingClientRect().top;
    const height = el.clientHeight;
    for (const { item, key } of itemEntries(el)) {
      if (!key) continue;
      const rect = item.getBoundingClientRect();
      const off = rect.top - top;
      if (rect.height && off + rect.height > 0 && off < height) samples.push({ key, off, item });
    }
  }

  function clampTop(el, value) {
    return Math.max(0, Math.min(value, Math.max(0, el.scrollHeight - el.clientHeight)));
  }

  // 把最早还在视口里的锚点弹幕挪回冻结时的位置，返回是否找到锚点。
  // 走原生 setter，绕过我们自己挡住的赋值；每帧只校一个锚点，开销很小。
  function alignView(el) {
    const top = el.getBoundingClientRect().top;
    for (const sample of samples) {
      let best = sample.item;
      if (!best || !best.isConnected || (messageText(best) || textOf(best)) !== sample.key) {
        best = null;
        let bestGap = Infinity;
        for (const { item, key } of itemEntries(el)) {
          if (key !== sample.key) continue;
          const gap = Math.abs(item.getBoundingClientRect().top - top - sample.off);
          if (gap < bestGap) { bestGap = gap; best = item; }
        }
        if (!best) continue;
        sample.item = best;
      }
      const delta = (best.getBoundingClientRect().top - top) - sample.off;
      if (Math.abs(delta) >= 2 && Math.abs(delta) < el.clientHeight) {
        topAccessor.set.call(el, clampTop(el, topAccessor.get.call(el) + delta));
      }
      return true;
    }
    return false;
  }

  // 站点还可能用 scroll / scrollIntoView 把新弹幕带进视野，这两种原生滚动碰不到 scrollTop。
  const nativeScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...args) {
    if (paused && frozenEl && frozenEl.contains(this)) return;
    return nativeScrollIntoView.apply(this, args);
  };

  function releaseFreeze(el) {
    delete el.scrollTop;
    delete el.scrollTo;
    delete el.scrollBy;
    delete el.scroll;
  }

  function freezeList(el, restore) {
    if (!topAccessor || !el || !el.isConnected) return;
    if (frozenEl === el) { paused = true; return; }
    const prevSt = frozenEl ? (frozenEl.isConnected ? topAccessor.get.call(frozenEl) : lastFrozenSt) : lastFrozenSt;
    if (frozenEl) releaseFreeze(frozenEl);
    frozenEl = el;
    paused = true;
    frozenHref = location.href;
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get() { return topAccessor.get.call(this); },
      set() {},
    });
    // scroll / scrollTo / scrollBy 也是站点滚到底的入口，一并挡住。
    el.scroll = () => {};
    el.scrollTo = () => {};
    el.scrollBy = () => {};
    const kept = restore && alignView(el);
    if (!kept) {
      if (restore) topAccessor.set.call(el, clampTop(el, prevSt));
      takeSamples(el);
    }
    lastFrozenSt = topAccessor.get.call(el);
    placeBottomBtn();
    if (!restore) toast('已暂停滚动');
    startPauseWatch();
  }

  function startPauseWatch() {
    if (pauseRaf) return;
    // 逐帧对齐：站点每把列表拉回底部一次，就在同一帧掰回来，看起来是钉住的。
    const tick = () => {
      if (!paused) { pauseRaf = 0; return; }
      pauseRaf = requestAnimationFrame(tick);
      if (location.href !== frozenHref) { unfreezeList(); return; }
      const el = frozenEl;
      if (!el || !el.isConnected) {
        const next = scroller && scroller.isConnected ? scroller : chatScroller();
        if (next) { scroller = next; freezeList(next, true); }
        return;
      }
      // 用户还在滚，按当前画面更新锚点，等停下来再钉住。
      if (Date.now() - lastUserInput < 400) {
        if (Date.now() - lastSampleAt > 200) {
          takeSamples(el);
          lastSampleAt = Date.now();
        }
        lastFrozenSt = topAccessor.get.call(el);
        return;
      }
      if (!alignView(el)) takeSamples(el);
      lastFrozenSt = topAccessor.get.call(el);
    };
    pauseRaf = requestAnimationFrame(tick);
  }

  function stopPauseWatch() {
    if (pauseRaf) cancelAnimationFrame(pauseRaf);
    pauseRaf = 0;
  }

  function unfreezeList() {
    paused = false;
    samples = [];
    stopPauseWatch();
    if (bottomBtn) bottomBtn.style.display = 'none';
    const el = frozenEl;
    frozenEl = null;
    if (el) releaseFreeze(el);
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

  // 从事件目标往上找真正在滚的聊天容器，页面换布局也不会失去绑定。
  function scrollableFrom(node) {
    let el = node instanceof Element ? node : node && node.parentElement;
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
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
      .find(el => el.querySelector(ITEM_SELECTOR) && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY));
    return list || scrollableFrom(document.querySelector(ITEM_SELECTOR));
  }

  function atBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  }

  function bindScroller() {
    const el = chatScroller();
    if (!el) return;
    scroller = el;
    // 列表节点被整块换掉时，接着冻新节点并尽量回到原画面。
    if (paused && (!frozenEl || !frozenEl.isConnected)) freezeList(el, true);
  }

  // 事件统一在 document 捕获阶段处理：抖音自己会拦滚轮事件，挂在列表上不保险。
  function onWheel(event) {
    const el = scrollerFor(event.target);
    if (!el) return;
    scroller = el;
    lastDir = Math.sign(event.deltaY);
    lastUserInput = Date.now();
    if (el.scrollHeight <= el.clientHeight + 4) return;
    // 在底部继续往下滚时恢复自动跟随，其余情况先冻住。
    if (event.deltaY > 0 && atBottom(el)) { if (paused) unfreezeList(); return; }
    if (frozenEl !== el) freezeList(el, false);
    else paused = true;
  }

  function onTouchMove(event) {
    const el = scrollerFor(event.target);
    if (!el) return;
    scroller = el;
    lastUserInput = Date.now();
    if (el.scrollHeight <= el.clientHeight + 4 || atBottom(el)) return;
    if (frozenEl !== el) freezeList(el, false);
  }

  function onPointerDown(event) {
    if (!(event.target instanceof Node)) return;
    pointerHeld = true;
    lastUserInput = Date.now();
    const el = scrollerFor(event.target);
    if (!el) return;
    scroller = el;
    if (event.target !== el) return;
    // 点在滚动条/列表空白处时目标是列表本身，说明用户在手动拖动。
    if (el.scrollHeight <= el.clientHeight + 4 || atBottom(el)) return;
    if (frozenEl !== el) freezeList(el, false);
  }

  function onPointerMove() {
    if (pointerHeld) lastUserInput = Date.now();
  }

  function onListScroll(event) {
    const el = event.target;
    if (!(el instanceof Element)) return;
    if (pointerHeld) lastUserInput = Date.now();
    // 从底部往上拖滚动条时 pointerdown 不会命中列表本身，这里补上冻结。
    if (pointerHeld && !paused && el === scroller &&
        el.scrollHeight > el.clientHeight + 4 && !atBottom(el)) {
      freezeList(el, false);
      return;
    }
    if (!paused || el !== frozenEl) return;
    if (!atBottom(el)) return;
    // 冻结期间站点写不进 scrollTop，滚到底只可能是用户自己在往下翻。
    if (pointerHeld || (lastDir > 0 && Date.now() - lastUserInput < 600)) unfreezeList();
  }

  function onKey(event) {
    if (!paused) return;
    if (/^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/.test(event.key)) lastUserInput = Date.now();
  }

  document.addEventListener('wheel', onWheel, { passive: true, capture: true });
  document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
  document.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true });
  document.addEventListener('pointermove', onPointerMove, { passive: true, capture: true });
  document.addEventListener('scroll', onListScroll, { passive: true, capture: true });
  document.addEventListener('keydown', onKey, { passive: true, capture: true });
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
    // 「回到底部」按钮常驻右下角，提示让到它上方，避免叠在一起。
    const btn = bottomBtn && bottomBtn.style.display !== 'none' ? bottomBtn.getBoundingClientRect() : null;
    toastEl.style.bottom = btn ? `${Math.round(innerHeight - btn.top + 8)}px` : '96px';
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
