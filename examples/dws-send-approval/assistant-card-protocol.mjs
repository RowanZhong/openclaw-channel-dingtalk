// DingTalk SELECT defaults carry both indexes and values. Keep view state plain.
export function cardFormFields(fields) {
  return fields.map((field) => {
    if (!field.options || !Object.hasOwn(field, "defaultValue")) return field;
    if (field.type === "SELECT") {
      const index = field.options.findIndex((option) => option.value === field.defaultValue);
      const { defaultValue, ...rest } = field;
      return index < 0 ? rest : { ...rest, defaultValue: { index, value: defaultValue } };
    }
    if (field.type === "MULTI_SELECT") {
      const values = new Set(Array.isArray(field.defaultValue) ? field.defaultValue : []);
      const selected = field.options
        .map((option, index) => ({ ...option, index }))
        .filter((option) => values.has(option.value));
      return {
        ...field,
        defaultValue: {
          index: selected.map((option) => option.index),
          value: selected.map((option) => option.value),
        },
      };
    }
    return field;
  });
}
