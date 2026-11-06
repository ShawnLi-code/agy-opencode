/**
 * Prints the field lists of Provider.Info, Model.Info and Credential so the
 * registration code can be written against the real shape.
 *
 * Run: node scripts/schema-keys.mjs
 */
const provider = await import("@opencode/schema/provider");
const model = await import("@opencode/schema/model");
const credential = await import("@opencode/schema/credential");

function fieldsOf(schema) {
  const s = schema ?? {};
  const fields = s.fields ?? s.ast?.propertySignatures ? null : null;
  if (s.fields) return Object.keys(s.fields);
  // Effect Schema sometimes exposes the AST instead.
  const props = s.ast?.propertySignatures;
  if (Array.isArray(props)) return props.map((p) => String(p.name)).filter((n) => !n.startsWith("~"));
  return null;
}

console.log("=== provider module exports ===");
console.log(Object.keys(provider).join(", "));

console.log("\n=== Provider.Info fields ===");
console.log(JSON.stringify(fieldsOf(provider.Info), null, 1));

console.log("\n=== Provider.Info field details ===");
const infoFields = provider.Info?.fields ?? {};
for (const [k, v] of Object.entries(infoFields)) {
  const optional = String(v?.ast?._tag ?? v?.ast?.tag ?? "");
  console.log(` ${k}  ${optional}`);
}

console.log("\n=== Model.Info fields ===");
console.log(JSON.stringify(fieldsOf(model.Info), null, 1));

console.log("\n=== Credential exports ===");
console.log(Object.keys(credential).join(", "));
console.log("\n=== Credential.Info fields ===");
console.log(JSON.stringify(fieldsOf(credential.Info), null, 1));
