# 抖音直播弹幕 +1

抖音直播网页版聊天列表的 +1 脚本：鼠标停在某条弹幕上，把这条弹幕定格成固定位置的卡片，点卡片上的 +1 自动发送相同内容。

## 功能

- 悬停 150ms，弹幕定格为 `position: fixed` 卡片，不随聊天列表滚动
- 点 +1：清空输入框 → 写入内容 → 回车发送，没反应再点发送按钮
- 写入后检测被抖音截断（字数上限），截断时不自动发送，提示实际上限
- 卡片不接收鼠标事件，滚轮和点击穿透到聊天列表，只有 +1 按钮可点

## 安装

1. 安装 Tampermonkey 浏览器扩展
2. 新建脚本，粘贴下方源码并保存

## 使用

打开 `https://live.douyin.com/` 任意直播间并登录，鼠标停在聊天列表的弹幕上，点 +1。

## 已知限制

- 只识别普通弹幕；系统提示、进场、礼物消息没有 +1
- 抖音把弹幕表情渲染成没有文字替代的图片，脚本读不到具体表情，+1 内容不含表情
- 弹幕字数上限由抖音按账号/客户端控制，超限的弹幕不会自动发送
- 发送前会清空输入框里的原有内容

## 版本

1.0.2

## 许可证

MIT

## 源码

