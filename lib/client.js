/**
 * dsh-plugin-soul · 浏览器端入口：设置页「人格」tab
 *
 * 为什么单独一个文件：插件本体（lib/index.js）跑在宿主进程里，浏览器只认 DSH
 * 客户端下发的模块；所以这里走 CJS factory 包装，靠宿主注入的 require 取 react，
 * 不引任何 npm 包（没有构建步骤、也没有 import 语句）。
 *
 * 数据全走同源 /dsh-plugin-soul/api/*，无 token；只在 mount 与写操作之后拉一次，
 * 不轮询 —— 每次自改都会打破 system prompt 的缓存前缀，本来也不该高频发生。
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-soul",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    /** 免 JSX 写组件（产物风格同官方插件） */
    const h = React.createElement;

    /** 后端路由前缀 */
    const API = "/dsh-plugin-soul/api";
    /** 候选升格闸门：与 lib/journal.js 的 MIN_CANDIDATE_* 同源，改一处要改两处 */
    const MIN_COUNT = 3;
    const MIN_DAYS = 2;
    const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

    /** 宿主主题变量优先，取不到就退中性色 */
    const C = {
      primary: "var(--dsw-alias-label-primary, #1f2328)",
      secondary: "var(--dsw-alias-label-secondary, #6e7781)",
      tertiary: "var(--dsw-alias-label-tertiary, #8c959f)",
      border: "var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))",
      bg: "var(--dsw-alias-bg-l1, rgba(0, 0, 0, 0.03))",
      danger: "#d9534f",
      ok: "#2e7d32",
    };

    const BTN = {
      font: "inherit",
      fontSize: 12,
      lineHeight: "20px",
      padding: "2px 10px",
      borderRadius: 4,
      border: "1px solid " + C.border,
      background: "transparent",
      color: C.primary,
      cursor: "pointer",
      whiteSpace: "nowrap",
    };
    const COMMIT = {
      display: "flex",
      alignItems: "baseline",
      gap: 10,
      width: "100%",
      padding: "4px 6px",
      margin: "0 -6px",
      border: "1px solid transparent",
      borderRadius: 4,
      background: "transparent",
      color: "inherit",
      font: "inherit",
      textAlign: "left",
      cursor: "pointer",
    };

    const S = {
      root: {
        padding: "16px 20px",
        fontSize: 13,
        lineHeight: 1.5,
        color: C.primary,
        display: "flex",
        flexDirection: "column",
        gap: 18,
      },
      block: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 },
      headRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
      h1: { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.5 },
      h3: { margin: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.5 },
      meta: { display: "flex", flexWrap: "wrap", gap: "2px 18px", color: C.secondary, fontSize: 12 },
      metaItem: { display: "inline-flex", gap: 6, alignItems: "baseline", minWidth: 0, maxWidth: "100%" },
      mono: { fontFamily: MONO, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      btn: BTN,
      btnOff: { ...BTN, color: C.tertiary, cursor: "default" },
      btnStrong: { ...BTN, fontWeight: 600 },
      danger: { color: C.danger, fontSize: 12, whiteSpace: "pre-wrap" },
      okText: { color: C.ok, fontSize: 12, whiteSpace: "pre-wrap" },
      // 消息操作栏里的评分控件（紧凑，和官方 👍👎 并排）
      // order:9999 —— 官方 MessageIconActions 把 extraActions 固定插在「复制」和「分支」之间，
      // 槽位注册的 order 管不到这个位置；但 .ppByMG_actions 是 flex 容器，
      // 用 CSS order 才能把它推到所有兄弟（含用量面板、时间）之后。
      ratingRow: { order: 9999, position: "relative", display: "inline-flex", alignItems: "center", gap: 2, marginLeft: 4, verticalAlign: "middle" },
      ratingBtn: {
        border: "1px solid transparent",
        background: "transparent",
        borderRadius: 4,
        padding: "0 4px",
        cursor: "pointer",
        fontSize: 13,
        lineHeight: "18px",
        color: C.tertiary,
        filter: "grayscale(1)",
        opacity: 0.75,
      },
      ratingBtnOn: {
        border: "1px solid " + C.border,
        background: C.bg,
        borderRadius: 4,
        padding: "0 4px",
        cursor: "pointer",
        fontSize: 13,
        lineHeight: "18px",
        color: C.primary,
        filter: "none",
        opacity: 1,
      },
      ratingW: { fontFamily: MONO, fontSize: 11, color: C.tertiary, marginLeft: 2 },
      ratingErr: { fontSize: 11, color: C.danger, marginLeft: 2 },
      // 打分后的「总结」小对话框：单行 — input + 提交/取消 横排，
      // 高度和操作栏一致，不撑高、不挤出旁边按钮
      ratingDlg: {
        display: "inline-flex",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        marginLeft: 6,
        padding: "1px 4px",
        border: "1px solid " + C.border,
        borderRadius: 6,
        background: C.bg,
      },
      ratingDlgHead: { fontSize: 11, color: C.tertiary },
      ratingInput: {
        width: 168,
        maxWidth: "min(168px, 38vw)",
        boxSizing: "border-box",
        height: 22,
        fontSize: 12,
        lineHeight: "20px",
        color: C.primary,
        background: "transparent",
        border: "1px solid " + C.border,
        borderRadius: 4,
        padding: "0 6px",
        outline: "none",
        fontFamily: "inherit",
      },
      ratingDlgRow: { display: "flex", alignItems: "center", gap: 4 },
      ratingBtnSm: {
        border: "1px solid " + C.border,
        background: "transparent",
        borderRadius: 4,
        padding: "0 8px",
        cursor: "pointer",
        fontSize: 12,
        lineHeight: "20px",
        height: 22,
        color: C.primary,
      },
      ratingBtnPrimary: {
        border: "1px solid transparent",
        background: C.primary,
        color: C.bg,
        borderRadius: 4,
        padding: "0 8px",
        cursor: "pointer",
        fontSize: 12,
        lineHeight: "20px",
        height: 22,
      },
      muted: { color: C.tertiary, fontSize: 12 },
      cards: { display: "flex", flexDirection: "column", gap: 8 },
      card: { border: "1px solid " + C.border, borderRadius: 6, padding: "10px 12px", minWidth: 0 },
      cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
      nameBtn: {
        display: "inline-flex",
        alignItems: "baseline",
        gap: 8,
        minWidth: 0,
        padding: 0,
        border: 0,
        background: "transparent",
        color: "inherit",
        font: "inherit",
        textAlign: "left",
        cursor: "pointer",
      },
      fileName: { fontFamily: MONO, fontSize: 13, color: C.primary, flex: "none" },
      fileLabel: { color: C.tertiary, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      cardRight: { display: "flex", alignItems: "center", gap: 10, flex: "none" },
      counts: { fontFamily: MONO, fontSize: 12, color: C.secondary },
      ro: { fontSize: 12, color: C.tertiary },
      barTrack: { height: 3, borderRadius: 2, background: C.border, overflow: "hidden", marginTop: 8 },
      filePre: {
        margin: "8px 0 0",
        padding: 8,
        maxHeight: 260,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: MONO,
        fontSize: 12,
        background: C.bg,
        borderRadius: 4,
      },
      editBox: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 },
      textarea: {
        width: "100%",
        boxSizing: "border-box",
        minHeight: 220,
        padding: 8,
        border: "1px solid " + C.border,
        borderRadius: 4,
        background: C.bg,
        color: C.primary,
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.5,
        resize: "vertical",
      },
      input: {
        width: "100%",
        boxSizing: "border-box",
        padding: "6px 8px",
        border: "1px solid " + C.border,
        borderRadius: 4,
        background: C.bg,
        color: C.primary,
        fontFamily: "inherit",
        fontSize: 13,
      },
      editFoot: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
      editBtns: { display: "flex", gap: 8 },
      candRow: { padding: "6px 0", borderBottom: "1px solid " + C.border, minWidth: 0 },
      candLine: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      evidence: {
        marginTop: 2,
        color: C.tertiary,
        fontFamily: MONO,
        fontSize: 11,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
      commitRow: COMMIT,
      commitOn: { ...COMMIT, background: C.bg, borderColor: C.border },
      commitDate: { color: C.secondary, fontFamily: MONO, fontSize: 12, flex: "none" },
      commitSubject: { minWidth: 0, wordBreak: "break-word" },
      panel: {
        border: "1px solid " + C.border,
        borderRadius: 6,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
      },
      panelHead: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        color: C.secondary,
        fontSize: 12,
      },
      diffPre: {
        margin: 0,
        maxHeight: 320,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        fontFamily: MONO,
        fontSize: 12,
        background: C.bg,
        borderRadius: 4,
        padding: 8,
      },
      dreamPre: {
        margin: 0,
        maxHeight: 240,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: MONO,
        fontSize: 12,
        background: C.bg,
        borderRadius: 4,
        padding: 8,
      },
    };

    /**
     * 统一 fetch：把网络错误、非 2xx、以及 200 里 ok:false 都收敛成 { ok, message }。
     * 组件层面只读 ok/message，任何异常都不会冒成渲染错误。
     */
    async function call(url, init) {
      try {
        const res = await fetch(url, init);
        let body = null;
        try {
          body = await res.json();
        } catch (err) {
          body = null; // 非 JSON 也不该吞掉状态码，下面按 HTTP 报
        }
        if (!res.ok || (body && body.ok === false)) {
          return { ok: false, message: (body && body.message) || "HTTP " + res.status };
        }
        return { ok: true, data: body };
      } catch (err) {
        return { ok: false, message: "读不到：" + (err && err.message ? err.message : err) };
      }
    }

    /** POST JSON；dream 的 body 允许空对象 */
    function postJson(url, payload) {
      return call(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
    }

    /** ISO 只留到分钟：2026-10-26T19:00:00Z → 2026-10-26 19:00 */
    function shortTime(iso) {
      const text = String(iso || "");
      const match = text.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      return match ? match[0].replace("T", " ") : text;
    }

    /**
     * 从提交 subject 里认出文件名。后端 /diff 是 `git diff HEAD~1 -- 文件`，
     * 没有按 sha 出差异的参数，所以点提交时只能猜它改的是哪个文件；
     * 猜不到按 SOUL.md 兜（主文件），标题里也写清是 HEAD~1 而非该提交。
     */
    function diffTarget(subject) {
      const names = ["IDENTITY.md", "SOUL.md", "USER.md", "RULES.md"];
      for (const name of names) {
        if (String(subject || "").indexOf(name) >= 0) return name;
      }
      return "SOUL.md";
    }

    /** 与后端同一把闸门：staged + 次数 + 跨天 */
    function isEligible(row) {
      return (
        row &&
        row.status === "staged" &&
        Number(row.count) >= MIN_COUNT &&
        Array.isArray(row.days) &&
        row.days.length >= MIN_DAYS
      );
    }

    /** 数字字段兜底，坏数据只显示 0 不崩 */
    function num(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    function SoulSection() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      /** 展开全文的文件名集合 */
      const [expanded, setExpanded] = React.useState({});
      /** 当前编辑：{ name, draft, why, saving }；一次只开一个 */
      const [edit, setEdit] = React.useState(null);
      /** 每个文件的保存提示：{ tone: "ok" | "error", text } */
      const [notices, setNotices] = React.useState({});
      const [dream, setDream] = React.useState({ running: false, text: null, error: null });
      const [diffView, setDiffView] = React.useState(null);
      /** 记忆升格：跑的时候禁用按钮 */
      const [memoryBusy, setMemoryBusy] = React.useState(false);
      const [memoryNote, setMemoryNote] = React.useState(null);

      const load = React.useCallback(async () => {
        setLoading(true);
        const result = await call(API + "/state");
        if (result.ok) {
          setState(result.data || null);
          setError(null);
        } else {
          setError(result.message);
        }
        setLoading(false);
      }, []);

      // 只在这里拉一次；之后由保存 / 反思成功回调 load()，不轮询
      React.useEffect(() => {
        load();
      }, [load]);

      const toggleOpen = (name) => {
        setExpanded((prev) => ({ ...prev, [name]: prev[name] !== true }));
      };

      const beginEdit = (file) => {
        setNotices((prev) => ({ ...prev, [file.name]: null }));
        setEdit({
          name: file.name,
          draft: String(file.content || ""),
          why: "",
          saving: false,
        });
      };

      /** 保存：成功收起编辑器并重拉 state；失败保留草稿 + 后端 message 原文 */
      async function onSave() {
        if (edit === null || edit.saving) return;
        const name = edit.name;
        const content = edit.draft;
        const why = edit.why.trim();
        if (why.length < 4) {
          setNotices((prev) => ({
            ...prev,
            [name]: { tone: "error", text: "「为什么改」必填（≥4 字符）：写清依据，比如主人哪句话" },
          }));
          return;
        }
        setEdit((prev) => (prev ? { ...prev, saving: true } : prev));
        setNotices((prev) => ({ ...prev, [name]: null }));
        const result = await postJson(API + "/file", { name, content, why });
        if (!result.ok) {
          setEdit((prev) => (prev && prev.name === name ? { ...prev, saving: false } : prev));
          setNotices((prev) => ({ ...prev, [name]: { tone: "error", text: result.message } }));
          return;
        }
        const data = result.data || {};
        const message = data.message || "已写入 " + name;
        // git 不可用时后端记 no-git（见 README「已知的坑」），别摆出来像提交号
        const commit = data.commit && data.commit !== "no-git" ? "（提交 " + data.commit + "）" : "";
        setNotices((prev) => ({ ...prev, [name]: { tone: "ok", text: message + commit } }));
        setEdit(null);
        await load();
      }

      /** 反思：跑的时候禁用按钮，结束后刷新（提交/候选会变） */
      async function onDream() {
        if (dream.running) return;
        setDream({ running: true, text: null, error: null });
        const result = await postJson(API + "/dream", {});
        if (!result.ok) {
          setDream({ running: false, text: null, error: result.message });
          return;
        }
        const summary = result.data && typeof result.data.summary === "string" ? result.data.summary : "";
        setDream({ running: false, text: summary || "（后端没有返回摘要）", error: null });
        await load();
      }

      /** 记忆升格：把「被 recall 够多次」的日笔记写进 MEMORY.md；完成后刷新 */
      async function onPromoteMemory() {
        if (memoryBusy) return;
        setMemoryBusy(true);
        setMemoryNote(null);
        const result = await postJson(API + "/memory/promote", {});
        if (!result.ok) {
          setMemoryBusy(false);
          setMemoryNote({ tone: "error", text: result.message });
          return;
        }
        const data = result.data || {};
        setMemoryBusy(false);
        setMemoryNote({
          tone: data.promoted > 0 ? "ok" : "info",
          text: data.message || (data.promoted > 0 ? "已升格 " + data.promoted + " 条" : "没有够格的"),
        });
        await load();
      }

      /** 点提交看 diff；同一时刻只留一块 */
      async function openDiff(commit) {
        const name = diffTarget(commit.subject);
        const head = String(commit.sha || "").slice(0, 7);
        const target = { sha: commit.sha, title: head + " · git diff HEAD~1 · " + name, loading: true, text: "", error: null };
        setDiffView(target);
        const result = await call(API + "/diff?name=" + encodeURIComponent(name));
        setDiffView((prev) => {
          if (prev === null || prev.sha !== commit.sha) return prev; // 期间又点了别的，别覆盖
          if (!result.ok) return { ...prev, loading: false, error: result.message };
          const text = result.data && typeof result.data.diff === "string" ? result.data.diff : "";
          return { ...prev, loading: false, text: text || "（这个文件当前没有差异）" };
        });
      }

      const memory = (state && state.memory) || null;
      const ratings = (state && state.ratings) || null;
      const files = state && Array.isArray(state.files) ? state.files : [];
      const candidates = (state && state.candidates) || { total: 0, eligible: 0, rows: [] };
      const candidateRows = Array.isArray(candidates.rows) ? candidates.rows : [];
      const commits = state && Array.isArray(state.commits) ? state.commits.slice(0, 5) : [];
      const lastDream = state && state.lastDream ? state.lastDream : null;

      /** 单张文件卡：折叠/展开、编辑、保存提示都在这一层 */
      function renderCard(file) {
        const name = String(file.name || "");
        const active = edit !== null && edit.name === name;
        const open = expanded[name] === true;
        const notice = notices[name];
        const chars = num(file.chars);
        const budget = num(file.budget);
        const over = file.overBudget === true || (budget > 0 && chars > budget);
        const pct = budget > 0 ? Math.max(0, Math.min(100, Math.round((chars / budget) * 100))) : 0;
        const parts = [];

        parts.push(
          h(
            "div",
            { key: "head", style: S.cardHead },
            h(
              "button",
              {
                type: "button",
                style: S.nameBtn,
                onClick: () => toggleOpen(name),
                title: open ? "收起全文" : "展开全文",
              },
              h("span", { style: S.fileName }, name),
              h("span", { style: S.fileLabel }, String(file.label || "")),
            ),
            h(
              "div",
              { style: S.cardRight },
              h("span", { style: S.counts }, chars + "/" + budget),
              file.writable === true
                ? h(
                    "button",
                    {
                      type: "button",
                      style: edit !== null && !active ? S.btnOff : S.btn,
                      disabled: edit !== null && !active,
                      title: edit !== null && !active ? "先保存或取消当前编辑" : active ? "收起编辑" : "编辑",
                      onClick: () => {
                        if (active) setEdit(null);
                        else if (edit === null) beginEdit(file);
                      },
                    },
                    active ? "收起" : "编辑",
                  )
                : h("span", { style: S.ro }, "只读"),
            ),
          ),
        );

        parts.push(
          h(
            "div",
            { key: "bar", style: S.barTrack },
            h("div", {
              style: {
                height: "100%",
                width: pct + "%",
                borderRadius: 2,
                background: over ? C.danger : C.primary,
              },
            }),
          ),
        );

        if (open) parts.push(h("pre", { key: "body", style: S.filePre }, String(file.content || "")));

        if (active) {
          parts.push(
            h(
              "div",
              { key: "edit", style: S.editBox },
              h("textarea", {
                style: S.textarea,
                value: edit.draft,
                spellCheck: false,
                onChange: (event) => {
                  const value = event.target.value;
                  setEdit((prev) => (prev ? { ...prev, draft: value } : prev));
                },
              }),
              h("input", {
                style: S.input,
                value: edit.why,
                placeholder: "为什么改？必填，例：主人 10-26 说名字定成 XX",
                onChange: (event) => {
                  const value = event.target.value;
                  setEdit((prev) => (prev ? { ...prev, why: value } : prev));
                },
              }),
              h(
                "div",
                { style: S.editFoot },
                h("span", { style: S.muted }, edit.draft.length + "/" + budget + " 字符"),
                h(
                  "div",
                  { style: S.editBtns },
                  h(
                    "button",
                    { type: "button", style: edit.saving ? S.btnOff : S.btn, disabled: edit.saving, onClick: () => setEdit(null) },
                    "取消",
                  ),
                  h(
                    "button",
                    { type: "button", style: edit.saving ? S.btnOff : S.btnStrong, disabled: edit.saving, onClick: onSave },
                    edit.saving ? "保存中…" : "保存",
                  ),
                ),
              ),
            ),
          );
        }

        if (notice && notice.text) {
          parts.push(h("div", { key: "notice", style: notice.tone === "ok" ? S.okText : S.danger }, notice.text));
        }

        return h("div", { key: name, style: S.card }, parts);
      }

      function renderDiff() {
        return h(
          "div",
          { style: S.panel },
          h(
            "div",
            { style: S.panelHead },
            h("span", { style: S.mono }, diffView.title),
            h("button", { type: "button", style: S.btn, onClick: () => setDiffView(null) }, "关闭"),
          ),
          diffView.error
            ? h("div", { style: S.danger }, diffView.error)
            : diffView.loading
              ? h("div", { style: S.muted }, "读 diff…")
              : h("pre", { style: S.diffPre }, diffView.text),
        );
      }

      const header = h(
        "div",
        { style: S.block },
        h(
          "div",
          { style: S.headRow },
          h("h2", { style: S.h1 }, "人格"),
          h(
            "button",
            {
              type: "button",
              style: dream.running ? S.btnOff : S.btn,
              disabled: dream.running,
              onClick: onDream,
            },
            dream.running ? "反思中…" : "跑一次反思",
          ),
        ),
        h(
          "div",
          { style: S.meta },
          h(
            "span",
            { style: S.metaItem },
            h("span", null, "自我目录"),
            h("span", { style: S.mono }, (state && state.root) || "—"),
          ),
          h(
            "span",
            { style: S.metaItem },
            "注入 ≈" + num(state && state.injectTokens) + " tok / " + num(state && state.injectChars) + " 字符",
          ),
          h(
            "span",
            { style: S.metaItem },
            "今日自改 " + num(state && state.writesToday) + "/" + num(state && state.maxWritesPerDay),
          ),
          lastDream
            ? h(
                "span",
                { style: S.metaItem },
                "上次反思 " +
                  shortTime(lastDream.at) +
                  " · 升格 " +
                  num(lastDream.promoted) +
                  " / 候选 " +
                  num(lastDream.staged),
              )
            : null,
        ),
        error ? h("div", { style: S.danger }, error) : null,
        state === null && loading ? h("div", { style: S.muted }, "读取中…") : null,
        dream.error ? h("div", { style: S.danger }, "反思失败：" + dream.error) : null,
        dream.text !== null
          ? h(
              "div",
              { style: S.panel },
              h("div", { style: S.panelHead }, h("span", null, "反思摘要")),
              h("pre", { style: S.dreamPre }, dream.text),
            )
          : null,
      );

      const fileBlock = h(
        "div",
        { style: S.block },
        h("h3", { style: S.h3 }, "自我文件"),
        files.length === 0
          ? h("div", { style: S.muted }, loading ? "读取中…" : "（没有自我文件）")
          : h("div", { style: S.cards }, files.map(renderCard)),
      );

      const candidateBlock = h(
        "div",
        { style: S.block },
        h(
          "h3",
          { style: S.h3 },
          "候选 " + num(candidates.total) + " 条 / 够格 " + num(candidates.eligible) + " 条",
        ),
        candidateRows.length === 0
          ? h("div", { style: S.muted }, "还没有重复出现过的观察。")
          : h(
              "div",
              null,
              candidateRows.map((row, index) =>
                h(
                  "div",
                  { key: "cand-" + index, style: S.candRow },
                  h(
                    "div",
                    { style: S.candLine },
                    (isEligible(row) ? "✅ " : "") +
                      num(row.count) +
                      "次/" +
                      (Array.isArray(row.days) ? row.days.length : 0) +
                      "天 · " +
                      String(row.text || ""),
                  ),
                  h(
                    "div",
                    { style: S.evidence },
                    Array.isArray(row.evidence) && row.evidence.length > 0 ? row.evidence.join("，") : "无证据",
                  ),
                ),
              ),
            ),
      );

      // 记忆区：只管「关于我 / 关于你 / 关于我们」，不含项目记忆
      const memoryBlock = memory
        ? h(
            "div",
            { style: S.block },
            h(
              "div",
              { style: S.headRow },
              h(
                "h3",
                { style: S.h3 },
                "记忆 · 长期 " +
                  num(memory.curatedChars) +
                  "/" +
                  num(memory.curatedBudget) +
                  " 字符 · 日记忆 " +
                  num(memory.entries) +
                  " 条/" +
                  num(memory.days) +
                  " 天",
              ),
              h(
                "button",
                {
                  type: "button",
                  style: memoryBusy || num(memory.promotable) === 0 ? S.btnOff : S.btn,
                  disabled: memoryBusy || num(memory.promotable) === 0,
                  title: num(memory.promotable) === 0 ? "没有够格的：日笔记要被召回 ≥" + num(memory.minPromoteHits) + " 次" : "写进 MEMORY.md",
                  onClick: onPromoteMemory,
                },
                memoryBusy ? "升格中…" : "升格 " + num(memory.promotable) + " 条",
              ),
            ),
            h("div", { style: S.muted }, "只记关于我 / 关于你 / 关于我们；项目、代码、环境不归这里。"),
            ratings
              ? h(
                  "div",
                  { style: S.muted },
                  "人类评分：" +
                    num(ratings.samples) +
                    " 条｜权重 " +
                    (ratings.weight === null || ratings.weight === undefined ? "—" : Number(ratings.weight).toFixed(2)) +
                    "｜写入闸门 " +
                    (ratings.gate && ratings.gate.allow === false ? "拒绝" : "允许，单次 ≤" + num(ratings.gate && ratings.gate.maxDelta)),
                )
              : null,
            memoryNote
              ? h("div", { style: memoryNote.tone === "error" ? S.danger : memoryNote.tone === "ok" ? S.okText : S.muted }, memoryNote.text)
              : null,
            Array.isArray(memory.promotableRows) && memory.promotableRows.length > 0
              ? h(
                  "div",
                  { style: { marginTop: "8px" } },
                  memory.promotableRows.map((row, index) =>
                    h(
                      "div",
                      { key: "mem-p-" + index, style: S.candRow },
                      h("div", { style: S.candLine }, "✅ 命中 " + num(row.hits) + " 次 · " + String(row.text || "")),
                      h("div", { style: S.evidence }, String(row.key || "")),
                    ),
                  ),
                )
              : null,
            Array.isArray(memory.recent) && memory.recent.length > 0
              ? h(
                  "div",
                  { style: { marginTop: "8px" } },
                  h("div", { style: S.muted }, "最近记的："),
                  memory.recent.map((row, index) =>
                    h(
                      "div",
                      { key: "mem-r-" + index, style: S.evidence },
                      String(row.day || "") + " [" + String(row.kind || "") + "] " + String(row.text || "").slice(0, 90),
                    ),
                  ),
                )
              : h("div", { style: S.muted }, "还没记过：让它 soul_remember 记「他说过什么 / 我答应过什么」。"),
          )
        : null;

      const commitBlock = h(
        "div",
        { style: S.block },
        h("h3", { style: S.h3 }, "最近提交"),
        commits.length === 0
          ? h("div", { style: S.muted }, "还没有提交。")
          : h(
              "div",
              null,
              commits.map((commit, index) =>
                h(
                  "button",
                  {
                    key: String(commit.sha || index),
                    type: "button",
                    style: diffView !== null && diffView.sha === commit.sha ? S.commitOn : S.commitRow,
                    onClick: () => openDiff(commit),
                    title: "看这个文件当前的 git diff",
                  },
                  h("span", { style: S.mono }, String(commit.sha || "").slice(0, 7)),
                  h("span", { style: S.commitDate }, String(commit.date || "")),
                  h("span", { style: S.commitSubject }, String(commit.subject || "")),
                ),
              ),
            ),
        diffView !== null ? renderDiff() : null,
      );

      return h("div", { style: S.root }, header, fileBlock, memoryBlock, candidateBlock, commitBlock);
    }

    /**
     * 注册「人格」tab。
     *
     * 两处都单独 try/catch：注册抛错会让 DSH 把 web 判成 failed，
     * 一个 tab 不该拖垮整个客户端。
     */
    /**
     * 消息操作栏里的评分控件（👍 / 😑 / 👎）。
     *
     * 挂在 conversation.chat.assistant-actions 槽位（官方 👍👎 也在同一槽，order 10）；
     * 每轮结束时最后一条 assistant 消息下面会渲染一次 → 天然「每轮都能打分」。
     * 分数交给后端算权重，权重决定人格文件能不能写入。
     */
    function SoulRatingActions(props) {
      const messageId = props && props.messageId ? String(props.messageId) : "";
      const sessionId = props && props.sessionId ? String(props.sessionId) : "";
      const [mine, setMine] = React.useState(null);
      const [weight, setWeight] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [err, setErr] = React.useState(null);
      const [note, setNote] = React.useState("");

      React.useEffect(() => {
        let alive = true;
        call(API + "/ratings").then((result) => {
          if (!alive || !result.ok) return;
          const data = result.data || {};
          setWeight(data.weight === null || data.weight === undefined ? null : data.weight);
          const hit = Array.isArray(data.recent)
            ? data.recent.find((r) => r && String(r.messageId || "") === messageId)
            : null;
          if (hit) {
            setMine(hit.score);
            setNote(typeof hit.note === "string" ? hit.note : "");
          }
        });
        return () => {
          alive = false;
        };
      }, [messageId]);

      // 统一提交：评分 + 备注
      const send = async (score, text) => {
        if (busy || !messageId) return;
        setBusy(true);
        setErr(null);
        const result = await postJson(API + "/rating", {
          sessionId,
          messageId,
          score,
          note: text,
        });
        setBusy(false);
        if (!result.ok) {
          setErr(result.message);
          return;
        }
        const data = result.data || {};
        setMine(score === 0 ? null : score);
        if (data.window && data.window.weight !== null && data.window.weight !== undefined) setWeight(data.window.weight);
      };

      // 点表情 = 立即打分（带当前备注）；再点一次同一档 = 取消评分
      const choose = (score) => send(mine === score ? 0 : score, note);

      // 只保存备注，不动评分
      const saveNote = () => send(mine === null ? 0 : mine, note);

      const btn = (score, glyph, label) =>
        h(
          "button",
          {
            type: "button",
            key: "r" + score,
            "data-soul-emo": "",
            "data-soul-on": mine === score ? "1" : undefined,
            style: mine === score ? S.ratingBtnOn : S.ratingBtn,
            title: label + (busy ? "（提交中…）" : ""),
            disabled: busy,
            onClick: (event) => {
              event.stopPropagation();
              choose(score);
            },
          },
          glyph,
        );

      // 输入框恒定可见：
      //   · 只点表情不打字 → 纯打分
      //   · 打字不点表情 → 点「保存」只写备注，不动评分
      //   · 打字 + 点表情 → 一次带上评分与备注
      return h(
        "span",
        { style: S.ratingRow, "data-soul-rating": "", title: "给这轮打分：影响人格记忆要不要写入" },
        btn(-1, "👎", "这次不好"),
        btn(0, "😑", "一般"),
        btn(1, "👍", "这次很好"),
        weight === null ? null : h("span", { style: S.ratingW }, "w" + Number(weight).toFixed(2)),
        h("input", {
          style: S.ratingInput,
          type: "text",
          value: note,
          placeholder: "备注（选填）",
          disabled: busy,
          title: "写点什么再点表情，会连同评分一起存；只写不点表情则点右侧「保存」",
          onClick: (event) => event.stopPropagation(),
          onChange: (event) => setNote(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveNote();
            }
          },
        }),
        h(
          "button",
          {
            type: "button",
            style: S.ratingBtnSm,
            disabled: busy,
            title: "只保存备注（不影响已打的评分）",
            onClick: (event) => {
              event.stopPropagation();
              saveNote();
            },
          },
          busy ? "…" : "保存",
        ),
        err ? h("span", { style: S.ratingErr }, err) : null,
      );
    }

    function apply(ctx) {
      // 把评分行推到操作栏最右。
      // 官方 MessageIconActions 把 slot 的 extraActions 固定插在「复制」和「分支」之间，
      // 槽位注册的 order 完全管不到那个位置；只有 .ppByMG_actions（flex 容器）的
      // CSS order 能改视觉顺序。两条选择器分别覆盖「直接子元素」和「renderSlot 多包一层」。
      try {
        const CSS_ID = "soul/rating-order.css";
        if (
          typeof document !== "undefined" &&
          !document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)
        ) {
          const style = document.createElement("style");
          style.dataset.plugin = "dsh-plugin-soul";
          style.dataset.pluginCss = CSS_ID;
          style.textContent =
            ".ppByMG_actions > [data-soul-rating],.ppByMG_actions > :has(> [data-soul-rating]){order:9999}" +
            // 单行对话框与操作栏同高，不需要放开高度；只保证它不从中间把行撑歪
            "[data-soul-rating] > [data-soul-dialog]{align-self:center}" +
            // hover 预览 active 态：未选中的表情在悬停时提亮、去灰、描边、加底色
            // （按钮的灰/透明度是 inline style，必须 !important 才盖得住）
            "[data-soul-emo]:hover:not(:disabled):not([data-soul-on])" +
            "{opacity:1!important;filter:none!important;color:var(--dsw-alias-label-primary,#e8e8e8)!important;" +
            "border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.22))!important;" +
            "background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08)))!important}" +
            // 已选中的再 hover：加深一点，表示点一下会取消
            "[data-soul-emo][data-soul-on]:hover:not(:disabled)" +
            "{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.14))!important}" +
            "[data-soul-emo]:active:not(:disabled){transform:scale(.92)}";
          document.head.appendChild(style);
        }
      } catch (err) {
        console.warn("[soul] 注入评分行顺序样式失败：", err);
      }

      try {
        ctx.slots.inject("settings.section", () => {
          try {
            return ctx.slots.register(
              {
                name: "settings.section",
                id: "soul",
                order: 25,
                label: () => "人格",
              },
              SoulSection,
            );
          } catch (err) {
            console.warn("[soul] 注册 settings.section 失败：", err);
            return null;
          }
        });
      } catch (err) {
        console.warn("[soul] 注入 settings.section 失败：", err);
      }

      // 消息操作栏评分：每轮结束的 assistant 消息下出现，分数决定人格文件能不能写
      try {
        ctx.slots.inject("conversation.chat.assistant-actions", () => {
          try {
            return ctx.slots.register(
              {
                name: "conversation.chat.assistant-actions",
                id: "soul-rating",
                // 排到操作栏最右：官方反馈 order=10、上下文跳转 order=20，
                // 用量/时间由更晚的槽位渲染，所以这里给一个远大于它们的值。
                order: 1000,
                inject: (sessionId) => ({ sessionId }),
              },
              SoulRatingActions,
            );
          } catch (err) {
            console.warn("[soul] 注册评分控件失败：", err);
            return null;
          }
        });
      } catch (err) {
        console.warn("[soul] 注入评分控件失败：", err);
      }
    }

    exports.name = "soul-client";
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
