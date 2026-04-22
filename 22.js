// version 0.0.3
// 0.0.3 限制补全菜单只能在引述块中触发，而非任意容器块；根据个人习惯，触发方式改为 [ 或 【；修改补全菜单的样式；增加样式 Info、Quote、Question
// 0.0.2 修复从 callout 块撤回到引述块会引发的 Block Not Found 的 BUG

(function () {
    'use strict';
    const DEBUG = true;
    function log(...args) { if (DEBUG) console.log('[CalloutCompletion]', ...args); }

    // 1. 修改这里：将 type 的值改为你希望显示的默认标题格式 (首字母大写)
    // 注意：原有的官方类型 (NOTE/TIP等) 建议保持全大写以确保最佳兼容性，
    // 但自定义类型 (Quote/Question) 可以按需修改。
    const CALLOUT_TYPES = [
        { type: 'Info', label: 'Info', icon: 'ℹ️' },
        { type: 'NOTE', label: 'Note', icon: '🖊️' },
        { type: 'IMPORTANT', label: 'Important', icon: '✨' },
        { type: 'Quote', label: 'Quote', icon: '❞' }, // 改为首字母大写
        { type: 'TIP', label: 'Tip', icon: '💡' },
        { type: 'WARNING', label: 'Warning', icon: '⚠️' },
        { type: 'CAUTION', label: 'Caution', icon: '🚨' },
        { type: 'Question', label: 'Question', icon: '❓' }, // 改为首字母大写
    ];

    let isComposing = false;

    // 判断是否在 blockquote 内
    function isInBlockquote(node) {
        if (!node) return false;
        let current = node;
        while (current && current !== document.body) {
            if (current.classList && current.classList.contains('bq')) {
                return true;
            }
            current = current.parentElement;
        }
        return false;
    }

    function applyTransform(selectedType) {
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        const textNode = range.startContainer;
        if (textNode.nodeType !== Node.TEXT_NODE) return;
        const content = textNode.textContent;
        const match = content.match(/[\[【]([a-zA-Z]*)$/i);
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
            this.currentProtyle = protyle;
            this.element = document.createElement('div');
            this.element.className = 'protyle-hint b3-list b3-list--background hint--menu fn__none';
            this.element.style.cssText = 'position:fixed; z-index:9999; min-width:160px; box-shadow: var(--b3-dialog-shadow);';
            protyle.appendChild(this.element);
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
                    <div class="b3-list-item__first" style="display:flex; align-items:center; gap:0px;">
                        <span class="b3-list-item__graphic" style="width:10px; flex-shrink:0; text-align:center;">${item.icon}</span>
                        <span class="b3-list-item__text">${item.label}</span>
                    </div>`;

                const graphic = btn.querySelector('.b3-list-item__graphic');
                graphic.style.border = 'none';
                graphic.style.background = 'transparent';
                graphic.style.fontSize = '15px';

                const text = btn.querySelector('.b3-list-item__text');
                text.style.fontSize = '15px';

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
                applyTransform(selected.type);
            }
        }
    };

    function handleInput() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const focusNode = sel.focusNode;
        if (focusNode?.nodeType !== Node.TEXT_NODE) return;

        if (!isInBlockquote(focusNode)) {
            menu.hide();
            return;
        }

        const text = focusNode.textContent;
        const cursorOffset = sel.focusOffset;
        const textBeforeCursor = text.substring(0, cursorOffset);
        const match = textBeforeCursor.match(/[\[【]([a-zA-Z]*)$/i);

        if (match) {
            const rect = sel.getRangeAt(0).getBoundingClientRect();
            const block = focusNode.parentElement?.closest('[data-node-id]');
            menu.show(match[1], rect, block || focusNode.parentElement);
        } else {
            if (menu.isVisible) menu.hide();
        }
    }

    function setupListeners() {
        document.body.addEventListener('input', (e) => {
            if (isComposing) return;
            handleInput();
        }, true);

        document.body.addEventListener('compositionstart', () => { isComposing = true; });
        document.body.addEventListener('compositionend', () => {
            isComposing = false;
            setTimeout(handleInput, 10);
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
                }
            }
        }, true);

        document.body.addEventListener('mousedown', (e) => {
            if (menu.element && !menu.element.contains(e.target)) menu.hide();
        });
    }

    log("Callout Completion - Simple Format [!Type]");
    setupListeners();
})();