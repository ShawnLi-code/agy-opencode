/** Dumps the Activation / Settings / Package unions so registration matches. */
const provider = await import("@opencode/schema/provider");

function unionOf(schema) {
  const ast = schema?.ast ?? schema;
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n._tag === "Union") {
      for (const t of n.types ?? []) walk(t);
      return;
    }
    if (n._tag === "Literal") {
      out.push(JSON.stringify(n.literal));
      return;
    }
    if (n._tag === "StringKeyword") {
      out.push("string");
      return;
    }
    if (n._tag === "Declaration") {
      out.push("decl:" + (n.typeParameters?.length ?? 0) + ":" + (n.annotations?.identifier ?? ""));
      return;
    }
    if (n._tag === "TypeLiteral") {
      out.push("object{" + (n.propertySignatures ?? []).map((p) => String(p.name)).join(",") + "}");
      return;
    }
    out.push(n._tag ?? "?");
  };
  walk(ast);
  return out;
}

console.log("Activation:", JSON.stringify(unionOf(provider.Activation), null, 1));
console.log("\nPackage:", JSON.stringify(unionOf(provider.Package), null, 1));
console.log("\nSettings:", JSON.stringify(unionOf(provider.Settings), null, 1));

const infoFields = provider.Info?.fields ?? {};
for (const key of ["activation", "package", "settings", "compatibility", "canonical"]) {
  const f = infoFields[key];
  if (!f) continue;
  console.log(`\n--- ${key} ---`);
  console.log(JSON.stringify(unionOf(f), null, 1));
  console.log("optional:", String(f.ast?._tag ?? "").includes("Optional") || f?.ast?.context?.isOptional === true);
}
