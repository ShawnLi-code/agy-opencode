/** Dumps Integration / Provider field lists for the desktop picker wiring. */
const integration = await import("@opencode/schema/integration");
const provider = await import("@opencode/schema/provider");

const keys = (m) => Object.keys(m).join(", ");
console.log("integration exports:", keys(integration));
console.log("provider exports:", keys(provider));

const fields = (s) => (s?.fields ? Object.keys(s.fields) : null);
console.log("\nIntegration.Info fields:", JSON.stringify(fields(integration.Info), null, 1));

// Union members of the fields that matter.
function variants(schema) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n._tag === "Union") return (n.types ?? []).forEach(walk);
    if (n._tag === "Literal") return out.push(JSON.stringify(n.literal));
    if (n._tag === "StringKeyword") return out.push("string");
    if (n._tag === "NumberKeyword") return out.push("number");
    if (n._tag === "BooleanKeyword") return out.push("boolean");
    if (n._tag === "TypeLiteral") return out.push("object{" + (n.propertySignatures ?? []).map((p) => String(p.name)).join(",") + "}");
    out.push(n._tag ?? "?");
  };
  walk(schema?.ast ?? schema);
  return out;
}

for (const [name, schema] of Object.entries(integration.Info?.fields ?? {})) {
  console.log(`  ${name}: ${JSON.stringify(variants(schema))}`);
}
