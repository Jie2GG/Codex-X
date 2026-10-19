import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
let components;
async function ui() {
  if (components) return components;
  components = (async () => {
    const scratch = await mkdtemp(join(desktop, "tests/.provider-editor-ui-"));
    try {
      const emitted = new Map();
      async function compile(sourcePath) {
        if (emitted.has(sourcePath)) return emitted.get(sourcePath);
        const outputPath = join(scratch, relative(desktop, sourcePath).replace(/\.tsx?$/, ".mjs"));
        emitted.set(sourcePath, outputPath);
        let output = ts.transpileModule(await readFile(sourcePath, "utf8"), {
          fileName: sourcePath,
          compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        }).outputText.replace(/import\s*["'][^"']+\.css["'];?/g, "");
        for (const match of [...output.matchAll(/\bfrom\s*["'](\.[^"']+)["']/g)]) {
          const specifier = match[1];
          const base = resolve(dirname(sourcePath), specifier);
          let dependency;
          for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
            try { await readFile(candidate, "utf8"); dependency = candidate; break; } catch { /* Normal TypeScript resolution candidates. */ }
          }
          assert.ok(dependency, `could not resolve ${specifier} from ${sourcePath}`);
          const dependencyOutput = await compile(dependency);
          let replacement = relative(dirname(outputPath), dependencyOutput).replaceAll("\\", "/");
          if (!replacement.startsWith(".")) replacement = `./${replacement}`;
          output = output.replaceAll(`"${specifier}"`, `"${replacement}"`).replaceAll(`'${specifier}'`, `'${replacement}'`);
        }
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, output);
        return outputPath;
      }
      const editor = await compile(join(desktop, "src/components/ProviderHeadersEditor.tsx"));
      const page = await compile(join(desktop, "src/pages/ProvidersPage.tsx"));
      return { ...await import(pathToFileURL(editor).href), ...await import(pathToFileURL(page).href) };
    } finally { await rm(scratch, { recursive: true, force: true }); }
  })();
  return components;
}

