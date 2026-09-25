const tabs = [
  ["home", "首页"], ["listen", "监听范围"], ["topics", "消息主题"], ["reply", "回复方式"],
  ["draft", "待确认草稿"], ["inbox", "批量处理"],
  ["auto-new", "自动答复"], ["notifications", "提醒"],
];

function render(name) {
  document.getElementById("notice").style.display = "none";
  const view = views[name] || views.home;
  document.getElementById("cardtitle").textContent = view.title;
  document.getElementById("description").textContent = view.description;
  const fields = document.getElementById("fields");
  fields.replaceChildren();
  for (const field of view.fields) {
    const group = document.createElement(field.options ? "fieldset" : "div");
    group.className = "preview-field";
    const title = document.createElement(field.options ? "legend" : "label");
    title.textContent = field.label;
    group.append(title);
    if (field.options) {
      const choices = document.createElement("div");
      choices.className = "choices";
      for (const option of field.options) {
        const choice = document.createElement("label");
        choice.className = "choice";
        const control = document.createElement("input");
        control.type = field.type === "MULTI_CHECKBOX_GROUP" ? "checkbox" : "radio";
        control.name = field.name;
        control.value = option.value;
        control.checked = Array.isArray(field.defaultValue)
          ? field.defaultValue.includes(option.value)
          : field.defaultValue === option.value;
        const caption = document.createElement("span");
        caption.textContent = option.text;
        choice.append(control, caption);
        choices.append(choice);
      }
      group.append(choices);
    } else {
      const control = document.createElement(field.type === "TEXT_AREA" ? "textarea" : "input");
      control.id = `preview-${name}-${field.name}`;
      control.name = field.name;
      control.value = field.defaultValue || "";
      title.htmlFor = control.id;
      group.append(control);
    }
    fields.append(group);
  }
  const actions = document.getElementById("actions");
  actions.replaceChildren();
  view.buttons.forEach((button, index) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = button.label;
    if (index === 0) element.className = "primary";
    element.onclick = () => {
      const route = button.op === "auto-next"
        ? ({ "auto-new": "auto-content", "auto-content": "auto-limits", "auto-limits": "auto-frequency", "auto-frequency": "auto-review" })[name]
        : button.op === "topic-next" ? ({ "topic-new": "topic-definition", "topic-definition": "topic-action", "topic-action": "topic-trial", "topic-trial": "topic-limits", "topic-trial-result": "topic-limits", "topic-limits": "topic-review" })[name]
        : button.op === "topic-test" ? "topic-trial-result"
        : button.op === "topic-open" ? "topic-detail"
        : button.op === "topic-edit" ? "topic-new"
        : button.op === "topic-test-saved" ? "topic-trial"
        : ["auto-back", "topic-back"].includes(button.op) ? button.destination
        : button.op === "load-reply" ? `reply-edit-${button.targetKind}`
        : button.op === "reply-target" ? `reply-target-${button.targetKind}`
        : button.op === "search-directory" ? "search-results"
        : button.op === "open-selected" ? "draft" : button.op;
      if (views[route]) render(route);
      else {
        const notice = document.getElementById("notice");
        notice.style.display = "block";
        notice.textContent = `演示操作：${button.label}。请到钉钉完成真实设置；此处不保存或发送。`;
      }
    };
    actions.append(element);
  });
  document.querySelectorAll("#tabs button").forEach((button) => {
    const active = button.dataset.name === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}
for (const [name, label] of tabs) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.name = name;
  button.onclick = () => render(name);
  document.getElementById("tabs").append(button);
}
render("home");
