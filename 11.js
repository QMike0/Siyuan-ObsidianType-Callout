// 实现折叠、自定义标题等功能的 JS
// version 0.0.9
// 0.0.9 修复Callout标题修改持久化仍存在的手动失焦、嵌套callout标题保存等问题；优化callout标题回车操作、callout正文多空行时回车操作
// 0.0.8 修复Callout标题文字修改的持久化问题（无论有无Callout正文）；修复潜在的代码冗余和问题
// 0.0.7 实现切换菜单位置的智能调整；优化折叠/展开按钮判断逻辑，避免Asri主题下点击按钮进入标题编辑的情况;修复潜在问题
// 0.0.6 修复切换Callout类型后，刷新该笔记页又回到原Callout类型的问题；优化Asri主题下的切换菜单样式和交互体验，同样适配其他主题
// 0.0.5 优化代码，修复“空Callout回车键删除”操作潜在的模拟按键与 API 调用的竞态问题
// 0.0.4 修复Callout中无正文时的一些操作（修改标题、正文回车）会触发的bug，并优化“空Callout回车键删除”后的撤回操作
// 0.0.3 增加样式 Info、Quote、Question。但注意这几个新样式转换回官方callout后由于不存在对应类型，背景会变成白色
// 0.0.2 实现折叠/展开状态的持久化

