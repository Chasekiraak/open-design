export const OPEN_DESIGN_BRIEF_APP_VERSION = 'v1' as const;

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
    <main>
      <h1 id="title">Ready for your brief</h1>
      <p id="description">Choose one option for each decision, then confirm.</p>
      <form id="brief-form" aria-describedby="description" hidden>
        <div id="questions"></div>
        <button id="confirm" type="submit">Confirm brief</button>
      </form>
      <p id="status" role="status" aria-live="polite">Waiting for the brief…</p>
      <template id="radio-template"><input type="radio"></template>
    </main>
    <script>
      (() => {
        "use strict";
        const form = document.getElementById("brief-form");
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

        function toolPayload(message) {
          const params = message && message.params;
          const result = params && (params.result || params);
          return result && (result.structuredContent || result);
        }

        function render(payload) {
          if (!payload || payload.view !== "brief-form" || !payload.briefDraftId) return;
          draft = payload;
          title.textContent = payload.questionForm && payload.questionForm.title
            ? payload.questionForm.title
            : "Choose the artifact direction";
          description.textContent = payload.questionForm && payload.questionForm.description
            ? payload.questionForm.description
            : "Choose one option for each decision, then confirm.";
          questions.replaceChildren();
          const items = payload.questionForm && Array.isArray(payload.questionForm.questions)
            ? payload.questionForm.questions
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
              input.checked = candidate.value === item.defaultValue;
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
          form.hidden = false;
          status.textContent = items.length === 0 ? "Ready to confirm." : "";
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
          const prompt = "Brief confirmed.\\n\\n" + payload.summary + "\\n\\nContinue with this brief.";
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
            if (typeof window.openai.setWidgetState === "function") {
              window.openai.setWidgetState({ briefConfirmation: payload });
            }
            await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
            return;
          }
          throw new Error("The host cannot publish the confirmed Brief.");
        }

        form.addEventListener("change", () => {
          if (!draft) return;
          const context = {
            artifactType: draft.artifactType,
            answers: selections(),
          };
          if (!standardBridgeReady) {
            if (window.openai && typeof window.openai.setWidgetState === "function") {
              window.openai.setWidgetState({ briefSelection: context });
            }
            return;
          }
          void request("ui/update-model-context", {
            content: [{ type: "text", text: JSON.stringify(context) }],
          }).catch((error) => {
            status.textContent = error instanceof Error ? error.message : "Could not update the host context.";
          });
        });

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!draft || !form.reportValidity()) return;
          confirmButton.disabled = true;
          status.textContent = "Confirming…";
          try {
            const result = await callConfirm({
              briefDraftId: draft.briefDraftId,
              nonce: draft.nonce,
              answers: selections(),
            });
            const payload = result && (result.structuredContent || (result.result && result.result.structuredContent) || result);
            if (!payload || !payload.briefConfirmationId) throw new Error("The host returned an invalid confirmation.");
            status.textContent = "Brief confirmed.";
            await publishConfirmation(payload);
          } catch (error) {
            status.textContent = error instanceof Error ? error.message : "Could not confirm the brief.";
            confirmButton.disabled = false;
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
        });

        if (window.openai && window.openai.toolOutput) {
          render(window.openai.toolOutput);
        }
        request("ui/initialize", {
          protocolVersion: "2026-01-26",
          appInfo: { name: "open-design-cloud-brief", version: "v1" },
          appCapabilities: {},
        }).then((result) => {
          standardBridgeReady = true;
          notify("ui/notifications/initialized", {});
          render(toolPayload(result));
        }).catch((error) => {
          if (window.openai && window.openai.toolOutput) {
            render(window.openai.toolOutput);
            return;
          }
          status.textContent = error instanceof Error ? error.message : "The MCP Apps bridge is unavailable.";
        });
      })();
    </script>
  </body>
</html>`;
