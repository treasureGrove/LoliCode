// The request function closes over the existing session; no credentials leave
// the parent closure or enter web storage. This panel owns only account drafts.
window.RelayAdminAccounts = ({ request }) => {
  const byId = (id) => document.getElementById(id);
  const panel = byId("accounts-panel");
  const drafts = new Map();
  const records = new Map();
  let authorized = false;
  let permitted = true;
  let epoch = 0;
  let generation = 0;
  let loading = false;
  let page = 1;
  let pageSize = 50;
  let total = 0;
  let query = "";
  let visibleIds = [];

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const credit = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      return "—";
    if (value > 0 && value < 0.01) return "< 0.01";
    return value.toLocaleString("zh-CN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };
  const balance = (account) => {
    const quota = account.quota || {};
    // A canonical balance is an indivisible snapshot. Never fill missing fields
    // from a different projection or subtract the reservation a second time.
    const canonical = Object.prototype.hasOwnProperty.call(
      quota,
      "creditBalance",
    );
    const value = canonical
      ? quota.creditBalance
      : {
          limit: quota.creditLimit,
          used: quota.creditsUsed,
          reserved: quota.creditsReserved,
          remaining: quota.creditsRemaining,
        };
    if (
      !value ||
      (canonical && value.unit !== "Credit") ||
      !["limit", "used", "reserved", "remaining"].every(
        (key) =>
          typeof value[key] === "number" &&
          Number.isFinite(value[key]) &&
          value[key] >= 0,
      )
    )
      return {};
    return value;
  };
  function message(text, error = false) {
    byId("accounts-message").textContent = text;
    byId("accounts-message").classList.toggle("error", error);
  }
  function controls() {
    const disabled = !authorized || !permitted;
    byId("accounts-reload").disabled = disabled || loading;
    byId("accounts-search").disabled = disabled;
    byId("accounts-search-submit").disabled = disabled;
    byId("accounts-prev").disabled = disabled || loading || page <= 1;
    byId("accounts-next").disabled =
      disabled || loading || page * pageSize >= total;
    byId("accounts-page").textContent =
      `第 ${page} / ${Math.max(1, Math.ceil(total / pageSize))} 页 · ${total} 位用户`;
    for (const row of byId("accounts-list").children) {
      const reset = row.querySelector('[data-action="reset"]');
      if (reset)
        reset.disabled =
          disabled || loading || drafts.get(row.dataset.accountId)?.saving;
    }
  }
  function draftFor(account) {
    const id = String(account.id);
    if (!drafts.has(id))
      drafts.set(id, {
        revision: account.revision,
        value:
          account.dailyCreditsOverride === null
            ? ""
            : String(account.dailyCreditsOverride),
        disabled: account.disabled,
        editVersion: 0,
        dirty: false,
        saving: false,
        conflict: false,
        message: "",
        error: false,
        badInput: false,
      });
    return drafts.get(id);
  }
  function overrideValue(value) {
    const text = value.trim();
    if (text === "") return null;
    if (
      !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text) ||
      !Number.isFinite(Number(text)) ||
      Number(text) > 1000000
    )
      throw new Error(
        "每日 Credit 请填写 0 至 1,000,000，最多六位小数；留空继承默认额度。",
      );
    return Number(text);
  }
  function validAccount(account) {
    return (
      account &&
      (typeof account.id === "string" || Number.isSafeInteger(account.id)) &&
      String(account.id).length > 0 &&
      Number.isSafeInteger(account.revision) &&
      account.revision >= 0 &&
      typeof account.disabled === "boolean" &&
      (account.dailyCreditsOverride === null ||
        (typeof account.dailyCreditsOverride === "number" &&
          Number.isFinite(account.dailyCreditsOverride) &&
          account.dailyCreditsOverride >= 0 &&
          account.dailyCreditsOverride <= 1000000))
    );
  }
  function row(account) {
    const id = String(account.id);
    const draft = draftFor(account);
    const item = node("article", "account-admin-row");
    item.dataset.accountId = id;
    const heading = node("div", "account-admin-heading");
    heading.append(
      node(
        "strong",
        "",
        account.displayName || account.username || "未命名用户",
      ),
      node("span", "muted", `${account.username || "未设置用户名"} · ID ${id}`),
    );
    item.append(heading);
    const quota = balance(account);
    const stats = node("dl", "account-admin-stats");
    for (const [key, label] of [
      ["used", "今日已用"],
      ["reserved", "处理中预留"],
      ["remaining", "剩余"],
    ]) {
      const stat = node("div");
      const value = node("dd", "", `${credit(quota[key])} Credit`);
      value.dataset.stat = key;
      if (typeof quota[key] === "number")
        value.title = `精确值：${quota[key]} Credit`;
      stat.append(node("dt", "", label), value);
      stats.append(stat);
    }
    item.append(stats);
    const edit = node("form", "account-admin-edit");
    edit.noValidate = true;
    const label = node("label", "field account-admin-override");
    label.append(node("span", "", "每日 Credit 覆盖"));
    const input = node("input");
    input.type = "number";
    input.min = "0";
    input.max = "1000000";
    input.step = "0.000001";
    input.inputMode = "decimal";
    input.placeholder = "留空继承默认";
    input.value = draft.value;
    input.dataset.field = "dailyCreditsOverride";
    label.append(input);
    const paused = node("label", "account-admin-paused");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.checked = draft.disabled;
    checkbox.dataset.field = "disabled";
    paused.append(checkbox, node("span", "", "暂停使用"));
    const save = node("button", "button", "保存此用户");
    save.type = "submit";
    const reset = node("button", "button secondary", "重读并放弃此行修改");
    reset.type = "button";
    reset.dataset.action = "reset";
    const result = node("p", "field-help account-admin-result");
    result.setAttribute("role", "status");
    result.setAttribute("aria-live", "polite");
    const update = () => {
      save.disabled = !authorized || draft.saving;
      save.textContent = draft.saving ? "正在保存…" : "保存此用户";
      reset.hidden = !draft.dirty && !draft.conflict;
      reset.disabled = !authorized || draft.saving || loading;
      result.textContent = draft.message;
      result.classList.toggle("error", draft.error);
    };
    const edited = () => {
      draft.value = input.value;
      draft.badInput = input.validity.badInput;
      draft.disabled = checkbox.checked;
      draft.editVersion += 1;
      draft.dirty = true;
      draft.message = draft.conflict
        ? "用户设置已变化，你的草稿已保留；请核对或重读此行。"
        : "此用户有未保存的修改。";
      draft.error = draft.conflict;
      update();
    };
    input.addEventListener("input", edited);
    checkbox.addEventListener("change", edited);
    edit.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveAccount(id);
    });
    reset.addEventListener("click", () => void load({ resetId: id }));
    edit.append(label, paused, save, reset);
    item.append(
      edit,
      node(
        "p",
        "field-help",
        `当前每日额度：${credit(quota.limit)} Credit；留空继承默认。`,
      ),
      result,
    );
    update();
    return item;
  }
  function renderRows() {
    const list = byId("accounts-list");
    list.replaceChildren();
    for (const id of visibleIds) list.append(row(records.get(id)));
    if (!visibleIds.length) list.append(node("p", "muted", "未找到匹配用户。"));
  }
  async function saveAccount(id) {
    const draft = drafts.get(id);
    if (!authorized || !permitted || !draft || draft.saving) return;
    let value;
    try {
      if (draft.badInput)
        throw new Error(
          "每日 Credit 输入不完整，请填写有效数字，或清空以继承默认额度。",
        );
      value = overrideValue(draft.value);
    } catch (error) {
      draft.message = error.message;
      draft.error = true;
      renderRows();
      return;
    }
    const currentEpoch = epoch;
    const edits = draft.editVersion;
    const payload = {
      revision: draft.revision,
      dailyCreditsOverride: value,
      disabled: draft.disabled,
    };
    draft.saving = true;
    draft.message = "正在保存此用户…";
    draft.error = false;
    renderRows();
    try {
      const data = await request(
        "PUT",
        payload,
        `/admin-api/accounts/${encodeURIComponent(id)}`,
      );
      if (!authorized || currentEpoch !== epoch) return;
      if (!validAccount(data.account) || String(data.account.id) !== id)
        throw new Error("保存结果不完整，请重新读取用户核对；当前草稿已保留。");
      const account = data.account;
      records.set(id, account);
      draft.revision = account.revision;
      draft.conflict = false;
      if (edits === draft.editVersion) {
        draft.value =
          account.dailyCreditsOverride === null
            ? ""
            : String(account.dailyCreditsOverride);
        draft.disabled = account.disabled;
        draft.dirty = false;
        draft.message = "已保存此用户。";
      } else {
        draft.message = "上一版已保存；你刚修改的输入仍保留，尚未保存。";
      }
    } catch (error) {
      if (!authorized || currentEpoch !== epoch) return;
      draft.error = true;
      if (error.status === 403) {
        denyAccess();
        return;
      }
      draft.conflict = error.status === 409;
      draft.message = draft.conflict
        ? "用户设置已被其他页面更新，你的草稿已保留，没有自动重试。可刷新查看用量，或重读并放弃此行修改后重新编辑。"
        : error.message || "保存未确认，你的草稿已保留，请重新读取用户核对。";
    } finally {
      draft.saving = false;
      if (authorized && currentEpoch === epoch && permitted) renderRows();
    }
  }
  function denyAccess() {
    permitted = false;
    generation += 1;
    visibleIds = [];
    records.clear();
    byId("accounts-list").replaceChildren();
    byId("accounts-summary").textContent = "";
    message("需站长权限才能查看和管理用户额度；其他设置仍可正常使用。", true);
    controls();
  }
  async function load({ resetId } = {}) {
    if (!authorized || !permitted) return;
    const current = ++generation;
    const currentEpoch = epoch;
    const requestedPage = page;
    const resetDraft = resetId ? drafts.get(resetId) : null;
    const resetEdits = resetDraft?.editVersion;
    const params = new URLSearchParams({
      page: String(requestedPage),
      pageSize: String(pageSize),
      q: query,
    });
    loading = true;
    controls();
    message("正在读取用户用量…");
    try {
      const data = await request(
        "GET",
        undefined,
        `/admin-api/accounts?${params}`,
      );
      if (!authorized || currentEpoch !== epoch || current !== generation)
        return;
      if (
        !Array.isArray(data.accounts) ||
        !data.accounts.every(validAccount) ||
        !Number.isSafeInteger(data.total) ||
        data.total < 0 ||
        !Number.isSafeInteger(data.page) ||
        data.page < 1 ||
        !Number.isSafeInteger(data.pageSize) ||
        data.pageSize < 1
      )
        throw new Error("用户资料不完整，请重新读取；现有草稿已保留。");
      page = data.page;
      pageSize = data.pageSize;
      total = data.total;
      let resetApplied = false;
      visibleIds = data.accounts.map((account) => {
        const id = String(account.id);
        const known = records.get(id);
        if (!known || account.revision >= known.revision)
          records.set(id, account);
        const draft = drafts.get(id);
        const canReset =
          resetId === id &&
          draft === resetDraft &&
          draft?.editVersion === resetEdits &&
          !draft?.saving;
        if (canReset) resetApplied = true;
        if (
          canReset ||
          (draft && !draft.dirty && !draft.saving && !draft.conflict)
        )
          drafts.delete(id);
        return id;
      });
      const usage = data.globalUsage || {};
      const globalLimit =
        data.globalDailyCredits === null
          ? "不限"
          : `${credit(data.globalDailyCredits)} Credit`;
      const remaining =
        usage.remaining === null ? "不限" : `${credit(usage.remaining)} Credit`;
      byId("accounts-summary").textContent =
        `默认每人每日 ${credit(data.defaultDailyCredits)} Credit · 全站每日 ${globalLimit}。今日全站已用 ${credit(usage.used)} Credit，预留 ${credit(usage.reserved)} Credit，剩余 ${remaining}。`;
      renderRows();
      message(
        "用户用量已更新；未保存的个人设置草稿已保留。" +
          (resetApplied ? "指定用户已按服务器设置重新读取。" : ""),
      );
    } catch (error) {
      if (!authorized || currentEpoch !== epoch || current !== generation)
        return;
      if (error.status === 403) denyAccess();
      else
        message(
          error.message || "用户用量读取失败，请重试；现有草稿已保留。",
          true,
        );
    } finally {
      if (currentEpoch === epoch && current === generation) {
        loading = false;
        controls();
      }
    }
  }
  byId("accounts-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    query = byId("accounts-search").value.trim();
    page = 1;
    void load();
  });
  byId("accounts-reload").addEventListener("click", () => void load());
  byId("accounts-prev").addEventListener("click", () => {
    page -= 1;
    void load();
  });
  byId("accounts-next").addEventListener("click", () => {
    page += 1;
    void load();
  });
  controls();
  return {
    setAuthorized(value) {
      if (authorized === value) return;
      authorized = value;
      epoch += 1;
      generation += 1;
      loading = false;
      panel.hidden = !value;
      if (value) {
        permitted = true;
        void load();
      } else {
        drafts.clear();
        records.clear();
        visibleIds = [];
        byId("accounts-list").replaceChildren();
        byId("accounts-summary").textContent = "";
        message("");
      }
      controls();
    },
  };
};