(function () {
  "use strict";
  const DEBUG = true;
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
  // 追踪已经绑定事件监听器的标题元素（基于元素引用，能区分撤销恢复生成的新 DOM）
  const boundTitleEls = new WeakSet();

  function placeCaretAtEnd(el) {
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function ensureCalloutTitleEditable(titleEl) {
    if (!titleEl) return;
    titleEl.contentEditable = "true";
    titleEl.spellcheck = false;
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

  function getCalloutBodyLineCount(block) {
    if (!block) return 0;

    const content = block.querySelector?.(".callout-content") || block;
    return Array.from(content.children).filter((child) => {
      if (child.classList?.contains("protyle-attr")) return false;
      return true;
    }).length;
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

  // 初始化/绑定 callout（幂等）
  function initCallout(block) {
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
    if (!titleEl) {
      block.dataset.enhanced = "true";
      return;
    }

    // 如果这个具体的 title 元素还没有绑定过监听器，则绑定（基于元素引用的 WeakSet）
    if (!boundTitleEls.has(titleEl)) {
      try { delete titleEl.dataset.calloutTitleBound; } catch (e) {}
      ensureCalloutTitleEditable(titleEl);
      // 不在这里绑定 focus/blur/keydown，改为使用全局事件委托处理，避免 DOM 恢复时绑定丢失。
      boundTitleEls.add(titleEl);
    }

    block.dataset.enhanced = "true";
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
   * 同步块到思源后端 - 通过 DOM 更新方式
   */
  async function syncBlock(blockElement) {
    if (!blockElement || !blockElement.dataset.nodeId) {
      log("syncBlock: Missing blockElement or nodeId");
      return;
    }
    const blockId = blockElement.dataset.nodeId;
    if (deletedBlockIds.has(blockId)) {
      log("syncBlock: Block already deleted");
      return;
    }
    if (deletingBlockIds.has(blockId)) {
      log("syncBlock: Block is being deleted");
      return;
    }
    if (blockElement.dataset.deleting === "true") {
      log("syncBlock: Block marked as deleting");
      return;
    }
    if (!document.body.contains(blockElement)) {
      log("syncBlock: Block not in DOM");
      return;
    }
    const protyle = blockElement.closest(".protyle");
    if (!protyle) {
      log("syncBlock: No protyle found");
      return;
    }

    try {
      log(`syncBlock: Starting sync for ${blockId}`);
      
      // 方案 A: 尝试通过 updateBlock API（如果思源支持）
      // 或使用 setBlockMarkdown 更新块内容
      
      // 先尝试发送完整的 HTML 更新，但要保留块的所有必要属性
      const clone = blockElement.cloneNode(true);
      
      // 清理临时状态
      const titleInClone = clone.querySelector(".callout-title");
      if (titleInClone) {
        titleInClone.classList.remove("is-title-editing");
        titleInClone.removeAttribute("contenteditable");
        titleInClone.removeAttribute("data-callout-title-bound");
        titleInClone.spellcheck = false;
      }
      clone.classList.remove("protyle-shown");
      clone.removeAttribute("data-enhanced");
      
      // 记录要发送的 HTML
      const htmlToSend = clone.outerHTML;
      log(`syncBlock: Sending HTML (length: ${htmlToSend.length})`);

      const payload = {
        reqId: Date.now(),
        session: protyle.dataset.id || "",
        app: window.siyuan.config.system.id,
        transactions: [
          {
            doOperations: [
              {
                action: "update",
                id: blockId,
                data: htmlToSend,
              },
            ],
          },
        ],
      };

      log(`syncBlock: Posting transaction...`);
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await res.json();
      log(`syncBlock: Response code=${result.code}, msg=${result.msg}`);
      
      if (result.code === 0) {
        log(`✓ Block sync success: ${blockId}`);
        console.log("[CalloutEnhance] ✓ Title changes saved to database");
      } else {
        console.error("[CalloutEnhance] ✗ Sync failed:", result.msg);
        log(`✗ Block sync failed: ${result.msg}`);
        
        // 降级方案：如果 update 失败，尝试通过 IAL 属性保存（如果标题可以作为属性）
        // 但通常标题是内容，不能作为 IAL 属性，所以这里只是记录
      }
    } catch (e) {
      console.error("[CalloutEnhance] syncBlock exception:", e);
      log(`✗ syncBlock exception: ${e.message}`);
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
        btn.onclick = async (e) => {
          e.stopPropagation();
          await this.apply(item.type);
        };
        this.element.appendChild(btn);
      });
      this.element.classList.remove("fn__none");
      // 位置智能调整：确保菜单在视口内完整显示
      setTimeout(() => {
        const menuWidth = this.element.offsetWidth || 200;
        const menuHeight = this.element.offsetHeight || 300;
        const padding = 8;
        let top = y;
        let left = x;
        
        // 检查下边界
        if (top + menuHeight + padding > window.innerHeight) {
          top = Math.max(padding, window.innerHeight - menuHeight - padding);
        }
        // 检查上边界
        if (top < padding) {
          top = padding;
        }
        // 检查右边界
        if (left + menuWidth + padding > window.innerWidth) {
          left = Math.max(padding, window.innerWidth - menuWidth - padding);
        }
        // 检查左边界
        if (left < padding) {
          left = padding;
        }
        
        this.element.style.top = `${top}px`;
        this.element.style.left = `${left}px`;
      }, 0);
    },
    hide() {
      if (this.element) this.element.classList.add("fn__none");
    },
    async apply(newType) {
      if (!this.activeBlock) return;
      this.activeBlock.dataset.subtype = newType.toUpperCase();
      log("Type updated to:", newType);
      // 直接通过 IAL API 保存 subtype，而不是通过 syncBlock
      const saved = await setCalloutSubtype(this.activeBlock.dataset.nodeId, newType);
      if (!saved) {
        console.warn("Callout subtype save failed, keep menu open:", newType);
        return;
      }
      this.hide();
    },
  };

  // initCallout 已在文件上方以更健壮的方式实现（使用 WeakSet 跟踪已绑定的 title 元素）

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
      ensureCalloutTitleEditable(titleEl);
      if (document.activeElement !== titleEl) {
        titleEl.focus();
        placeCaretAtEnd(titleEl);
        log("Title Intercepted & Focused");
      }
    }
  }

  function handleGlobalPointerDown(e) {
    const callout = e.target.closest('.callout[data-type="NodeCallout"]');
    if (!callout) return;

    const rect = callout.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // 只要点在 icon / 折叠区域，就提前阻止默认焦点落到 title 上
    if ((clickX >= 0 && clickX <= 40 && clickY <= 45) || (clickX >= rect.width - 40 && clickY <= 45)) {
      e.preventDefault();
      e.stopPropagation();
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

    const handleUndoRedo = (e) => {
      if (!isUndoRedoShortcut(e)) return;
      // Ctrl+Z/Y 后，清除所有 callout 的 enhanced 标记，使其被重新初始化
      setTimeout(() => {
        document.querySelectorAll('.callout[data-type="NodeCallout"]').forEach((block) => {
          delete block.dataset.enhanced;
          const titleEl = block.querySelector(".callout-title");
          if (titleEl) {
            delete titleEl.dataset.calloutTitleBound;
          }
        });
        log("All callouts reset for undo/redo recovery");
      }, 50);
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

      // 如果事件来自标题，直接返回，让标题处理器优先处理
      if (closestTitleFromTarget(e.target)) return;

      const callout =
        getCalloutFromEventTarget(e.target) ||
        getSelectionCallout();
      if (!callout) return;
      if (callout.dataset.deleting === "true") return;
      // 多个空行时，保留思源原生 Enter 逻辑，避免破坏“非最后一行插入新块 / 最后一行移出 callout”的行为。
      // 只有一个空行时，仍然走删除分支，保持空 callout 的原有删除行为。
      if (getCalloutBodyLineCount(callout) > 1) return;
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

    // 全局委托：处理 title 的 focusin/focusout/keydown（避免单个元素绑定丢失）
    const handleTitleFocusIn = (e) => {
      const titleEl = closestTitleFromTarget(e.target);
      if (!titleEl) return;
      ensureCalloutTitleEditable(titleEl);
      titleEl.dataset.calloutTitleSnapshot = titleEl.textContent || "";
      titleEl.classList.add("is-title-editing");
    };

    const handleTitleFocusOut = (e) => {
      const titleEl = closestTitleFromTarget(e.target);
      if (!titleEl) return;
      const block = titleEl.closest('.callout');
      titleEl.classList.remove('is-title-editing');
      if (!block) return;
      if (block.dataset.deleting === 'true') return;
      const previousTitle = titleEl.dataset.calloutTitleSnapshot ?? "";
      const currentTitle = titleEl.textContent || "";
      if (currentTitle === previousTitle) return;
      requestAnimationFrame(() => syncBlock(block));
    };

    const handleTitleKeydown = (e) => {
      if (e.key !== 'Enter') return;
      const titleEl = closestTitleFromTarget(e.target);
      if (!titleEl) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const block = titleEl.closest('.callout');
      if (!block) return;
      const parentID = block.dataset.nodeId;
      (async () => {
        if (block.getAttribute('fold') === '1') {
          await setFoldState(parentID, false);
          block.removeAttribute('fold');
        }
        try {
          const response = await fetch('/api/block/insertBlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataType: 'markdown', data: '', parentID: parentID, previousID: '' })
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
        } catch (err) {
          console.error('Insert API Error:', err);
        }
      })();
    };

    document.addEventListener("keydown", handleUndoRedo, true);
    document.addEventListener("focusin", handleTitleFocusIn, true);
    document.addEventListener("focusout", handleTitleFocusOut, true);
    document.addEventListener("keydown", handleTitleKeydown, true);
    document.addEventListener("keydown", guardTitleEvents, true);
    document.addEventListener("beforeinput", guardTitleEvents, true);
    document.addEventListener("input", guardTitleEvents, true);
    document.addEventListener("compositionstart", guardTitleEvents, true);
    document.addEventListener("compositionupdate", guardTitleEvents, true);
    document.addEventListener("compositionend", guardTitleEvents, true);
    document.addEventListener("pointerdown", handleGlobalPointerDown, true);
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