```js
// ==UserScript==
// @name         抖音直播弹幕 +1
// @namespace    https://github.com/hexiosr
// @version      1.0.2
// @description  在抖音直播聊天列表的每条弹幕旁加一个 +1，点击后发送相同内容
// @license      MIT
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
  const SEND_SELECTOR = ".webcast-chatroom___send-btn, [data-e2e='chat-send-btn']";
  const SYSTEM_TEXT = /^(来了|为主播点赞了|关注了主播|加入了直播间|分享了直播间|送出)/;
  const MAX_TEXT = 500;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function textOf(node) {
    let out = '';
    const walk = n => {
      if (n.nodeType === 3) { out += n.nodeValue || ''; return; }
      if (n.nodeType !== 1) return;
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

  const CARD_STYLE = {
    position: 'fixed', zIndex: '2147483000', boxSizing: 'border-box',
    display: 'none', alignItems: 'center', gap: '8px',
    padding: '4px 6px 4px 10px', borderRadius: '8px',
    background: '#15161d', border: '1px solid #3c3e4d',
    boxShadow: '0 6px 18px rgba(0,0,0,.5)',
    color: '#f5f6fa', font: '13px/1.4 system-ui,-apple-system,"Microsoft YaHei",sans-serif',
    // 卡片本体不吃鼠标，滚轮、点击都从卡片穿过去，只留 +1 按钮可点。
    pointerEvents: 'none',
  };

  let card = null;
  let cardText = '';
  let cardItem = null;
  let hideTimer = 0;
  let hoverTimer = 0;

  function ensureCard() {
    if (card?.isConnected) return card;
    card = document.createElement('div');
    card.className = 'dy-plus-one-card';
    Object.assign(card.style, CARD_STYLE);
    const label = document.createElement('span');
    label.className = 'dy-plus-one-card-text';
    Object.assign(label.style, {
      flex: '1', minWidth: '0', whiteSpace: 'normal', overflowWrap: 'anywhere',
    });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '+1';
    btn.title = '发送相同弹幕';
    btn.setAttribute('aria-label', '发送相同弹幕');
    Object.assign(btn.style, {
      flex: 'none', padding: '0 7px', border: '0', borderRadius: '10px',
      background: '#fe2c55', color: '#fff', cursor: 'pointer', pointerEvents: 'auto',
      font: '600 11px/20px system-ui,-apple-system,"Microsoft YaHei",sans-serif',
    });
    btn.addEventListener('pointerdown', event => event.stopPropagation());
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (cardText) sendPlusOne(cardText, btn);
    });
    card.append(label, btn);
    (document.fullscreenElement || document.documentElement).appendChild(card);
    return card;
  }

  // 把悬停的弹幕定格成一张 fixed 卡片，列表怎么滚它都不动，+1 一定点得到。
  function showCard(item) {
    const text = messageText(item);
    const rect = item.getBoundingClientRect();
    if (!text || !rect.width || !rect.height) return;
    const el = ensureCard();
    clearTimeout(hideTimer);
    cardText = text;
    cardItem = item;
    el.querySelector('.dy-plus-one-card-text').textContent = text;
    el.style.left = `${Math.max(0, rect.left - 2)}px`;
    el.style.top = `${Math.max(0, rect.top - 2)}px`;
    el.style.width = `${rect.width + 4}px`;
    el.style.minHeight = `${rect.height + 4}px`;
    el.style.display = 'flex';
    // 长弹幕换行后卡片会变高，掉出视口底部时整体上移。
    const height = el.getBoundingClientRect().height;
    if (rect.top - 2 + height > innerHeight - 6) {
      el.style.top = `${Math.max(6, innerHeight - 6 - height)}px`;
    }
  }

  function hideCardNow() {
    clearTimeout(hideTimer);
    if (card) card.style.display = 'none';
    cardItem = null;
    cardText = '';
  }

  function hideCardSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideCardNow, 150);
  }

  function cardShown() {
    return !!card && card.style.display === 'flex';
  }

  function pointerInCard(event) {
    if (!cardShown()) return false;
    const rect = card.getBoundingClientRect();
    return event.clientX >= rect.left - 8 && event.clientX <= rect.right + 8 &&
      event.clientY >= rect.top - 8 && event.clientY <= rect.bottom + 8;
  }

  document.addEventListener('mouseover', event => {
    clearTimeout(hoverTimer);
    // 鼠标还停在定格卡片上时，不从下面滚过的弹幕里再抓一条。
    if (pointerInCard(event)) return;
    const item = event.target instanceof Element ? event.target.closest(ITEM_SELECTOR) : null;
    if (!item || item === cardItem) return;
    // 停留 150ms 再定格，扫过聊天列表时不会到处闪卡片。
    hoverTimer = setTimeout(() => showCard(item), 150);
  });

  document.addEventListener('pointermove', event => {
    if (!cardShown()) return;
    if (pointerInCard(event)) { clearTimeout(hideTimer); return; }
    hideCardSoon();
  });

  // 滚轮直接穿到聊天列表，顺手收起卡片，滚动全程不被打断。
  document.addEventListener('wheel', () => {
    clearTimeout(hoverTimer);
    hideCardNow();
  }, { passive: true, capture: true });

  document.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    hideCardSoon();
  });

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
    const within = scope ? [...scope.querySelectorAll(SEND_SELECTOR)].find(isVisible) : null;
    if (within) return within;
    const global = [...document.querySelectorAll(SEND_SELECTOR)].find(isVisible);
    if (global) return global;
    return [...(scope || document).querySelectorAll('button, [role="button"]')]
      .find(el => isVisible(el) && /^发送$/.test((el.textContent || '').trim())) || null;
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
        position: 'fixed', left: '16px', bottom: '96px', zIndex: '2147483647',
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
    if (card) { card.remove(); card = null; }
    cardItem = null;
    cardText = '';
    if (toastEl) (document.fullscreenElement || document.documentElement).appendChild(toastEl);
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

  function pressEnter(editor) {
    const init = {
      key: 'Enter', code: 'Enter',
      bubbles: true, composed: true, cancelable: true,
    };
    editor.dispatchEvent(new KeyboardEvent('keydown', init));
    editor.dispatchEvent(new KeyboardEvent('keypress', init));
    editor.dispatchEvent(new KeyboardEvent('keyup', init));
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
      if (await waitCleared(1200)) { toast('已发送 +1'); return; }
      const send = findSend(editor);
      if (send && !unavailable(send)) {
        send.click();
        if (await waitCleared(1200)) { toast('已发送 +1'); return; }
      }
      toast('已填入内容，请手动发送');
    } finally {
      busy = false;
      chip.disabled = false;
      chip.textContent = '+1';
    }
  }
})();
```
