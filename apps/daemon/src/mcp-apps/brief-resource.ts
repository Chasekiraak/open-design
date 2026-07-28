export const OPEN_DESIGN_BRIEF_APP_VERSION = 'v2' as const;

/**
 * Self-contained MCP Apps resource. It intentionally has no remote assets,
 * cookies, or browser persistence: the server-issued draft and immutable
 * confirmation are the only business truth.
 */
export const OPEN_DESIGN_BRIEF_APP_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>Choose the artifact direction</title>
    <style>
      :root { font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; background: transparent; color: CanvasText; }
      main { padding: 16px; }
      h1 { margin: 0 0 4px; font-size: 18px; }
      #description { margin: 0 0 16px; color: color-mix(in srgb, CanvasText 68%, transparent); }
      fieldset { margin: 0 0 16px; padding: 0; border: 0; }
      legend { margin-bottom: 8px; font-weight: 650; }
      .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 8px; }
      label { display: block; min-height: 72px; padding: 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 10px; cursor: pointer; }
      label:has(input:checked) { color: Canvas; background: CanvasText; border-color: CanvasText; }
      label:focus-within { outline: 2px solid Highlight; outline-offset: 2px; }
      input { position: absolute; opacity: 0; pointer-events: none; }
      strong, small { display: block; }
      small { margin-top: 3px; opacity: .72; }
      button { min-height: 40px; padding: 0 18px; border: 0; border-radius: 999px; color: Canvas; background: CanvasText; font: inherit; font-weight: 650; cursor: pointer; }
      button:disabled { opacity: .45; cursor: wait; }
      #status { min-height: 20px; margin-top: 10px; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <main hidden>
      <h1 id="title"></h1>
      <p id="description"></p>
      <form id="brief-form" aria-describedby="description" hidden>
        <div id="questions"></div>
        <button id="confirm" type="submit"></button>
      </form>
      <p id="status" role="status" aria-live="polite"></p>
      <template id="radio-template"><input type="radio"></template>
    </main>
    <script>
      (() => {
        "use strict";
        const form = document.getElementById("brief-form");
        const main = document.querySelector("main");
        const questions = document.getElementById("questions");
        const title = document.getElementById("title");
        const description = document.getElementById("description");
        const status = document.getElementById("status");
        const confirmButton = document.getElementById("confirm");
        const radioTemplate = document.getElementById("radio-template");
        const pending = new Map();
        let requestNumber = 0;
        let draft = null;
        let standardBridgeReady = false;
        let sizeFrame = 0;
        let lastWidth = -1;
        let lastHeight = -1;
        let hostLocale =
          window.openai && typeof window.openai.locale === "string"
            ? window.openai.locale
            : navigator.language;
        const COPY = {
          en: {
            ready: "Ready to confirm.",
            confirming: "Confirming…",
            confirmed: "Brief confirmed.",
            invalidConfirmation: "The host returned an invalid confirmation.",
            publishUnavailable: "The host cannot publish the confirmed brief.",
            contextFailed: "Could not update the host context.",
            confirmFailed: "Could not confirm the brief.",
            bridgeUnavailable: "The MCP Apps bridge is unavailable.",
          },
          "zh-CN": {
            ready: "可以确认了。",
            confirming: "正在确认…",
            confirmed: "需求已确认。",
            invalidConfirmation: "宿主返回了无效的确认结果。",
            publishUnavailable: "宿主无法发布已确认的需求。",
            contextFailed: "无法更新宿主上下文。",
            confirmFailed: "无法确认需求。",
            bridgeUnavailable: "MCP Apps 连接不可用。",
          },
          "zh-TW": {
            ready: "可以確認了。",
            confirming: "正在確認…",
            confirmed: "需求已確認。",
            invalidConfirmation: "宿主回傳了無效的確認結果。",
            publishUnavailable: "宿主無法發佈已確認的需求。",
            contextFailed: "無法更新宿主內容。",
            confirmFailed: "無法確認需求。",
            bridgeUnavailable: "MCP Apps 連線無法使用。",
          },
          ja: {
            ready: "確認できます。",
            confirming: "確認中…",
            confirmed: "ブリーフを確認しました。",
            invalidConfirmation: "ホストから無効な確認結果が返されました。",
            publishUnavailable: "ホストは確認済みブリーフを送信できません。",
            contextFailed: "ホストのコンテキストを更新できませんでした。",
            confirmFailed: "ブリーフを確認できませんでした。",
            bridgeUnavailable: "MCP Apps ブリッジを利用できません。",
          },
        };
        let parentOrigin = "";
        try {
          parentOrigin = document.referrer ? new URL(document.referrer).origin : "";
        } catch {
          parentOrigin = "";
        }

        function post(message) {
          window.parent.postMessage(message, parentOrigin || "*");
        }

        function request(method, params) {
          const id = "od-brief-" + (++requestNumber);
          post({ jsonrpc: "2.0", id, method, params });
          return new Promise((resolve, reject) => {
            const timer = window.setTimeout(() => {
              pending.delete(id);
              reject(new Error("The host did not answer the MCP Apps request."));
            }, 15000);
            pending.set(id, { resolve, reject, timer });
          });
        }

        function notify(method, params) {
          post({ jsonrpc: "2.0", method, params });
        }

        function localeOf(value) {
          const normalized = String(value || "").replaceAll("_", "-").toLowerCase();
          if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-hans")) return "zh-CN";
          if (normalized === "zh-tw" || normalized === "zh-hk" || normalized === "zh-mo" || normalized.startsWith("zh-hant")) return "zh-TW";
          if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
          return "en";
        }

        function effectiveLocale() {
          if (draft && draft.localeSource === "provided" && draft.locale) {
            return localeOf(draft.locale);
          }
          return localeOf(hostLocale || (draft && draft.locale));
        }

        function copy() {
          return COPY[effectiveLocale()];
        }

        function updateHostLocale(context) {
          if (context && typeof context.locale === "string") {
            hostLocale = context.locale;
            if (draft && draft.localeSource === "fallback") {
              render(draft);
            } else if (!draft) {
              document.documentElement.lang = effectiveLocale();
            }
          }
        }

        function publicErrorMessage(error, fallback) {
          if (error instanceof Error && Object.values(copy()).includes(error.message)) {
            return error.message;
          }
          return fallback;
        }

        function intrinsicSize() {
          const root = document.documentElement;
          const previousHeight = root.style.height;
          root.style.height = "max-content";
          const height = Math.ceil(root.getBoundingClientRect().height);
          root.style.height = previousHeight;
          return {
            width: Math.ceil(window.innerWidth),
            height,
          };
        }

        function scheduleSizeChanged() {
          if (sizeFrame) window.cancelAnimationFrame(sizeFrame);
          sizeFrame = window.requestAnimationFrame(() => {
            sizeFrame = 0;
            const { width, height } = intrinsicSize();
            if (width === lastWidth && height === lastHeight) return;
            lastWidth = width;
            lastHeight = height;
            if (standardBridgeReady) {
              notify("ui/notifications/size-changed", { width, height });
            }
            if (
              window.openai
              && typeof window.openai.notifyIntrinsicHeight === "function"
            ) {
              window.openai.notifyIntrinsicHeight(height);
            }
          });
        }

        function toolPayload(message) {
          const params = message && message.params;
          const result = params && (params.result || params);
          return result && (result.structuredContent || result);
        }

        function render(payload) {
          if (!payload || payload.view !== "brief-form" || !payload.briefDraftId) return;
          const previousAnswers =
            draft && draft.briefDraftId === payload.briefDraftId
              ? selections()
              : {};
          draft = payload;
          const locale = effectiveLocale();
          const localizedForms = payload.questionFormsByLocale;
          const questionForm =
            localizedForms && localizedForms[locale]
              ? localizedForms[locale]
              : payload.questionForm;
          document.documentElement.lang = locale;
          title.textContent = questionForm && questionForm.title
            ? questionForm.title
            : "";
          description.textContent = questionForm && questionForm.description
            ? questionForm.description
            : "";
          confirmButton.textContent = questionForm && questionForm.submitLabel
            ? questionForm.submitLabel
            : "";
          questions.replaceChildren();
          const items = questionForm && Array.isArray(questionForm.questions)
            ? questionForm.questions
            : [];
          for (const item of items) {
            const fieldset = document.createElement("fieldset");
            const legend = document.createElement("legend");
            legend.textContent = item.label;
            fieldset.append(legend);
            const choices = document.createElement("div");
            choices.className = "choices";
            for (const candidate of item.options || []) {
              const label = document.createElement("label");
              const input = radioTemplate.content.firstElementChild.cloneNode(true);
              input.name = item.id;
              input.value = candidate.value;
              input.required = true;
              const previousValue = Array.isArray(previousAnswers[item.id])
                ? previousAnswers[item.id][0]
                : "";
              input.checked = candidate.value === (previousValue || item.defaultValue);
              const name = document.createElement("strong");
              name.textContent = candidate.label;
              const detail = document.createElement("small");
              detail.textContent = candidate.description || "";
              label.append(input, name, detail);
              choices.append(label);
            }
            fieldset.append(choices);
            questions.append(fieldset);
          }
          main.hidden = false;
          form.hidden = false;
          status.textContent = items.length === 0 ? copy().ready : "";
          scheduleSizeChanged();
        }

        function selections() {
          const answers = {};
          if (!draft || !draft.questionForm) return answers;
          for (const item of draft.questionForm.questions || []) {
            const selected = form.elements.namedItem(item.id);
            const value = selected && selected.value;
            if (value) answers[item.id] = [value];
          }
          return answers;
        }

        async function callConfirm(argumentsValue) {
          if (!standardBridgeReady && window.openai && typeof window.openai.callTool === "function") {
            return window.openai.callTool("confirm_brief", argumentsValue);
          }
          return request("tools/call", { name: "confirm_brief", arguments: argumentsValue });
        }

        async function publishConfirmation(payload) {
          const activeLocale = effectiveLocale();
          const prompt = copy().confirmed + "\\n\\n" + payload.summary + "\\n\\n"
            + (activeLocale === "zh-CN"
              ? "请根据这份需求继续。"
              : activeLocale === "zh-TW"
                ? "請依照這份需求繼續。"
                : activeLocale === "ja"
                  ? "このブリーフに沿って続行してください。"
                  : "Continue with this brief.");
          if (standardBridgeReady) {
            await request("ui/update-model-context", {
              content: [{ type: "text", text: payload.summary }],
              structuredContent: payload,
            });
            await request("ui/message", {
              role: "user",
              content: [{ type: "text", text: prompt }],
            });
            return;
          }
          if (window.openai && typeof window.openai.sendFollowUpMessage === "function") {
            await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
            return;
          }
          throw new Error(copy().publishUnavailable);
        }

        form.addEventListener("change", () => {
          if (!draft) return;
          const context = {
            artifactType: draft.artifactType,
            answers: selections(),
          };
          if (!standardBridgeReady) {
            return;
          }
          void request("ui/update-model-context", {
            content: [{ type: "text", text: JSON.stringify(context) }],
          }).catch(() => {
            status.textContent = copy().contextFailed;
            scheduleSizeChanged();
          });
        });

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!draft || !form.reportValidity()) return;
          confirmButton.disabled = true;
          status.textContent = copy().confirming;
          scheduleSizeChanged();
          try {
            const result = await callConfirm({
              briefDraftId: draft.briefDraftId,
              nonce: draft.nonce,
              answers: selections(),
              locale: effectiveLocale(),
            });
            const payload = result && (result.structuredContent || (result.result && result.result.structuredContent) || result);
            if (!payload || !payload.briefConfirmationId) throw new Error(copy().invalidConfirmation);
            status.textContent = copy().confirmed;
            scheduleSizeChanged();
            await publishConfirmation(payload);
          } catch (error) {
            status.textContent = publicErrorMessage(error, copy().confirmFailed);
            confirmButton.disabled = false;
            scheduleSizeChanged();
          }
        });

        window.addEventListener("message", (event) => {
          if (event.source !== window.parent) return;
          if (parentOrigin && event.origin !== parentOrigin) return;
          const message = event.data;
          if (!message || message.jsonrpc !== "2.0") return;
          if (message.id && pending.has(message.id)) {
            const entry = pending.get(message.id);
            pending.delete(message.id);
            window.clearTimeout(entry.timer);
            if (message.error) entry.reject(new Error(message.error.message || "MCP Apps request failed."));
            else entry.resolve(message.result);
            return;
          }
          if (message.method === "ui/notifications/tool-result") render(toolPayload(message));
          if (message.method === "ui/notifications/host-context-changed") {
            updateHostLocale(message.params);
          }
        });

        if (window.openai && window.openai.toolOutput) {
          render(window.openai.toolOutput);
        }
        request("ui/initialize", {
          protocolVersion: "2026-01-26",
          appInfo: { name: "open-design-cloud-brief", version: "v2" },
          appCapabilities: {},
        }).then((result) => {
          standardBridgeReady = true;
          updateHostLocale(result && result.hostContext);
          notify("ui/notifications/initialized", {});
          render(toolPayload(result));
          scheduleSizeChanged();
        }).catch(() => {
          if (window.openai && window.openai.toolOutput) {
            render(window.openai.toolOutput);
            return;
          }
          main.hidden = false;
          status.textContent = copy().bridgeUnavailable;
          scheduleSizeChanged();
        });
        if (typeof ResizeObserver !== "undefined") {
          const observer = new ResizeObserver(scheduleSizeChanged);
          observer.observe(main);
        }
        window.addEventListener("resize", scheduleSizeChanged);
      })();
    </script>
  </body>
</html>`;
