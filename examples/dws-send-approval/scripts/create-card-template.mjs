import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source =
  process.argv[2] || resolve(root, "../../docs/assets/dingtalk-ask-user-card-template.json");
const outer = JSON.parse(readFileSync(source, "utf8")),
  editor = JSON.parse(outer.editorData);
const tree = editor.schema.componentsTree[0];
function find(node, name) {
  if (node.componentName === name) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = find(child, name);
    if (found) {
      return found;
    }
  }
}
const form = find(tree, "Form"),
  text = find(tree, "BaseText"),
  original = find(form, "SingleButton");
text.props.text.content = "${description}";
text.props.maxLine.value = 500;

function replace(value) {
  if (typeof value === "string") {
    return value.replaceAll("question_title", "title").replaceAll("question_desc", "description");
  }
  if (Array.isArray(value)) {
    return value.map(replace);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
  }
  return value;
}
editor.schema = replace(editor.schema);
const actual = editor.schema.componentsTree[0];
actual.props.enableClickEvent = false;
actual.props.events = [];
delete actual.props.actionType;
const actualForm = find(actual, "Form");
actualForm.children = Array.from({ length: 6 }, (_, index) => {
  const n = index + 1,
    b = structuredClone(original);
  b.id = `dws_assistant_button_${n}`;
  b.props.text.content = `\${button${n}}`;
  b.props.disabledWhileForward = true;
  b.props.actionType = "eventChain";
  b.props.events = [
    {
      event: {
        actionType: "request",
        actionId: { i18n: false, type: "dynamicString", content: `\${action${n}}` },
        params: [
          {
            type: "fixed",
            variable: "",
            value: "form_update",
            name: "form",
            variableType: "global",
            id: "1",
          },
        ],
      },
      callbacks: { success: {}, failure: {} },
    },
  ];
  b.props.visible = {
    type: "dynamicVisible",
    value: true,
    valueType: "condition",
    condition: {
      op: "and",
      conditions: [
        {
          value: "",
          op: "isTrue",
          variable: `show_button_${n}`,
          variableType: "global",
          type: "variable",
          valueType: "fixed",
          valueVariableType: "global",
        },
      ],
    },
  };
  return b;
});
editor.variableList = editor.variableList.filter(
  (x) => !["question_id", "question_title", "question_desc"].includes(x.name),
);
for (const name of [
  "title",
  "description",
  ...Array.from({ length: 6 }, (_, i) => [`button${i + 1}`, `action${i + 1}`]).flat(),
]) {
  editor.variableList.push({
    name,
    id: name,
    type: "string",
    private: false,
    editorVarType: "variables",
  });
}
for (let n = 1; n <= 6; n++) {
  editor.expList.push({
    name: `show_button_${n}`,
    id: `show_button_${n}`,
    type: "boolean",
    private: false,
    editorVarType: "expList",
    expContent: `card_status == 'pending' && button${n} != ''`,
  });
}
editor.useCustomWidgetInfo = false;
editor.customWidgetInfo = "";
editor.extension.fileTypeList = [];
editor.mockData = {
  cardPrivateData: {},
  localData: {},
  richTextData: {},
  cardData: {
    title: "我的代回复助手",
    description: "待处理 3 条。点击查看草稿，或配置监听范围。",
    card_status: "pending",
    form: { fields: [] },
    button1: "查看待回复",
    button2: "监听范围",
    button3: "回复方式",
    button4: "自动答复与提醒",
    button5: "处理记录",
    button6: "开启监听",
  },
};
const out = { editorData: JSON.stringify(editor), widgetInfo: "", type: "im", mode: "card" };
mkdirSync(resolve(root, "templates"), { recursive: true });
writeFileSync(
  resolve(root, "templates/dws-reply-assistant-card.json"),
  JSON.stringify(out, null, 2) + "\n",
);
