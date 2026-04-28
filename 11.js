// 实现折叠、自定义标题等功能的 JS
// version 0.0.6
// 0.0.6 修复切换Callout类型后，刷新该笔记页又回到原Callout类型的问题；优化Asri主题下的切换菜单样式和交互体验，同样适配其他主题
// 0.0.5 优化代码，修复“空Callout回车键删除”操作潜在的模拟按键与 API 调用的竞态问题
// 0.0.4 修复Callout中无正文时的一些操作（修改标题、正文回车）会触发的bug，并优化“空Callout回车键删除”后的撤回操作
// 0.0.3 增加样式 Info、Quote、Question。但注意这几个新样式转换回官方callout后由于不存在对应类型，背景会变成白色
// 0.0.2 实现折叠/展开状态的持久化

(function () {
  "use strict";
  const DEBUG = false;
  const STARTUP_FLAG = "__calloutEnhanceInitialized";
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

  const deletingBlockIds = new Set();
  const deletedBlockIds = new Set();

  function placeCaretAtEnd(el) {
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function closestTitleFromTarget(target) {
    if (!target) return null;
    const element = target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
    return element?.closest?.('.callout-title') || null;
  }

  function hasCalloutBody(block) {
    function isMeaningfulNode(node) {
      if (!node) return false;

      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/[\u200B\u00A0]/g, "").trim().length > 0;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return false;

      const el = node;
      const tagName = el.tagName?.toUpperCase?.() || "";

      if (tagName === "BR") return false;
      if (el.classList?.contains("protyle-attr")) return false;

      // Non-text content nodes that should count as body.
      if (el.matches?.("img,video,audio,iframe,svg,canvas,table,hr,math,pre,code,input,button,select,textarea,embed,object")) {
        return true;
      }

      return Array.from(el.childNodes).some(isMeaningfulNode);
    }

    if (!block) return false;
    return Array.from(block.children).some((child) => {
      if (child.classList?.contains("callout-title")) return false;
      if (child.classList?.contains("callout-info")) return false;
      if (child.classList?.contains("protyle-attr")) return false;
      return isMeaningfulNode(child);
    });
  }

  function getSelectionCallout() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const node = sel.focusNode || sel.anchorNode;
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return element?.closest?.('.callout[data-type="NodeCallout"]') || null;
  }

  function getCalloutFromEventTarget(target) {
    if (!target) return null;
    const element = target.nodeType === Node.TEXT_NODE ? target.parentElement : target;
    return element?.closest?.('.callout[data-type="NodeCallout"]') || null;
  }

  function triggerBackspaceForEmptyCallout(block, sourceTarget) {
    if (!block) return false;

    const sourceEl = sourceTarget?.nodeType === Node.TEXT_NODE ? sourceTarget.parentElement : sourceTarget;
    const activeEl = document.activeElement;
    const activeEditable = activeEl?.isContentEditable ? activeEl : null;
    const sourceEditable = sourceEl?.closest?.('[contenteditable="true"]') || null;
    const target = sourceEditable || activeEditable || block.querySelector('[contenteditable="true"]');
    if (!target) return false;

    const keydownEvent = new KeyboardEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      keyCode: 8,
      which: 8,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(keydownEvent);

    const keyupEvent = new KeyboardEvent("keyup", {
      key: "Backspace",
      code: "Backspace",
      keyCode: 8,
      which: 8,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(keyupEvent);

    return true;
  }

  async function waitForNativeEmptyCalloutHandling(callout, timeout = 320) {
    if (!callout) return false;

    const isHandled = () => {
      if (!document.body.contains(callout)) return true;
      return hasCalloutBody(callout);
    };

    if (isHandled()) return true;

    return new Promise((resolve) => {
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };

      const observer = new MutationObserver(() => {
        if (isHandled()) finish(true);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      const timer = setTimeout(() => {
        finish(isHandled());
      }, timeout);
    });
  }


  async function deleteCallout(block) {
    if (!block?.dataset?.nodeId) return false;
    const blockId = block.dataset.nodeId;
    if (!document.body.contains(block)) return true;
    if (deletingBlockIds.has(blockId)) return true;

    deletingBlockIds.add(blockId);
    block.dataset.deleting = "true";

    try {
      const response = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: block.closest('.protyle')?.dataset.id || '',
          app: window.siyuan.config.system.id,
          transactions: [
            {
              doOperations: [
                {
                  action: 'delete',
                  id: blockId,
                },
              ],
            },
          ],
        }),
      });
      const result = await response.json();
      if (result.code === 0) {
        log('Empty callout deleted on Enter by transaction:', blockId);
        deletedBlockIds.add(blockId);
        deletingBlockIds.delete(blockId);
        setTimeout(() => deletedBlockIds.delete(blockId), 60 * 1000);
        return true;
      }
    } catch (error) {
      console.error('Delete fallback Error:', error);
    }

    deletingBlockIds.delete(blockId);
    delete block.dataset.deleting;
    return false;
  }

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
   * 通过官方 API 设置 Callout 的 subtype 属性（写入 IAL）
   * @param {string} blockId 
   * @param {string} subtype 
   */
  async function setCalloutSubtype(blockId, subtype) {
    if (!blockId || !subtype) return false;
    try {
      const response = await fetch("/api/attr/setBlockAttrs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: blockId,
          attrs: {
            "custom-type": subtype.toUpperCase()  // 存储为自定义属性
          }
        })
      });
      const result = await response.json();
      if (result.code === 0) {
        log(`Callout subtype saved to IAL: ${subtype}`);
        return true;
      } else {
        console.warn("setCalloutSubtype failed:", result.msg);
        return false;
      }
    } catch (err) {
      console.error("setCalloutSubtype error:", err);
      return false;
    }
  }

  /**
   * 同步块到思源后端（保持原函数，但现在折叠状态已分离）
   */
  async function syncBlock(blockElement) {
    if (!blockElement || !blockElement.dataset.nodeId) return;
    const blockId = blockElement.dataset.nodeId;
    if (deletedBlockIds.has(blockId)) return;
    if (deletingBlockIds.has(blockId)) return;
    if (blockElement.dataset.deleting === "true") return;
    if (!document.body.contains(blockElement)) return;
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
      this.element.style.cssText = "position:fixed; z-index:9999; min-width:160px; padding:6px; box-shadow: var(--b3-dialog-shadow);";
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
          <div class="b3-list-item__first" style="display:flex; align-items:center; gap:4px;">
            <span class="b3-list-item__graphic" style="width:20px; flex-shrink:0; text-align:center; font-size:16px; border:none; background:transparent;">${item.icon}</span>
            <span class="b3-list-item__text" style="font-size:15px;">${item.label}</span>
          </div>`;
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
      // 直接通过 IAL API 保存 subtype，而不是通过 syncBlock
      setCalloutSubtype(this.activeBlock.dataset.nodeId, newType);
      this.hide();
    },
  };

  function initCallout(block) {
    if (block.dataset.enhanced === "true") return;

    if (block.dataset?.nodeId) {
      deletedBlockIds.delete(block.dataset.nodeId);
      deletingBlockIds.delete(block.dataset.nodeId);
      delete block.dataset.deleting;
    }

    // 从 IAL 中读取并恢复 custom-type（subtype）
    const customType = block.getAttribute("custom-type");
    if (customType) {
      block.dataset.subtype = customType;
      log("Restored subtype from IAL:", customType);
    }

    const titleEl = block.querySelector(".callout-title");
    if (titleEl) {
      titleEl.contentEditable = "true";
      titleEl.spellcheck = false;
      titleEl.addEventListener("focus", () => {
        titleEl.classList.add("is-title-editing");
        placeCaretAtEnd(titleEl);
      });
      titleEl.addEventListener("blur", () => {
        titleEl.classList.remove("is-title-editing");
        if (block.dataset.deleting === "true") return;
        if (!hasCalloutBody(block)) return;
        syncBlock(block);
      });
      titleEl.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          if (!hasCalloutBody(block)) return;
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
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (document.activeElement !== titleEl) {
        titleEl.focus();
        placeCaretAtEnd(titleEl);
        log("Title Intercepted & Focused");
      }
    }
  }

  function startup() {
    if (window[STARTUP_FLAG]) return;
    window[STARTUP_FLAG] = true;

    const isUndoRedoShortcut = (e) => {
      if (!e || e.type !== "keydown") return false;
      const key = (e.key || "").toLowerCase();
      const withModifier = e.ctrlKey || e.metaKey;
      if (!withModifier) return false;
      // Win/Linux: Ctrl+Z undo, Ctrl+Y redo; macOS: Cmd+Z undo, Cmd+Shift+Z redo.
      return key === "z" || key === "y";
    };

    const guardTitleEvents = (e) => {
      const titleEl = closestTitleFromTarget(e.target);
      if (!titleEl) return;

      if (e.type === "keydown" && e.key === "Enter") {
        return;
      }

      if (isUndoRedoShortcut(e)) {
        return;
      }

      e.stopPropagation();
      e.stopImmediatePropagation();
    };

    const guardEmptyCalloutEnter = async (e) => {
      if (e.key !== "Enter") return;

      const callout =
        getCalloutFromEventTarget(e.target) ||
        getSelectionCallout();
      if (!callout) return;
      if (callout.dataset.deleting === "true") return;
      if (hasCalloutBody(callout)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const dispatched = triggerBackspaceForEmptyCallout(callout, e.target);
      const nativeHandled = dispatched
        ? await waitForNativeEmptyCalloutHandling(callout)
        : false;
      if (!nativeHandled && document.body.contains(callout)) {
        await deleteCallout(callout);
      }
      log('Global Enter rerouted to minimal Backspace flow for empty callout with delete fallback');
      return;
    };

    document.addEventListener("keydown", guardTitleEvents, true);
    document.addEventListener("beforeinput", guardTitleEvents, true);
    document.addEventListener("input", guardTitleEvents, true);
    document.addEventListener("compositionstart", guardTitleEvents, true);
    document.addEventListener("compositionupdate", guardTitleEvents, true);
    document.addEventListener("compositionend", guardTitleEvents, true);
    document.addEventListener("keydown", guardEmptyCalloutEnter, true);

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