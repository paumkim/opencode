import ts from "typescript"

// Evaluate the complete production module with per-fixture lexical boundaries.
// Unlike mock.module, these fakes cannot poison another Bun test's module cache.
// This is not an integration test of module resolution, OAuth, or Solid's runtime.
export async function loadModule<T>(path: URL, bindings: Record<string, unknown>, dev = false): Promise<T> {
  const source = await Bun.file(path).text()
  const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true)
  const imports = ast.statements.filter(ts.isImportDeclaration)
  for (const node of imports) {
    const clause = node.importClause
    if (!clause || clause.isTypeOnly) continue
    const names = [
      ...(clause.name ? [clause.name.text] : []),
      ...(clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.filter((item) => !item.isTypeOnly).map((item) => item.name.text)
        : []),
    ]
    for (const name of names) {
      if (!(name in bindings)) throw new Error(`Missing isolated import: ${name} in ${path.pathname}`)
    }
  }
  const body = imports.reduceRight((text, node) => text.slice(0, node.pos) + text.slice(node.end), source)
  const compiled = ts.transpileModule(
    body
      .replaceAll("import.meta.env.DEV", String(dev))
      .replaceAll("import.meta.env.VITE_AUTH_URL", '"https://auth.example.test"'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText
  const exports: Record<string, unknown> = {}
  new Function("exports", ...Object.keys(bindings), compiled)(exports, ...Object.values(bindings))
  return exports as T
}
