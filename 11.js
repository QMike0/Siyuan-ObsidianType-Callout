// version 0.0.3
// 0.0.3 增加样式Info、Quote、Question
// 0.0.2 实现折叠/展开状态的持久化

(function () {
  "use strict";
  const DEBUG = true;
  function log(...args) {
    if (DEBUG) console.log("[CalloutEnhance]", ...args);
  }

  // 修改了这里：增加了 Quote 和 Question
  const CALLOUT_TYPES = [
    { type: 'Info', label: 'Info', icon: 'ℹ️' },
    { type: "NOTE", label: "Note", icon: "🖊️" },
    { type: "IMPORTANT", label: "Important", icon: "✨" },
    { type: "Quote", label: "Quote", icon: "❞" },
    { type: "TIP", label: "Tip", icon: "💡" },
    { type: "WARNING", label: "Warning", icon: "⚠️" },
    { type: "CAUTION", label: "Caution", icon: "🚨" },
    { type: "Question", label: "Question", icon: "❓" },
  ];

  /**
   * 通过官方 API 设置块的 fold 属性（写入 IAL）
   * @param {string} blockId 
   * @param {boolean} fold 
   */
  async function setFoldState(blockId, fold) {
    if (!blockId) return false;
    try {
      const response = await fetch("/api/attr/setBlockAttrs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: blockId,
          attrs: {
            fold: fold ? "1" : "0"    // 思源识别 "1" 为折叠，"0" 或不存在为展开
          }
        })
      });
      const result = await response.json();
      if (result.code === 0) {
        log(`Fold state saved to IAL: ${fold ? "folded" : "expanded"}`);
        return true;
      } else {
        console.warn("setBlockAttrs failed:", result.msg);
        return false;
      }
    } catch (err) {
      console.error("setFoldState error:", err);
      return false;
    }
  }

  /**
   * 同步块到思源后端（保持原函数，但现在折叠状态已分离）
   */
  async function syncBlock(blockElement) {
    if (!blockElement || !blockElement.dataset.nodeId) return;
    const blockId = blockElement.dataset.nodeId;
    const protyle = blockElement.closest(".protyle");
    if (!protyle) return;

    // 克隆并清理临时状态
    const clone = blockElement.cloneNode(true);
    const titleInClone = clone.querySelector(".callout-title");
    if (titleInClone) {
      titleInClone.classList.remove("is-title-editing");
      titleInClone.removeAttribute("contenteditable");
    }
    clone.classList.remove("protyle-shown");
    clone.removeAttribute("data-enhanced");

    const payload = {
      session: protyle.dataset.id || "",
      app: window.siyuan.config.system.id,
      transactions: [
        {
          doOperations: [
            {
              action: "update",
              id: blockId,
              data: clone.outerHTML,
            },
          ],
        },
      ],
    };

    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        log("HTML Sync Success:", blockId);
      }
    } catch (e) {
      console.error("Sync Error:", e);
    }
  }

  const typePicker = {
    element: null,
    activeBlock: null,
    init() {
      if (this.element) return;
      this.element = document.createElement("div");
      this.element.className = "protyle-hint b3-list b3-list--background hint--menu fn__none";
      this.element.style.cssText = "position:fixed; z-index:9999; min-width:160px; box-shadow: var(--b3-dialog-shadow);";
      document.body.appendChild(this.element);
    },
    show(block, x, y) {
      this.init();
      this.activeBlock = block;
      this.element.innerHTML = "";
      CALLOUT_TYPES.forEach((item) => {
        const btn = document.createElement("button");
        btn.className = "b3-list-item b3-list-item--two";
        btn.innerHTML = `
          <div class="b3-list-item__first">
            <span class="b3-list-item__graphic">${item.icon}</span>
            <span class="b3-list-item__text">${item.label}</span>
          </div>`;
        const textEl = btn.querySelector('.b3-list-item__text');
        if (textEl) textEl.style.fontSize = '15px';
        const graphicEl = btn.querySelector('.b3-list-item__graphic');
        if (graphicEl) {
          graphicEl.style.border = 'none';
          graphicEl.style.background = 'transparent';
          graphicEl.style.fontSize = '15px';
        }
        btn.onclick = (e) => {
          e.stopPropagation();
          this.apply(item.type);
        };
        this.element.appendChild(btn);
      });
      this.element.style.top = `${y}px`;
      this.element.style.left = `${x}px`;
      this.element.classList.remove("fn__none");
    },
    hide() {
      if (this.element) this.element.classList.add("fn__none");
    },
    apply(newType) {
      if (!this.activeBlock) return;
      this.activeBlock.dataset.subtype = newType.toUpperCase();
      log("Type updated to:", newType);
      syncBlock(this.activeBlock);
      this.hide();
    },
  };

  function initCallout(block) {
    if (block.dataset.enhanced === "true") return;

    const titleEl = block.querySelector(".callout-title");
    if (titleEl) {
      titleEl.contentEditable = "true";
      titleEl.spellcheck = false;
      titleEl.addEventListener("focus", () => {
        titleEl.classList.add("is-title-editing");
      });
      titleEl.addEventListener("blur", () => {
        titleEl.classList.remove("is-title-editing");
        syncBlock(block);
      });
      titleEl.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const parentID = block.dataset.nodeId;
          if (block.getAttribute('fold') === '1') {
            await setFoldState(parentID, false);  // 展开后再插入
            block.removeAttribute('fold');
          }
          // 插入新块逻辑保持不变...
          try {
            const response = await fetch('/api/block/insertBlock', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                dataType: "markdown",
                data: "",
                parentID: parentID,
                previousID: ""
              })
            });
            const result = await response.json();
            if (result.code === 0 && result.data) {
              const newBlockId = result.data[0].doOperations[0].id;
              log('Insert Success. New ID:', newBlockId);
              setTimeout(() => {
                const newBlockEl = document.querySelector(`[data-node-id="${newBlockId}"] [contenteditable="true"]`);
                if (newBlockEl) {
                  newBlockEl.focus();
                  const range = document.createRange();
                  const sel = window.getSelection();
                  range.selectNodeContents(newBlockEl);
                  range.collapse(false);
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
              }, 200);
            }
          } catch (error) {
            console.error('Insert API Error:', error);
          }
        }
      });
    }

    block.dataset.enhanced = "true";
  }

  /**
   * 全局点击拦截器 - 折叠部分改用 API
   */
  function handleGlobalClick(e) {
    if (typePicker.element && !typePicker.element.contains(e.target)) {
      typePicker.hide();
    }

    const callout = e.target.closest('.callout[data-type="NodeCallout"]');
    if (!callout) return;

    const rect = callout.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const blockId = callout.dataset.nodeId;

    // 1. 点击 ::before (Icon区域) → 调出类型选择
    if (clickX >= 0 && clickX <= 40 && clickY <= 45) {
      log("Icon Clicked");
      e.preventDefault();
      e.stopPropagation();
      typePicker.show(callout, e.clientX, e.clientY);
      return;
    }

    // 2. 点击 ::after (折叠区域)
    if (clickX >= rect.width - 40 && clickY <= 45 && blockId) {
      log("Fold Clicked");
      e.preventDefault();
      e.stopPropagation();

      const isCurrentlyFolded = callout.getAttribute("fold") === "1";
      const nextFold = !isCurrentlyFolded;

      // 先改 DOM 让 UI 立即响应
      if (nextFold) {
        callout.setAttribute("fold", "1");
      } else {
        callout.removeAttribute("fold");
      }

      // 再异步保存到 IAL（失败不回滚 DOM，因为体验更重要）
      setFoldState(blockId, nextFold);
      return;
    }

    // 3. 点击 Title 区域
    const titleEl = e.target.closest(".callout-title");
    if (titleEl) {
      e.stopPropagation();
      if (document.activeElement !== titleEl) {
        titleEl.focus();
        log("Title Intercepted & Focused");
      }
    }
  }

  function startup() {
    document
      .querySelectorAll('.callout[data-type="NodeCallout"]')
      .forEach(initCallout);

    document.body.addEventListener("click", handleGlobalClick, true);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            if (node.classList.contains("callout")) initCallout(node);
            else node.querySelectorAll?.(".callout").forEach(initCallout);
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", startup);
  else startup();
})();