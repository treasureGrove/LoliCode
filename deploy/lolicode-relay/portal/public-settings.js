// Credentials stay in this closure and form only; never persist them in web storage.
(() => {
  const byId = (id) => document.getElementById(id);
  const form = byId("settings-form");
  const publicFields = byId("settings-fields");
  const upstreamFields = byId("upstream-fields");
  const numericFields = {
    dailyRequests: "daily-requests",
    dailyTokens: "daily-tokens",
    globalDailyRequests: "global-daily-requests",
    globalDailyTokens: "global-daily-tokens",
    maxConcurrentPerAccount: "max-concurrent-per-account",
    maxConcurrentGlobal: "max-concurrent-global",
    globalRequestsPerMinute: "global-requests-per-minute",
    maxOutputTokens: "max-output-tokens",
    maxRequestBytes: "max-request-bytes",
  };
  const optionalNumbers = new Set([
    "globalDailyRequests",
    "globalDailyTokens",
    "maxConcurrentGlobal",
    "globalRequestsPerMinute",
  ]);
  const protocols = new Set([
    "openai_chat",
    "openai_responses",
    "anthropic",
    "gemini_native",
  ]);
  let accessToken = "",
    revision = null,
    selectedModels = new Set();
  let settingsLoading = false,
    settingsSaving = false,
    upstreamSaving = false,
    discovering = false;
  let settingsGeneration = 0,
    editVersion = 0,
    discoveryGeneration = 0;
  let discoveryController, discoveryTimer;
  let catalogModels = [],
    catalogSelection = new Set(),
    catalogFingerprint = "";
  let presets = [],
    commonIds = new Set(),
    presetExpanded = false,
    selectedPreset = null;
  let editingChannelId = null;
  let keyOrigin = "";
  let apiModelCount = 0;
  let knownChannels = [];

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function statusMessage(text, error = false) {
    byId("message").textContent = text;
    byId("message").classList.toggle("error", error);
  }
  function resultMessage(id, text, kind = "") {
    byId(id).textContent = text;
    byId(id).classList.toggle("error", kind === "error");
    byId(id).classList.toggle("success", kind === "success");
  }
  function credentials() {
    return {
      baseUrl: byId("upstream-url").value.trim(),
      apiKey: byId("upstream-key").value.trim(),
      protocol: byId("upstream-protocol").value,
      ...(selectedPreset ? { presetId: selectedPreset.id } : {}),
    };
  }
  const fingerprint = (value) =>
    JSON.stringify([value.baseUrl, value.apiKey, value.protocol]);
  const validSourceUrl = () => {
    try {
      const url = new URL(byId("upstream-url").value.trim());
      return (
        url.protocol === "https:" &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    } catch {
      return false;
    }
  };
  const hasCredentials = () =>
    Boolean(validSourceUrl() && byId("upstream-key").value.trim());
  function controls() {
    const authorized = Boolean(accessToken);
    // Loading public quotas must never lock the independent API connection form.
    upstreamFields.disabled = !authorized || upstreamSaving;
    publicFields.disabled = !authorized || revision === null || settingsSaving;
    byId("upstream-submit").disabled =
      !authorized ||
      upstreamSaving ||
      settingsSaving ||
      discovering ||
      !hasCredentials() ||
      !catalogSelection.size ||
      catalogFingerprint !== fingerprint(credentials());
    byId("discover-models").disabled =
      !authorized || upstreamSaving || discovering || !hasCredentials();
    byId("discover-models").textContent = discovering
      ? "正在获取…"
      : "获取模型";
    byId("upstream-submit").textContent = upstreamSaving
      ? "正在保存并测试…"
      : "保存并测试 ↗";
    byId("save").disabled =
      !authorized ||
      revision === null ||
      settingsSaving ||
      upstreamSaving ||
      settingsLoading;
    byId("save").textContent = settingsSaving
      ? "正在保存…"
      : byId("enabled").checked
        ? "保存并开放 ↗"
        : "保存设置 ↗";
    byId("reload").disabled =
      settingsLoading || settingsSaving || upstreamSaving;
    byId("load-retry").disabled =
      settingsLoading || settingsSaving || upstreamSaving;
    byId("upstream-select-all").disabled =
      upstreamSaving || !catalogModels.length;
    byId("upstream-select-none").disabled =
      upstreamSaving || !catalogSelection.size;
    byId("manual-model-add").disabled =
      !authorized || upstreamSaving || !hasCredentials();
  }
  function requireLogin() {
    accessToken = "";
    cancelDiscovery();
    byId("login-panel").hidden = false;
    statusMessage("管理员登录已失效或权限不足，请登录管理后台后返回。", true);
    controls();
  }
  function authFailure(error) {
    return (
      (error.status === 401 || error.status === 403) &&
      !String(error.code || "").startsWith("upstream_")
    );
  }
  async function jsonResponse(response) {
    try {
      return await response.json();
    } catch {
      throw new Error("服务器返回了无效资料，请稍后重试。");
    }
  }
  async function authenticate() {
    const response = await fetch("/api/user/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20000),
    });
    const result = await jsonResponse(response);
    if (
      !response.ok ||
      result.success !== true ||
      typeof result?.data?.access_token !== "string" ||
      !result.data.access_token
    ) {
      const error = new Error("请先登录管理后台。");
      error.status = 401;
      throw error;
    }
    accessToken = result.data.access_token;
    byId("login-panel").hidden = true;
    byId("upstream-panel").hidden = false;
    controls();
    scheduleDiscovery();
  }
  async function request(
    method,
    payload,
    path = "/admin-api/public-settings",
    signal,
  ) {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal:
        signal ||
        AbortSignal.timeout(path === "/admin-api/upstream" ? 180000 : 25000),
    });
    const result = await jsonResponse(response);
    if (!response.ok) {
      const error = new Error(
        response.status === 409 && result.error?.code === "settings_conflict"
          ? "设置已被其他页面更新。你的修改已保留，请重新读取设置后再保存。"
          : result.error?.message || "请求失败，请稍后重试。",
      );
      error.status = response.status;
      error.code = result.error?.code;
      throw error;
    }
    if (
      path === "/admin-api/public-settings" &&
      (!result.settings ||
        !Array.isArray(result.channels) ||
        !result.status ||
        !Number.isInteger(result.settings.revision))
    )
      throw new Error("公益设置资料不完整，请重新读取。");
    return result;
  }

  function presetOptions() {
    const query = byId("preset-search").value.trim().toLocaleLowerCase();
    const list = byId("preset-options");
    list.replaceChildren();
    const custom = node("button", "preset-option", "自定义 API");
    custom.type = "button";
    custom.setAttribute("aria-pressed", String(!selectedPreset));
    custom.addEventListener("click", () => choosePreset(null));
    list.append(custom);
    const visible = presets.filter((preset) =>
      query
        ? `${preset.name} ${preset.baseUrl}`.toLocaleLowerCase().includes(query)
        : presetExpanded || commonIds.has(preset.id),
    );
    for (const preset of visible) {
      const button = node("button", "preset-option", preset.name);
      button.type = "button";
      button.dataset.presetId = preset.id;
      button.setAttribute(
        "aria-pressed",
        String(selectedPreset?.id === preset.id),
      );
      button.disabled = !protocols.has(preset.protocol);
      if (button.disabled) {
        button.textContent += "（暂不支持）";
        button.title = "当前中转站暂不支持此协议";
      }
      button.addEventListener("click", () => choosePreset(preset));
      list.append(button);
    }
    if (query && !visible.length)
      list.append(
        node("p", "field-help", "没有匹配的服务商，可使用自定义 API。"),
      );
    byId("preset-more").hidden = Boolean(query) || !presets.length;
    byId("preset-more").textContent = presetExpanded
      ? "收起服务商"
      : "更多服务商";
    byId("preset-more").setAttribute("aria-expanded", String(presetExpanded));
  }
  function choosePreset(preset) {
    const previousUrl = byId("upstream-url").value.trim();
    selectedPreset = preset;
    editingChannelId = null;
    byId("cancel-upstream-edit").hidden = true;
    byId("upstream-title").textContent = "接入 API";
    byId("upstream-name").value = preset?.name || "";
    if (preset) {
      if (previousUrl && previousUrl !== preset.baseUrl)
        byId("upstream-key").value = "";
      byId("upstream-url").value = preset.baseUrl;
      byId("upstream-protocol").value = preset.protocol;
    }
    byId("selected-provider").textContent = preset?.name || "自定义 API";
    presetOptions();
    sourceChanged();
  }
  async function loadPresets() {
    try {
      const response = await fetch("/relay-assets/channel-presets.json", {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      const data = await jsonResponse(response);
      if (!response.ok || data.version !== 1 || !Array.isArray(data.presets))
        throw new Error("Invalid preset catalog");
      presets = data.presets.filter(
        (preset) =>
          typeof preset.id === "string" &&
          typeof preset.name === "string" &&
          typeof preset.baseUrl === "string",
      );
      commonIds = new Set(Array.isArray(data.commonIds) ? data.commonIds : []);
      if (!commonIds.size)
        commonIds = new Set(presets.slice(0, 8).map((preset) => preset.id));
      resultMessage(
        "preset-notice",
        `与本地渠道中心共用 ${presets.length} 个 API 服务预设。`,
      );
    } catch {
      resultMessage(
        "preset-notice",
        "服务商预设暂时无法读取，可直接填写自定义 API 地址和 Key。",
        "error",
      );
    }
    presetOptions();
    controls();
  }

  function cancelDiscovery() {
    ++discoveryGeneration;
    clearTimeout(discoveryTimer);
    discoveryTimer = undefined;
    discoveryController?.abort();
    discoveryController = undefined;
    discovering = false;
  }
  function clearCatalog() {
    catalogModels = [];
    apiModelCount = 0;
    catalogSelection = new Set();
    catalogFingerprint = "";
    byId("upstream-catalog").hidden = true;
    byId("upstream-model-options").replaceChildren();
    byId("upstream-model-search").value = "";
    byId("upstream-model-count").textContent = "0 个模型";
    byId("manual-model-input").value = "";
    byId("manual-models").open = false;
  }
  function sourceChanged(event) {
    const origin = validSourceUrl()
      ? new URL(byId("upstream-url").value.trim()).origin
      : "";
    if (event?.target?.id === "upstream-key") keyOrigin = origin;
    const changedHost =
      event?.target?.id === "upstream-url" &&
      keyOrigin &&
      origin &&
      keyOrigin !== origin;
    if (changedHost) {
      byId("upstream-key").value = "";
      keyOrigin = "";
    }
    cancelDiscovery();
    clearCatalog();
    resultMessage(
      "upstream-result",
      "勾选模型后保存并测试；测试会产生一次最小请求，提交后清空 Key。",
    );
    resultMessage(
      "discovery-result",
      byId("upstream-url").value.trim() && !validSourceUrl()
        ? "请填写有效的 HTTPS API 地址，例如 https://api.example.com/v1。"
        : hasCredentials()
          ? "正在等待获取模型…"
          : "选择预设，填入 Key 后自动获取模型；获取列表不会发起模型推理。",
      byId("upstream-url").value.trim() && !validSourceUrl() ? "error" : "",
    );
    controls();
    scheduleDiscovery();
    if (changedHost)
      resultMessage(
        "discovery-result",
        "API 地址已切换到其他站点，请重新填写该站点的 Key。",
      );
  }
  function scheduleDiscovery() {
    clearTimeout(discoveryTimer);
    if (!accessToken || upstreamSaving || !hasCredentials()) return;
    if (!keyOrigin)
      keyOrigin = new URL(byId("upstream-url").value.trim()).origin;
    discoveryTimer = setTimeout(() => {
      discoveryTimer = undefined;
      void discoverModels();
    }, 600);
  }
  function catalogMatches() {
    const query = byId("upstream-model-search")
      .value.trim()
      .toLocaleLowerCase();
    return catalogModels.filter((model) =>
      `${model.id} ${model.name || ""}`.toLocaleLowerCase().includes(query),
    );
  }
  function catalogChoices() {
    const list = byId("upstream-model-options");
    list.replaceChildren();
    const matching = catalogMatches();
    for (const model of matching) {
      const label = node("label", "catalog-model");
      const input = node("input");
      input.type = "checkbox";
      input.value = model.id;
      input.checked = catalogSelection.has(model.id);
      input.setAttribute("aria-label", model.name || model.id);
      input.addEventListener("change", () => {
        if (input.checked && catalogSelection.size >= 128) {
          input.checked = false;
          resultMessage(
            "discovery-result",
            "一次最多接入 128 个模型，请减少勾选。",
            "error",
          );
          return;
        }
        if (input.checked) catalogSelection.add(model.id);
        else catalogSelection.delete(model.id);
        catalogCount();
        controls();
      });
      const copy = node("span", "model-copy");
      copy.append(node("span", "model-name", model.name || model.id));
      if (model.name && model.name !== model.id)
        copy.append(node("span", "model-source", model.id));
      if (model.isManual)
        copy.append(node("span", "model-source", "手动填写，保存时测试"));
      label.append(input, copy);
      list.append(label);
    }
    if (!matching.length)
      list.append(node("p", "field-help", "没有匹配的模型。"));
    catalogCount();
  }
  function catalogCount() {
    byId("upstream-model-count").textContent =
      `${apiModelCount} 个 API 模型${catalogModels.some((model) => model.isManual) ? ` · ${catalogModels.filter((model) => model.isManual).length} 个手动` : ""} · 已选 ${catalogSelection.size}`;
  }
  async function discoverModels() {
    if (!accessToken || upstreamSaving || !hasCredentials()) return;
    cancelDiscovery();
    const current = discoveryGeneration;
    const source = credentials(),
      sourceFingerprint = fingerprint(source);
    const controller = new AbortController();
    discoveryController = controller;
    const timeout = setTimeout(() => controller.abort(), 45000);
    discovering = true;
    controls();
    resultMessage(
      "discovery-result",
      "正在从 API 获取模型列表，不会发起模型推理…",
    );
    try {
      const data = await request(
        "POST",
        source,
        "/admin-api/upstream/models",
        controller.signal,
      );
      if (
        current !== discoveryGeneration ||
        sourceFingerprint !== fingerprint(credentials())
      )
        return;
      if (!Array.isArray(data.models) || data.protocol !== source.protocol)
        throw new Error("模型目录或协议资料无效，请检查 API 地址和协议。");
      const ids = new Set();
      const manualModels = catalogModels.filter((model) => model.isManual);
      catalogModels = data.models.filter(
        (model) =>
          typeof model.id === "string" &&
          model.id &&
          !ids.has(model.id) &&
          ids.add(model.id),
      );
      apiModelCount = catalogModels.length;
      catalogModels.push(...manualModels.filter((model) => !ids.has(model.id)));
      catalogFingerprint = sourceFingerprint;
      catalogSelection = new Set(
        [...catalogSelection].filter((id) =>
          catalogModels.some((model) => model.id === id),
        ),
      );
      byId("upstream-catalog").hidden = !catalogModels.length;
      byId("upstream-catalog").open = true;
      catalogChoices();
      resultMessage(
        "discovery-result",
        catalogModels.length
          ? `已从 API 获取 ${apiModelCount} 个模型，请勾选需要接入的模型（最多 128 个）。${source.protocol === "openai_responses" ? "公益入口会测试此服务的 Chat 兼容性；仅支持 Responses 的服务可能无法通过测试。" : ""}`
          : "API 返回的模型列表为空，请检查权限或换用正确的模型地址。",
        catalogModels.length ? "success" : "error",
      );
    } catch (error) {
      if (
        current !== discoveryGeneration ||
        sourceFingerprint !== fingerprint(credentials())
      )
        return;
      if (authFailure(error)) requireLogin();
      byId("manual-models").open = true;
      resultMessage(
        "discovery-result",
        error.name === "AbortError"
          ? "获取模型超时，请检查地址后手动重试。"
          : error.message || "无法获取模型，请检查地址、Key 和协议。",
        "error",
      );
    } finally {
      clearTimeout(timeout);
      if (current === discoveryGeneration) {
        discovering = false;
        discoveryController = undefined;
        controls();
      }
    }
  }

  function availability() {
    const until = byId("mode-until").checked;
    byId("deadline-field").hidden = !until;
    byId("available-until").required = until;
    byId("enabled-label").textContent = byId("enabled").checked
      ? "保存后开放"
      : "保存后关闭";
    controls();
  }
  function modelChoices(channels) {
    const models = new Map();
    for (const channel of channels) {
      if (channel.enabled !== true) continue;
      for (const model of channel.models || []) {
        if (typeof model.id !== "string") continue;
        const previous = models.get(model.id);
        if (previous) previous.channels.push(channel.name);
        else
          models.set(model.id, {
            ...model,
            channels: [channel.name],
            available: true,
          });
      }
    }
    for (const id of selectedModels)
      if (!models.has(id))
        models.set(id, { id, name: id, channels: [], available: false });
    const list = byId("model-options");
    list.replaceChildren();
    if (!models.size)
      list.append(
        node(
          "p",
          "empty-models",
          "还没有可开放的模型。先在上方接入 API 并完成测试。",
        ),
      );
    for (const model of models.values()) {
      const label = node(
        "label",
        `model-choice${model.available ? "" : " unavailable"}`,
      );
      const input = node("input");
      input.type = "checkbox";
      input.value = model.id;
      input.checked = selectedModels.has(model.id);
      input.setAttribute("aria-label", `${model.name || model.id} · free`);
      input.addEventListener("change", () => {
        if (
          input.checked &&
          !selectedModels.has(model.id) &&
          selectedModels.size >= 128
        ) {
          input.checked = false;
          resultMessage(
            "save-result",
            "公益模型最多开放 128 个，请先取消其他选择。",
            "error",
          );
          return;
        }
        if (input.checked) selectedModels.add(model.id);
        else selectedModels.delete(model.id);
        if (!model.available && !input.checked) input.disabled = true;
        byId("model-count").textContent = `${selectedModels.size} 个已选`;
      });
      const copy = node("span", "model-copy");
      copy.append(
        node("span", "model-name", model.name || model.id),
        node(
          "span",
          "model-source",
          model.available
            ? `${model.channels.join(" / ")}${model.name && model.name !== model.id ? ` · ${model.id}` : ""}`
            : "原配置中的模型，当前渠道不可用；可取消选择。",
        ),
      );
      label.append(input, copy, node("span", "free-badge", "free"));
      list.append(label);
    }
    byId("model-count").textContent = `${selectedModels.size} 个已选`;
  }
  function savedChannels(channels) {
    knownChannels = channels;
    const list = byId("saved-channels");
    list.replaceChildren();
    byId("saved-channels-panel").hidden = !channels.length;
    for (const channel of channels) {
      const row = node("div", "saved-channel");
      const copy = node("div", "model-copy");
      copy.append(node("strong", "model-name", channel.name));
      copy.append(
        node(
          "span",
          "model-source",
          `${channel.baseUrl || "高级管理中维护地址"} · ${channel.models?.length || 0} 个模型`,
        ),
      );
      const edit = node(
        "button",
        "button secondary",
        channel.managed === true ? "编辑" : "复制接入",
      );
      edit.type = "button";
      edit.disabled = !channel.baseUrl || !protocols.has(channel.protocol);
      if (edit.disabled)
        edit.title = "此渠道的地址或协议暂不能在简易后台编辑，请使用高级管理";
      edit.addEventListener("click", () => {
        editingChannelId = channel.managed === true ? channel.id : null;
        selectedPreset =
          presets.find((preset) => preset.id === channel.presetId) || null;
        byId("upstream-title").textContent =
          editingChannelId !== null ? "编辑 API 渠道" : "复制接入 API";
        byId("cancel-upstream-edit").hidden = false;
        byId("upstream-name").value = channel.name;
        byId("upstream-url").value = channel.baseUrl;
        byId("upstream-protocol").value = channel.protocol;
        byId("upstream-key").value = "";
        byId("selected-provider").textContent =
          selectedPreset?.name || "自定义 API";
        presetOptions();
        sourceChanged();
        resultMessage(
          "upstream-result",
          editingChannelId !== null
            ? "更新时请重新填写 Key，再获取并勾选模型；不会回显已保存的 Key。"
            : "原渠道保持不变；请重新填写 Key 后复制为新渠道。",
        );
        upstreamFields.scrollIntoView?.({ block: "start" });
        byId("upstream-key").focus();
      });
      row.append(copy, edit);
      list.append(row);
    }
  }
  function render(data) {
    const settings = data.settings;
    revision = settings.revision;
    savedChannels(data.channels);
    byId("enabled").checked = settings.enabled;
    byId("mode-until").checked = settings.availabilityMode === "until";
    byId("mode-permanent").checked = settings.availabilityMode !== "until";
    const deadline = settings.availableUntil
      ? new Date(settings.availableUntil)
      : null;
    byId("available-until").value =
      deadline && !Number.isNaN(deadline.getTime())
        ? new Date(deadline.getTime() - deadline.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : "";
    for (const [key, id] of Object.entries(numericFields))
      byId(id).value = settings[key] ?? "";
    selectedModels = new Set(settings.modelIds);
    modelChoices(data.channels);
    availability();
    byId("enabled-label").textContent = settings.enabled
      ? "公益模型已开启"
      : "公益模型已关闭";
    const state = data.status.expired
      ? "expired"
      : data.status.ready
        ? "open"
        : "closed";
    byId("service-state").dataset.state = state;
    byId("service-state-text").textContent =
      state === "expired"
        ? "已到期"
        : state === "open"
          ? `已开放 · ${data.status.modelCount} 个模型`
          : "已关闭";
    form.hidden = false;
    byId("save-note").textContent = "设置保存后立即生效。";
  }
  async function load() {
    if (settingsLoading || settingsSaving || upstreamSaving) return;
    const current = ++settingsGeneration,
      edits = editVersion;
    settingsLoading = true;
    controls();
    resultMessage("save-result", "");
    statusMessage("正在读取公益设置…");
    byId("load-retry").hidden = true;
    try {
      await authenticate();
      const data = await request("GET");
      if (current !== settingsGeneration) return;
      if (edits !== editVersion) {
        statusMessage("已保留你的修改，未用服务器结果覆盖输入。");
        byId("load-retry").hidden = false;
        return;
      }
      render(data);
      statusMessage("");
    } catch (error) {
      if (current !== settingsGeneration) return;
      if (!accessToken || authFailure(error)) requireLogin();
      else
        statusMessage(
          error.message || "公益设置读取失败，上方仍可接入 API。",
          true,
        );
      byId("load-retry").hidden = false;
    } finally {
      if (current === settingsGeneration) {
        settingsLoading = false;
        controls();
      }
    }
  }
  function collect() {
    if (selectedModels.size > 128)
      throw new Error("公益模型最多开放 128 个，请减少勾选。");
    const until = byId("mode-until").checked,
      date = until ? new Date(byId("available-until").value) : null;
    if (
      until &&
      (!date || Number.isNaN(date.getTime()) || date.getTime() <= Date.now())
    )
      throw new Error("请选择未来的截止时间，或改为长期开放。");
    if (byId("enabled").checked && !selectedModels.size)
      throw new Error("请至少选择一个公益模型后再开放。");
    const settings = {
      revision,
      enabled: byId("enabled").checked,
      availabilityMode: until ? "until" : "permanent",
      availableUntil: until ? date.toISOString() : null,
      modelIds: [...selectedModels],
    };
    for (const [key, id] of Object.entries(numericFields)) {
      const value = byId(id).value.trim();
      if (!value && optionalNumbers.has(key)) settings[key] = null;
      else if (
        !value ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1
      )
        throw new Error("额度和请求限制请填写大于零的整数。");
      else settings[key] = Number(value);
    }
    return settings;
  }

  byId("cancel-upstream-edit").addEventListener("click", () => {
    choosePreset(null);
    byId("upstream-url").value = "";
    byId("upstream-key").value = "";
    byId("upstream-protocol").value = "openai_chat";
    sourceChanged();
  });
  byId("preset-search").addEventListener("input", presetOptions);
  byId("preset-more").addEventListener("click", () => {
    presetExpanded = !presetExpanded;
    presetOptions();
  });
  for (const id of ["upstream-url", "upstream-key"])
    byId(id).addEventListener("input", sourceChanged);
  byId("upstream-protocol").addEventListener("change", sourceChanged);
  byId("discover-models").addEventListener(
    "click",
    () => void discoverModels(),
  );
  byId("upstream-model-search").addEventListener("input", catalogChoices);
  byId("manual-model-add").addEventListener("click", () => {
    if (!accessToken || upstreamSaving || !hasCredentials()) return;
    const ids = [
      ...new Set(
        byId("manual-model-input")
          .value.split(/[\n,，]+/)
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (!ids.length || ids.some((id) => /[\s\u0000-\u001f\u007f]/.test(id))) {
      resultMessage(
        "discovery-result",
        "请填写有效的模型 ID，每行一个或用逗号分隔，ID 内不能有空白。",
        "error",
      );
      return;
    }
    if (new Set([...catalogSelection, ...ids]).size > 128) {
      resultMessage(
        "discovery-result",
        "一次最多接入 128 个模型，请减少手动添加的模型。",
        "error",
      );
      return;
    }
    cancelDiscovery();
    const sourceFingerprint = fingerprint(credentials());
    if (catalogFingerprint && catalogFingerprint !== sourceFingerprint)
      clearCatalog();
    for (const id of ids) {
      if (!catalogModels.some((model) => model.id === id))
        catalogModels.push({ id, name: id, isManual: true });
      catalogSelection.add(id);
    }
    catalogFingerprint = sourceFingerprint;
    byId("upstream-catalog").hidden = false;
    byId("upstream-catalog").open = true;
    byId("manual-model-input").value = "";
    catalogChoices();
    controls();
    resultMessage(
      "discovery-result",
      `已手动添加 ${ids.length} 个模型，保存时将测试首个模型。`,
    );
  });

  byId("upstream-select-all").addEventListener("click", () => {
    for (const model of catalogMatches()) {
      if (catalogSelection.size >= 128) break;
      catalogSelection.add(model.id);
    }
    catalogChoices();
    controls();
    if (catalogMatches().some((model) => !catalogSelection.has(model.id)))
      resultMessage(
        "discovery-result",
        "一次最多接入 128 个模型；已选前 128 个，可搜索后调整。",
        "error",
      );
  });
  byId("upstream-select-none").addEventListener("click", () => {
    catalogSelection.clear();
    catalogChoices();
    controls();
  });
  form.addEventListener("input", () => {
    editVersion += 1;
    resultMessage("save-result", "");
    byId("save-note").textContent = "有未保存的修改。";
  });
  form.addEventListener("change", availability);
  byId("upstream-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!accessToken || upstreamSaving || settingsSaving || discovering) return;
    const source = credentials();
    if (
      !source.baseUrl ||
      !source.apiKey ||
      catalogFingerprint !== fingerprint(source) ||
      !catalogSelection.size
    ) {
      resultMessage(
        "upstream-result",
        "请先获取模型并勾选要接入的模型。",
        "error",
      );
      return;
    }
    let payload = {
      ...source,
      modelIds: [...catalogSelection],
      name:
        byId("upstream-name").value.trim() ||
        selectedPreset?.name ||
        new URL(source.baseUrl).hostname,
      ...(editingChannelId !== null ? { channelId: editingChannelId } : {}),
      ...(revision !== null ? { revision } : {}),
    };
    const submittedIds = [...catalogSelection];
    const publicEditsAtSubmit = editVersion;
    cancelDiscovery();
    byId("upstream-key").value = "";
    clearCatalog();
    upstreamSaving = true;
    controls();
    resultMessage(
      "upstream-result",
      "正在保存渠道并测试首个模型，只发出一次最小请求…",
    );
    try {
      const tested = await request("POST", payload, "/admin-api/upstream");
      payload = null;
      if (tested.success !== true || tested.test?.success !== true) {
        resultMessage(
          "upstream-result",
          tested.message ||
            "渠道测试未通过，请检查地址、Key、协议和模型权限后重试。",
          "error",
        );
        return;
      }
      if (tested.channel && Number.isInteger(tested.channel.id)) {
        savedChannels([
          ...knownChannels.filter(
            (channel) => channel.id !== tested.channel.id,
          ),
          tested.channel,
        ]);
      }
      let data;
      try {
        data = await request("GET");
      } catch (error) {
        if (authFailure(error)) requireLogin();
        resultMessage(
          "upstream-result",
          "API 已接入并测试通过，公益设置暂时无法读取；请重新读取设置后开放。",
          "error",
        );
        byId("load-retry").hidden = false;
        return;
      }
      if (revision === null) render(data);
      else savedChannels(data.channels);
      const available = new Set(
        data.channels
          .filter((channel) => channel.enabled === true)
          .flatMap((channel) => channel.models.map((model) => model.id)),
      );
      if (publicEditsAtSubmit !== editVersion) {
        modelChoices(data.channels);
        resultMessage(
          "upstream-result",
          "API 测试通过。已保留你刚修改的公益设置，请按需选择模型后保存。",
          "success",
        );
        return;
      }
      let omitted = 0;
      for (const id of submittedIds) {
        if (!available.has(id) || selectedModels.has(id)) continue;
        if (selectedModels.size >= 128) {
          omitted += 1;
          continue;
        }
        selectedModels.add(id);
      }
      modelChoices(data.channels);
      byId("enabled").checked = true;
      byId("mode-permanent").checked = true;
      byId("mode-until").checked = false;
      byId("available-until").value = "";
      availability();
      editVersion += 1;
      byId("save-note").textContent = "API 测试已通过，点击保存并开放后生效。";
      resultMessage(
        "upstream-result",
        revision === data.settings.revision
          ? `测试通过，已选长期开放；点击保存并开放生效。额度设置已保留。${omitted ? `公益模型最多 128 个，另有 ${omitted} 个未自动勾选。` : ""}`
          : "API 测试通过。服务器设置已有变化，请重新读取设置后再开放。",
        "success",
      );
    } catch (error) {
      if (authFailure(error)) requireLogin();
      resultMessage(
        "upstream-result",
        typeof error.status === "number"
          ? error.message || "接入失败，请检查配置后重试。"
          : "结果未确认，请重新读取当前配置后再试。",
        "error",
      );
    } finally {
      payload = null;
      byId("upstream-key").value = "";
      upstreamSaving = false;
      controls();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      !accessToken ||
      revision === null ||
      settingsSaving ||
      upstreamSaving ||
      settingsLoading
    )
      return;
    let settings;
    try {
      settings = collect();
    } catch (error) {
      resultMessage("save-result", error.message, "error");
      return;
    }
    const current = ++settingsGeneration,
      edits = editVersion;
    settingsSaving = true;
    controls();
    resultMessage("save-result", "正在保存…");
    try {
      const data = await request("PUT", settings);
      if (current !== settingsGeneration || edits !== editVersion) return;
      render(data);
      statusMessage("");
      resultMessage(
        "save-result",
        data.status.ready
          ? "已保存，公益模型现已开放。"
          : data.status.expired
            ? "已保存，当前开放时间已到期。"
            : "已保存，公益模型当前关闭。",
        "success",
      );
    } catch (error) {
      if (current !== settingsGeneration) return;
      if (authFailure(error)) requireLogin();
      resultMessage(
        "save-result",
        error.message || "保存失败，你的修改已保留。",
        "error",
      );
    } finally {
      if (current === settingsGeneration) {
        settingsSaving = false;
        controls();
      }
    }
  });
  byId("reload").addEventListener("click", () => void load());
  byId("load-retry").addEventListener("click", () => void load());
  byId("timezone-note").textContent =
    `按浏览器本地时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}。`;
  presetOptions();
  controls();
  void loadPresets();
  void load();
})();
