// 实现自动补全功能的 JS（可选）
// version 0.0.6
// 0.0.6 优化Asri主题下的补全菜单样式和交互体验，同样适配其他主题
// 0.0.5 优化代码，解决 DOM 节点泄漏、isInBlockquote 与 getBlockquoteElement 函数冗余、DOM 随着每次输入都遍历等问题
// 0.0.4 参考思源斜杠菜单，优化补全菜单触发逻辑，实现仅在引述块为空时输入[或【才触发、以及鼠标点击其他位置会使关闭菜单等特性；删除[或【关闭菜单
// 0.0.3 增加样式 Info、Quote、Question
// 0.0.2 修复从 callout 块撤回到引述块会引发的 Block Not Found 的 BUG；限制补全菜单只能在引述块中触发，而非任意容器块；根据个人习惯，触发方式改为[或【；修改补全菜单的样式；

(function() {
    'use strict';
    const DEBUG = true;
    function log(...args) { if (DEBUG) console.log('[CalloutCompletion]', ...args); }
    
    // 1. 修改这里：将 type 的值改为你希望显示的默认标题格式 (首字母大写)
    // 注意：原有的官方类型 (NOTE/TIP等) 建议保持全大写以确保最佳兼容性，
    // 但自定义类型 (Quote/Question) 可以按需修改。
    const CALLOUT_TYPES = [
        { type: 'Info',      label: 'Info',      icon: 'ℹ️' },
        { type: 'NOTE',      label: 'Note',      icon: '🖊️' },
        { type: 'IMPORTANT', label: 'Important', icon: '✨' },
        { type: 'Quote',     label: 'Quote',     icon: '❞' }, // 改为首字母大写
        { type: 'TIP',       label: 'Tip',       icon: '💡' },
        { type: 'WARNING',   label: 'Warning',   icon: '⚠️' },
        { type: 'CAUTION',   label: 'Caution',   icon: '🚨' },
        { type: 'Question',  label: 'Question',  icon: '❓' }, // 改为首字母大写
    ];
    const TRIGGER_PATTERN = /[\[【［]([a-zA-Z]*)$/i;
    const SESSION_TRIGGER_PATTERN = /^[\[【［]([a-zA-Z]*)$/i;

    function isTriggerChar(ch) {
        return ch === '[' || ch === '【' || ch === '［';
    }

    let isComposing = false;
    const triggerSession = {
        active: false,
        node: null,
        start: -1,
    };

    function resetTriggerSession() {
        triggerSession.active = false;
        triggerSession.node = null;
        triggerSession.start = -1;
    }

    function getBlockquoteElement(node) {
        if (!node) return null;
        let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        while (current && current !== document.body) {
            if (current.classList && current.classList.contains('bq')) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    function isQuoteEffectivelyEmptyForCompletion(quoteEl, focusNode, cursorOffset) {
        if (!quoteEl) return false;

        const triggerInfo = (() => {
            if (!focusNode || focusNode.nodeType !== Node.TEXT_NODE) return null;
            const text = focusNode.textContent || '';
            const textBeforeCursor = text.substring(0, cursorOffset);
            const match = textBeforeCursor.match(TRIGGER_PATTERN);
            if (!match) return null;
            return {
                start: textBeforeCursor.lastIndexOf(match[0]),
                end: cursorOffset,
                text: match[0],
            };
        })();

        let hasRealContent = false;

        const walk = (node) => {
            if (!node || hasRealContent) return;

            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent || '';
                const normalized = text.replace(/[\u200B\u00A0]/g, '').trim();
                if (!normalized) return;

                // The currently typed trigger sequence (e.g. "[" or "【abc") should not count as content.
                if (node === focusNode && triggerInfo) {
                    const beforeTrigger = text.slice(0, triggerInfo.start).replace(/[\u200B\u00A0]/g, '').trim();
                    const afterCursor = text.slice(triggerInfo.end).replace(/[\u200B\u00A0]/g, '').trim();
                    if (!beforeTrigger && !afterCursor) return;
                }

                hasRealContent = true;
                return;
            }

            if (node.nodeType !== Node.ELEMENT_NODE) return;

            const el = node;
            if (el.matches?.('img,video,audio,iframe,svg,canvas,table,hr,math,pre,code,input,button,select,textarea,embed,object,figure,figcaption,attachment-file,span[data-type],span[data-subtype]')) {
                hasRealContent = true;
                return;
            }

            for (const child of el.childNodes) {
                walk(child);
                if (hasRealContent) return;
            }
        };

        for (const child of quoteEl.childNodes) {
            walk(child);
            if (hasRealContent) return false;
        }

        return true;
    }

    function applyTransform(selectedType) {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        const textNode = range.startContainer;
        if (textNode.nodeType !== Node.TEXT_NODE) return;
        const content = textNode.textContent;
        const match = content.match(TRIGGER_PATTERN);
        if (!match) return;

        const startOffset = content.lastIndexOf(match[0]);
        
        // 2. 修改这里：去掉了 .toUpperCase()
        // 现在它会直接使用上面数组中定义的格式 (例如 "Citation")
        // 生成结果将是: [!Citation]
        const replacement = `[!${selectedType}]\n`;
        
        range.setStart(textNode, startOffset);
        range.setEnd(textNode, content.length);
        range.deleteContents();
        
        const newNode = document.createTextNode(replacement);
        range.insertNode(newNode);
        
        range.setStartAfter(newNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        // 模拟回车触发渲染
        const enterEvent = new KeyboardEvent('keydown', {
            key: 'Enter', keyCode: 13, code: 'Enter', which: 13,
            bubbles: true, cancelable: true
        });
        textNode.parentElement.dispatchEvent(enterEvent);
    }

    const menu = {
        element: null,
        currentProtyle: null,
        isVisible: false,
        filtered: [],
        index: -1,

        init(protyle) {
            if (this.element && this.currentProtyle === protyle) return;

            // Avoid leaking stale menu nodes when editor/protyle context changes.
            if (this.element && this.currentProtyle !== protyle) {
                this.element.remove();
                this.element = null;
            }

            this.currentProtyle = protyle;
            if (!this.element) {
                this.element = document.createElement('div');
                this.element.className = 'protyle-hint b3-list b3-list--background hint--menu fn__none';
                this.element.style.cssText = 'position:fixed; z-index:9999; min-width:160px; padding:6px; box-shadow: var(--b3-dialog-shadow);';
                protyle.appendChild(this.element);
            }
            this.hide();
        },

        show(filterText, rect, block) {
            const protyle = block.closest('.protyle');
            if (!protyle) return;
            this.init(protyle);
            this.filtered = CALLOUT_TYPES.filter(t => 
                t.type.toLowerCase().includes(filterText.toLowerCase()) ||
                t.label.toLowerCase().includes(filterText.toLowerCase())
            );
            if (this.filtered.length === 0) return this.hide();
            
            this.isVisible = true;
            this.index = 0;
            this.render();
            this.updatePosition(rect);
        },

        render() {
            this.element.innerHTML = '';
            this.filtered.forEach((item, i) => {
                const btn = document.createElement('button');
                btn.className = `b3-list-item b3-list-item--two ${i === this.index ? 'b3-list-item--focus' : ''}`;
                
                btn.innerHTML = `
                    <div class="b3-list-item__first" style="display:flex; align-items:center; gap:4px;">
                        <span class="b3-list-item__graphic" style="width:20px; flex-shrink:0; text-align:center; font-size:16px; border:none; background:transparent;">${item.icon}</span>
                        <span class="b3-list-item__text" style="font-size:15px;">${item.label}</span>
                    </div>`;

                btn.onmousedown = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.apply(i);
                };

                this.element.appendChild(btn);
            });
            this.element.classList.remove('fn__none');
            if (this.index === -1) this.index = 0;
        },

        updatePosition(rect) {
            let top = rect.bottom + 8;
            if (top + (this.element.offsetHeight || 200) > window.innerHeight) {
                top = rect.top - (this.element.offsetHeight || 200) - 8;
            }
            this.element.style.top = `${top}px`;
            this.element.style.left = `${rect.left}px`;
        },

        hide() {
            this.isVisible = false;
            this.index = -1;
            if (this.element) this.element.classList.add('fn__none');
        },

        apply(selectedIndex = this.index) {
            const selected = this.filtered[selectedIndex];
            if (selected) {
                this.hide();
                resetTriggerSession();
                applyTransform(selected.type);
            }
        }
    };

    function handleInput(e) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) {
            menu.hide();
            resetTriggerSession();
            return;
        }
        const focusNode = sel.focusNode;
        if (focusNode?.nodeType !== Node.TEXT_NODE) {
            menu.hide();
            resetTriggerSession();
            return;
        }
        
        const quoteEl = getBlockquoteElement(focusNode);
        if (!quoteEl) {
            menu.hide();
            resetTriggerSession();
            return;
        }

        const cursorOffset = sel.focusOffset;
        const text = focusNode.textContent || '';
        const textBeforeCursor = text.substring(0, cursorOffset);

        // If there is an active trigger session, only update/hide based on that session.
        if (triggerSession.active) {
            if (focusNode !== triggerSession.node || cursorOffset < triggerSession.start) {
                menu.hide();
                resetTriggerSession();
                return;
            }

            if (!isQuoteEffectivelyEmptyForCompletion(quoteEl, focusNode, cursorOffset)) {
                if (menu.isVisible) menu.hide();
                resetTriggerSession();
                return;
            }

            const segment = text.slice(triggerSession.start, cursorOffset);
            const sessionMatch = segment.match(SESSION_TRIGGER_PATTERN);
            if (!sessionMatch) {
                menu.hide();
                resetTriggerSession();
                return;
            }

            const rect = sel.getRangeAt(0).getBoundingClientRect();
            const block = focusNode.parentElement?.closest('[data-node-id]');
            menu.show(sessionMatch[1], rect, block || focusNode.parentElement);
            return;
        }

        // Open only when the current input event explicitly inserts trigger chars.
        const insertedText = e?.data || '';
        const lastChar = textBeforeCursor.slice(-1);
        const isInsertInput = typeof e?.inputType === 'string' && e.inputType.startsWith('insert');
        const isTriggerInput = isInsertInput && (
            isTriggerChar(insertedText) ||
            (isTriggerChar(lastChar) && (!insertedText || insertedText === lastChar))
        );
        if (!isTriggerInput) {
            if (menu.isVisible) menu.hide();
            return;
        }

        // Expensive deep traversal: only run when user just entered a trigger char.
        if (!isQuoteEffectivelyEmptyForCompletion(quoteEl, focusNode, cursorOffset)) {
            if (menu.isVisible) menu.hide();
            resetTriggerSession();
            return;
        }

        const match = textBeforeCursor.match(TRIGGER_PATTERN);

        if (match) {
            triggerSession.active = true;
            triggerSession.node = focusNode;
            triggerSession.start = textBeforeCursor.lastIndexOf(match[0]);
            const rect = sel.getRangeAt(0).getBoundingClientRect();
            const block = focusNode.parentElement?.closest('[data-node-id]');
            menu.show(match[1], rect, block || focusNode.parentElement);
        } else {
            if (menu.isVisible) menu.hide();
            resetTriggerSession();
        }
    }

    function setupListeners() {
        document.body.addEventListener('input', (e) => {
            if (isComposing) return;
            handleInput(e);
        }, true);

        document.body.addEventListener('compositionstart', () => { isComposing = true; });
        document.body.addEventListener('compositionend', () => { 
            isComposing = false; 
            // composition end can update an existing trigger session, but should not create a new one.
            setTimeout(() => handleInput(undefined), 10);
        });

        document.body.addEventListener('keydown', (e) => {
            if (menu.isVisible) {
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    menu.index = (menu.index - 1 + menu.filtered.length) % menu.filtered.length;
                    menu.render();
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    menu.index = (menu.index + 1) % menu.filtered.length;
                    menu.render();
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    menu.apply();
                } else if (e.key === 'Escape') {
                    menu.hide();
                    resetTriggerSession();
                }
            }
        }, true);

        document.body.addEventListener('mousedown', (e) => {
            if (menu.element && !menu.element.contains(e.target)) {
                menu.hide();
                resetTriggerSession();
            }
        });

        document.addEventListener('selectionchange', () => {
            if (!triggerSession.active) return;
            const sel = window.getSelection();
            if (!sel || !sel.rangeCount || sel.focusNode !== triggerSession.node) {
                menu.hide();
                resetTriggerSession();
            }
        }, true);
    }

    log("Callout Completion - Simple Format [!Type]");
    setupListeners();
})();