function render(Component, props) {
  // PageTransition uses a layout effect. SSR deliberately runs neither it nor
  // the HeadersControl effects; this checks presentation, not Tauri IPC.
  const warnings = [];
  const originalError = console.error;
  try {
    console.error = (...args) => warnings.push(args.join(" "));
    const html = renderToStaticMarkup(createElement(Component, props));
    for (const warning of warnings) assert.match(warning, /^Warning: useLayoutEffect does nothing on the server/);
    return html;
  } finally { console.error = originalError; }
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/\s([A-Za-z][\w:-]*)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
}
function elements(html, name) {
  const pattern = name === "input" ? /<input\b[^>]*>/g : new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?<\\/${name}>`, "g");
  return [...html.matchAll(pattern)].map(([tag]) => ({ tag, attrs: attributes(tag.slice(0, tag.indexOf(">") + 1)) }));
}
function control(html, name, label) {
  const found = elements(html, name).find((element) => element.attrs["aria-label"] === label);
  assert.ok(found, `${name} with accessible label ${label}`);
  return found;
}
function selectedOption(select) {
  const selected = elements(select.tag, "option").filter(({ attrs }) => "selected" in attrs);
  assert.equal(selected.length, 1, "a protocol/source selector must have one explicit selected option");
  return selected[0];
}
function protocolSelect(html) {
  const found = elements(html, "select").find(({ tag }) => elements(tag, "option").some(({ attrs }) => attrs.value === "responses"));
  assert.ok(found, "the actual provider form must include its upstream protocol selector");
  return found;
}
const noop = () => {};
const validRows = [
  { name: "X-Title", value: "Fixture Project", source: "static" },
  { name: "X-Project", value: "FIXTURE_PROJECT_NAME", source: "env" },
];
function formProps(lang, protocol = "responses", overrides = {}) {
  const text = (zh, en) => lang === "zh" ? zh : en;
  return {
    lang, mode: "form", creatingProvider: false, editingProviderId: "fixture-provider",
    selectedPresetId: "custom", selectedPresetVariantId: "custom",
    loading: false, fetchingModels: false, apiKeyVisible: false, availableModels: [],
    providerForm: { providerName: "Fixture provider", baseUrl: "https://fixture.example/v1", apiKey: "", model: "fixture-model", wireApi: "responses", upstreamApi: protocol, requiresOpenaiAuth: false, streamIdleTimeoutMs: null, streamMaxRetries: null },
    providerModelMappings: [], providerAuthPreview: "Fixture auth preview",
    providerTomlDraft: 'model_provider = "custom"\n[model_providers.custom]\nname = "Fixture provider"\nhttp_headers = { "X-Title" = "Fixture Project" }\n',
    providerTomlPreview: 'model_provider = "custom"\nmodel = "fixture-model"\n\n[mcp_servers.fixture]\ncommand = "fixture-server"\n\n[model_providers.custom]\nname = "Fixture provider"\nhttp_headers = { "X-Title" = "Fixture Project" }\n',
    copy: {
      formEyebrow: "Fixture", formAddTitle: text("新增供应商", "Add provider"), formEditTitle: text("编辑供应商", "Edit provider"),
      formHint: text("供应商配置", "Provider configuration"), cancelLabel: text("取消", "Cancel"),
      apiConfigTitle: "API", apiConfigDescription: text("接口设置", "API settings"), apiKeyLabel: "API Key", apiKeyPlaceholder: "Fixture API key",
      showApiKeyLabel: text("显示密钥", "Show API key"), hideApiKeyLabel: text("隐藏密钥", "Hide API key"), baseUrlLabel: "Base URL",
      nameLabel: text("供应商名称", "Provider name"), modelLabel: text("模型", "Model"), fetchModelsLabel: text("获取模型", "Fetch models"), fetchingModelsLabel: text("获取中", "Fetching"),
      requiresAuthLabel: text("使用 OpenAI 认证", "Use OpenAI authentication"), authPreviewTitle: text("认证预览", "Authentication preview"), authPreviewDescription: "Fixture preview",
      tomlTitle: "config.toml", tomlDescription: "Fixture TOML", copyTomlLabel: text("复制", "Copy"), saveLabel: text("保存供应商", "Save provider"), savingLabel: text("保存中", "Saving"),
    },
    onPresetSelect: noop, onPresetVariantSelect: noop, onProviderModelMappingsChange: noop, onCancelMode: noop,
    onApiKeyChange: noop, onBaseUrlChange: noop, onProviderNameChange: noop, onProviderModelChange: noop, onFetchModels: noop,
    onUpstreamApiChange: noop, onRequiresAuthChange: noop, onStreamIdleTimeoutChange: noop, onStreamMaxRetriesChange: noop, onToggleApiKeyVisibility: noop,
    onProviderTomlDraftChange: noop, onProviderHeadersConfigChange: noop, onCopyProviderToml: noop, onSaveProvider: noop,
    ...overrides,
  };
}

for (const lang of ["zh", "en"]) {
  const zh = lang === "zh";
  const rowLabel = (index) => zh ? `第 ${index + 1} 行` : `Row ${index + 1}`;
  const nameLabel = zh ? "名称" : "Name";
  const valueLabel = zh ? "值" : "Value";
  const sourceLabel = zh ? "值来源" : "Value source";
  const envLabel = zh ? "环境变量" : "Environment variable";

  test(`model discovery allows authentication headers without requiring an API key field (${lang})`, async () => {
    const { ProvidersPage } = await ui();
    const props = formProps(lang);
    const label = zh ? "获取模型" : "Fetch models";
    assert.equal(props.providerForm.apiKey, "");
    const html = render(ProvidersPage, props);
    assert.equal(control(html, "button", label).attrs.disabled, undefined);
    const missingUrl = render(ProvidersPage, { ...props, providerForm: { ...props.providerForm, baseUrl: "" } });
    assert.notEqual(control(missingUrl, "button", label).attrs.disabled, undefined);
  });

  test(`Headers editor renders literal and environment rows with accessible help (${lang})`, async () => {
    const { ProviderHeadersEditor } = await ui();
    const html = render(ProviderHeadersEditor, { lang, rows: validRows, onChange: noop });
    assert.ok(html.includes(`role="group" aria-label="${rowLabel(0)}"`));
    assert.ok(html.includes(`role="group" aria-label="${rowLabel(1)}"`));
    assert.equal(control(html, "input", `${nameLabel} · ${rowLabel(0)}`).attrs.value, "X-Title");
    assert.equal(control(html, "input", `${valueLabel} · ${rowLabel(0)}`).attrs.value, "Fixture Project");
    assert.equal(selectedOption(control(html, "select", `${sourceLabel} · ${rowLabel(0)}`)).attrs.value, "static");
    assert.equal(selectedOption(control(html, "select", `${sourceLabel} · ${rowLabel(1)}`)).attrs.value, "env");
    const env = control(html, "input", `${envLabel} · ${rowLabel(1)}`);
    assert.equal(env.attrs.value, "FIXTURE_PROJECT_NAME");
    assert.equal(env.attrs["aria-invalid"], "false");
    assert.ok(env.attrs["aria-describedby"]);
    const help = elements(html, "p").find(({ attrs }) => attrs.id === env.attrs["aria-describedby"]);
    assert.ok(help, "the environment input must reference existing help text");
    assert.ok(help.tag.includes(zh ? "环境变量模式只保存变量名" : "Environment mode saves only the variable name"));
    assert.ok(html.includes(zh ? "固定值" : "Literal value"));
    assert.ok(!html.includes('aria-invalid="true"'));
  });

  test(`Headers editor exposes row errors through aria-invalid and exact descriptions (${lang})`, async () => {
    const { ProviderHeadersEditor } = await ui();
    const rows = [
      { name: "bad name", value: "ok", source: "static" },
      { name: "X-Env", value: "2INVALID_ENV", source: "env" },
      { name: "X-Line", value: "one\ntwo", source: "static" },
      { name: "X-Source", value: "ok", source: "unknown" },
      { name: "X-Title", value: "one", source: "static" },
      { name: "x-title", value: "FIXTURE_TITLE", source: "env" },
    ];
    const html = render(ProviderHeadersEditor, { lang, rows, onChange: noop });
    const cases = [
      ["input", `${nameLabel} · ${rowLabel(0)}`, zh ? "名称只能使用" : "Use letters, numbers"],
      ["input", `${envLabel} · ${rowLabel(1)}`, zh ? "请填写环境变量名" : "Enter an environment variable name"],
      ["input", `${valueLabel} · ${rowLabel(2)}`, zh ? "不能包含换行或控制字符" : "cannot contain line breaks or control characters"],
      ["select", `${sourceLabel} · ${rowLabel(3)}`, zh ? "请选择固定值或环境变量" : "Choose a literal value or environment variable"],
      ["input", `${nameLabel} · ${rowLabel(4)}`, zh ? "此名称重复" : "Duplicate header name"],
      ["input", `${nameLabel} · ${rowLabel(5)}`, zh ? "此名称重复" : "Duplicate header name"],
    ];
    const errorIds = new Set();
    for (const [element, label, message] of cases) {
      const field = control(html, element, label);
      assert.equal(field.attrs["aria-invalid"], "true", label);
      const errorId = field.attrs["aria-describedby"];
      assert.ok(errorId, `error description for ${label}`);
      assert.ok(!errorIds.has(errorId), "each field must reference its own row error");
      errorIds.add(errorId);
      const error = elements(html, "small").find(({ attrs }) => attrs.id === errorId);
      assert.ok(error?.tag.includes(message), `specific visible error for ${label}`);
    }
    assert.ok(html.includes(zh ? "请先修正标红的 Headers" : "Correct the highlighted headers"));
    assert.equal(control(html, "input", `${valueLabel} · ${rowLabel(0)}`).attrs["aria-invalid"], "false", "a name error must not mark that row's valid value invalid");
  });

  test(`Headers editor offers explicit UA presets and header-specific examples (${lang})`, async () => {
    const { ProviderHeadersEditor } = await ui();
    const empty = render(ProviderHeadersEditor, { lang, rows: [], onChange: noop });
    const preset = control(empty, "select", zh ? "User-Agent 预设" : "User-Agent presets");
    assert.deepEqual(elements(preset.tag, "option").map(({ attrs }) => attrs.value), ["", "claude_code", "kilo_code"]);
    assert.ok(preset.tag.includes("claude-cli/2.1.161 (external, cli)"));
    assert.ok(preset.tag.includes("Kilo-Code/1.0"));
    assert.equal(elements(empty, "input").length, 0, "mounting must not create headers from presets");
    assert.ok(empty.includes(zh ? "其他请求头保留" : "keep other headers"));
    const names = ["User-Agent", "HTTP-Referer", "X-Title", "Authorization"];
    const html = render(ProviderHeadersEditor, { lang, rows: names.map((name) => ({ name, value: "", source: "static" })), onChange: noop });
    const placeholders = names.map((_, index) => control(html, "input", `${valueLabel} · ${rowLabel(index)}`).attrs.placeholder);
    assert.equal(new Set(placeholders).size, names.length);
    assert.ok(placeholders.every((placeholder) => !placeholder.includes("Codex-X")));
    assert.ok(placeholders[1].includes("https://your-app.example"));
    assert.ok(placeholders[3].includes("Bearer "));
  });

  test(`disabled Headers editor disables every row control (${lang})`, async () => {
    const { ProviderHeadersEditor } = await ui();
    const html = render(ProviderHeadersEditor, { lang, rows: validRows, disabled: true, onChange: noop });
    const controls = ["input", "select", "button"].flatMap((name) => elements(html, name));
    assert.equal(controls.length, 10);
    assert.ok(controls.every(({ attrs }) => "disabled" in attrs));
  });

  test(`provider form contains the real HeadersControl and all four API choices (${lang})`, async () => {
    const { ProvidersPage } = await ui();
    let configChanges = 0;
    const html = render(ProvidersPage, formProps(lang, "responses", { onProviderHeadersConfigChange() { configChanges += 1; } }));
    assert.ok(html.includes('class="cx-provider-headers-control"'));
    assert.ok(html.includes('class="cx-provider-headers"'));
    assert.ok(html.includes(zh ? "正在读取 Headers…" : "Reading headers…"));
    assert.ok(html.includes(zh ? "尚未配置自定义 Headers" : "No custom headers configured"), "SSR shows initial control state and does not run the TOML-read effect");
    assert.equal(configChanges, 0);
    const select = protocolSelect(html);
    assert.deepEqual(elements(select.tag, "option").map(({ attrs }) => attrs.value), ["responses", "chat_completions", "anthropic_messages", "gemini"]);
    for (const label of ["OpenAI Responses", "OpenAI Chat Completions", "Claude Messages", "Gemini generateContent"]) assert.ok(select.tag.includes(label));
    assert.equal(selectedOption(select).attrs.value, "responses");
    assert.ok(html.includes(zh ? "上游接口协议" : "Upstream API protocol"));
  });

  test(`converted APIs select their actual format and explain router lifetime (${lang})`, async () => {
    const { ProvidersPage } = await ui();
    for (const protocol of ["chat_completions", "anthropic_messages", "gemini"]) {
      const html = render(ProvidersPage, formProps(lang, protocol));
      assert.equal(selectedOption(protocolSelect(html)).attrs.value, protocol);
      const hint = elements(html, "p").find(({ attrs }) => attrs.class?.includes("cx-providers-protocol-hint"));
      assert.ok(hint, `routing explanation for ${protocol}`);
      for (const text of zh ? ["Codex 仍使用 Responses", "开启本地路由和配置接管", "保持 Codex-X 运行", "退出期间请求会暂停", "重开后自动恢复", "切回 Responses"] : ["Codex still uses Responses", "local router and config takeover", "keep Codex-X running", "before disabling the router", "resume after reopening"]) assert.ok(hint.tag.includes(text), text);
    }
  });

  test(`native Responses hides conversion guidance, while unknown APIs remain visibly unsupported (${lang})`, async () => {
    const { ProvidersPage } = await ui();
    for (const upstreamApi of [undefined, "responses"]) {
      const html = render(ProvidersPage, formProps(lang, upstreamApi, { providerForm: { ...formProps(lang).providerForm, upstreamApi } }));
      assert.equal(selectedOption(protocolSelect(html)).attrs.value, "responses");
      assert.ok(!html.includes("cx-providers-protocol-hint"));
    }
    for (const providerForm of [
      { ...formProps(lang).providerForm, upstreamApi: "fixture_unknown_api" },
      { ...formProps(lang).providerForm, upstreamApi: null, wireApi: "fixture_legacy_api" },
    ]) {
      const html = render(ProvidersPage, formProps(lang, "responses", { providerForm }));
      const chosen = selectedOption(protocolSelect(html));
      assert.equal(chosen.attrs.value, providerForm.upstreamApi || providerForm.wireApi);
      assert.ok("disabled" in chosen.attrs);
      assert.ok(chosen.tag.includes(zh ? "不支持的协议，请重新选择" : "Unsupported protocol"));
      assert.notEqual(chosen.attrs.value, "responses");
    }
    const legacyChat = render(ProvidersPage, formProps(lang, "responses", { providerForm: { ...formProps(lang).providerForm, upstreamApi: null, wireApi: "chat" } }));
    assert.equal(selectedOption(protocolSelect(legacyChat)).attrs.value, "chat_completions");
    assert.ok(legacyChat.includes("cx-providers-protocol-hint"));
  });

  test(`the config editor shows a read-only merged preview instead of an editable template (${lang})`, async () => {
    const { ProvidersPage } = await ui();
    const props = formProps(lang);
    assert.ok(!props.providerTomlDraft.includes("[mcp_servers."), "the editable template must stay provider-only");
    const html = render(ProvidersPage, props);
    const editor = control(html, "textarea", "config.toml");
    assert.ok(editor.tag.includes("readonly"), "the merged preview must not be hand-editable any more");
    assert.ok(editor.tag.includes("[mcp_servers.fixture]"), "the preview must show that Codex's own MCP server survives the switch");
    assert.ok(!html.includes(zh ? "重置 TOML" : "Reset TOML"), "resetting to a generated document would re-open the overwrite bug");

    const copyLabel = zh ? "复制" : "Copy";
    assert.equal(control(html, "button", copyLabel).attrs.disabled, undefined);
    const empty = render(ProvidersPage, { ...props, providerTomlPreview: "" });
    assert.notEqual(control(empty, "button", copyLabel).attrs.disabled, undefined);
  });

  test(`the API section runs name, URL, key, protocol, discovery, then auth (${lang})`, async () => {
    const { ProvidersPage } = await ui();
    const props = formProps(lang);
    const html = render(ProvidersPage, props);
    const start = html.indexOf("<h3>API</h3>");
    const end = html.indexOf('class="cx-provider-headers-control"');
    assert.ok(start >= 0 && end > start, "the API section must sit between the presets and the headers control");
    const section = html.slice(start, end);
    const fetchButton = control(section, "button", props.copy.fetchModelsLabel);
    const positions = [
      section.indexOf(`<span>${props.copy.nameLabel}</span>`),
      section.indexOf(`<span>${props.copy.baseUrlLabel}</span>`),
      section.indexOf(`<span>${props.copy.apiKeyLabel}</span>`),
      section.indexOf(zh ? "<span>上游接口协议</span>" : "<span>Upstream API protocol</span>"),
      section.indexOf(fetchButton.tag),
      section.indexOf(props.copy.requiresAuthLabel),
    ];
    positions.forEach((at, index) => assert.ok(at >= 0, `control ${index} belongs inside the API section`));
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok(positions[index - 1] < positions[index], `control ${index} must follow control ${index - 1}`);
    }
    assert.ok(
      section.includes('class="cx-providers-form-grid cx-providers-form-grid--single"'),
      "one readable column beats a three column grid for a six field form",
    );
    assert.ok(!section.includes("<datalist"), "the fetched list belongs to the mappings, not a second model input");
    assert.ok(!section.includes("cx-providers-model-select"), "the model picker moved into the mappings");
    assert.ok(!section.includes(`<span>${props.copy.modelLabel}</span>`), "the API section no longer owns a model field");
  });

  test(`the mapping rows own the default model through one radio group (${lang})`, async () => {
    const { ProvidersPage } = await ui();
    const rows = [
      { model: "gpt-5.5", displayName: "GPT 5.5", contextWindow: 128000, compactPercent: 75 },
      { model: "gpt-5.4", displayName: "GPT 5.4", contextWindow: null, compactPercent: null },
    ];
    const html = render(ProvidersPage, formProps(lang, "responses", {
      providerModelMappings: rows,
      providerForm: { ...formProps(lang).providerForm, model: "gpt-5.4" },
    }));
    const radios = elements(html, "input").filter(({ attrs }) => attrs.type === "radio");
    assert.equal(radios.length, rows.length, "every mapping row gets exactly one default marker");
    const checked = radios.filter(({ attrs }) => "checked" in attrs);
    assert.equal(checked.length, 1, "exactly one row may be the default model");
    assert.equal(checked[0].attrs["aria-label"], zh ? "设为默认模型 · gpt-5.4" : "Set the default model · gpt-5.4");
    assert.equal(new Set(radios.map(({ attrs }) => attrs.name)).size, 1, "the markers must share one radio group");
    assert.ok(radios.every(({ attrs }) => !("disabled" in attrs)), "a row with a model ID can always claim the default");
    assert.ok(html.includes(zh ? "设为默认模型 · gpt-5.5" : "Set the default model · gpt-5.5"), "the unchecked row still names its model");
    assert.ok(html.includes(zh ? "勾选的模型会写入 config.toml" : "The checked model becomes the model in config.toml"));

    const blank = render(ProvidersPage, formProps(lang, "responses", {
      providerModelMappings: [{ model: "", displayName: "", contextWindow: null, compactPercent: null }],
      providerForm: { ...formProps(lang).providerForm, model: "" },
    }));
    const [blankRadio] = elements(blank, "input").filter(({ attrs }) => attrs.type === "radio");
    assert.ok("disabled" in blankRadio.attrs, "a row without a model ID cannot become the default");
  });

  test(`each mapping row keeps its own compaction share (${lang})`, async () => {
    const { ProvidersPage } = await ui();
    const label = zh ? "压缩比例 % · 第 1 行" : "Compaction % · Row 1";
    const html = render(ProvidersPage, formProps(lang, "responses", {
      providerModelMappings: [
        { model: "gpt-5.5", displayName: "GPT 5.5", contextWindow: 128000, compactPercent: 75 },
        { model: "gpt-5.4", displayName: "GPT 5.4", contextWindow: null, compactPercent: null },
      ],
      providerForm: { ...formProps(lang).providerForm, model: "gpt-5.5" },
    }));
    assert.equal(control(html, "input", label).attrs.value, "75", "the share belongs to that row alone");
    assert.equal(control(html, "input", zh ? "压缩比例 % · 第 2 行" : "Compaction % · Row 2").attrs.value, "", "a blank share defers to Codex");
    assert.ok(html.includes(zh ? "切换模型时每个模型保留自己的窗口与比例" : "Each model keeps its own window and share when you switch"));

    const invalid = render(ProvidersPage, formProps(lang, "responses", {
      providerModelMappings: [{ model: "gpt-5.5", displayName: "GPT", contextWindow: 128000, compactPercent: 0 }],
      providerForm: { ...formProps(lang).providerForm, model: "gpt-5.5" },
    }));
    const bad = control(invalid, "input", label);
    assert.equal(bad.attrs["aria-invalid"], "true");
    const error = elements(invalid, "small").find(({ attrs }) => attrs.id === bad.attrs["aria-describedby"]);
    assert.ok(error?.tag.includes(zh ? "请填写 1 至 99 的整数" : "Enter a whole number from 1 to 99"));
    assert.ok(invalid.includes(zh ? "请先修正模型映射中的错误" : "Correct the model mapping errors before saving"), "an impossible share blocks the save");
  });

  test(`the advanced disclosure starts collapsed with both wait-timeout knobs empty (${lang})`, async () => {
    const { ProvidersPage } = await ui();
    const html = render(ProvidersPage, formProps(lang));
    const advanced = html.match(/<details class="cx-providers-advanced"[^>]*>/);
    assert.ok(advanced, "the API section ends with an advanced disclosure");
    assert.doesNotMatch(advanced[0], /\bopen\b/, "advanced settings stay collapsed until the user opens them");
    assert.ok(html.includes(zh ? "高级" : "Advanced"));
    const idle = control(html, "input", zh ? "等待超时时间（毫秒）" : "Wait timeout (ms)");
    const retries = control(html, "input", zh ? "等待超时重试次数" : "Wait timeout retries");
    assert.equal(idle.attrs.value, "", "an unset timeout keeps the Codex default");
    assert.equal(retries.attrs.value, "", "an unset retry count keeps the Codex default");
    assert.ok(idle.attrs.placeholder, "the timeout field explains that empty means the default");
    assert.ok(retries.attrs.placeholder, "the retry field explains that empty means the default");
    assert.ok(html.includes(zh ? "等待超时重试由 Codex-X 路由代管" : "wait-timeout retries are owned by the Codex-X router"),
      "takeover lifetime is disclosed next to the retry knob");
  });

  test(`out-of-range advanced values expand the disclosure and block the save (${lang})`, async () => {
    const { ProvidersPage, validateStreamSettings } = await ui();
    assert.deepEqual(validateStreamSettings({ streamIdleTimeoutMs: null, streamMaxRetries: null }), { valid: true, errors: {} });
    assert.equal(validateStreamSettings({ streamIdleTimeoutMs: 999 }).valid, false, "below the floor");
    assert.equal(validateStreamSettings({ streamIdleTimeoutMs: 600_001 }).valid, false, "above the ceiling");
    assert.equal(validateStreamSettings({ streamIdleTimeoutMs: 1234.5 }).valid, false, "fractional milliseconds");
    assert.equal(validateStreamSettings({ streamMaxRetries: 0 }).valid, true, "zero retries is a legal explicit choice");
    assert.equal(validateStreamSettings({ streamMaxRetries: 11 }).valid, false, "above the retry ceiling");

    const idleLabel = zh ? "等待超时时间（毫秒）" : "Wait timeout (ms)";
    const retriesLabel = zh ? "等待超时重试次数" : "Wait timeout retries";
    const filled = render(ProvidersPage, formProps(lang, "responses", {
      providerForm: { ...formProps(lang).providerForm, streamIdleTimeoutMs: 300000, streamMaxRetries: 5 },
    }));
    assert.equal(control(filled, "input", idleLabel).attrs.value, "300000");
    assert.equal(control(filled, "input", retriesLabel).attrs.value, "5");
    assert.ok(!filled.includes(zh ? "请先修正高级参数中的错误" : "Correct the advanced settings errors before saving"));
    const opened = filled.match(/<details class="cx-providers-advanced"[^>]*>/);
    assert.doesNotMatch(opened[0], /\bopen\b/, "valid values never force the disclosure open");

    const invalid = render(ProvidersPage, formProps(lang, "responses", {
      providerForm: { ...formProps(lang).providerForm, streamIdleTimeoutMs: 500, streamMaxRetries: 99 },
    }));
    assert.ok(invalid.includes(zh ? "请先修正高级参数中的错误" : "Correct the advanced settings errors before saving"));
    const forced = invalid.match(/<details class="cx-providers-advanced"[^>]*>/);
    assert.match(forced[0], /\bopen\b/, "a blocking error auto-expands the disclosure");
    const save = elements(invalid, "button").find(({ tag }) => tag.includes(zh ? "保存供应商" : "Save provider"));
    assert.ok(save, "the save button renders");
    assert.notEqual(save.attrs.disabled, undefined, "an impossible timeout disables the save button");
  });
}
