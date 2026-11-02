// First-party mechanical migration: only JSX display text/labels, never event logic or API values.
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
const files = fs.readdirSync('src', { recursive: true }).filter(f => f.endsWith('.tsx') && !/i18n|main.tsx|AppProvider.tsx|ErrorBoundary|Icon.tsx|CountryFlag|RouteTransition/.test(f));
const keys = new Set();
for (const relative of files) {
  const file = path.join('src', relative), source = fs.readFileSync(file, 'utf8');
  if (source.includes('useTranslation')) continue;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), edits = [];
  const add = (start, end, text) => edits.push({ start, end, text });
  const collect = node => { if (ts.isStringLiteral(node) && /[A-Za-z]/.test(node.text)) keys.add(node.text); ts.forEachChild(node, collect); };
  collect(tree);
  let changed = false;
  function visit(node, component = false) {
    if (ts.isFunctionDeclaration(node) && node.parent === tree) {
      let hasJsx = false;
      const find = n => { if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) hasJsx = true; ts.forEachChild(n, find); };
      find(node);
      if (hasJsx && node.body) { add(node.body.getStart(tree) + 1, node.body.getStart(tree) + 1, '\n  const t = useTranslation();'); component = true; changed = true; }
    }
    if (component && ts.isJsxText(node)) {
      const text = node.getText(tree).replace(/\s+/g, ' ').trim();
      if (text && /[A-Za-z]/.test(text)) { keys.add(text); add(node.getStart(tree), node.end, `{t(${JSON.stringify(text)})}`); }
    }
    if (component && ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      add(node.expression.getStart(tree), node.expression.getStart(tree), 't('); add(node.expression.end, node.expression.end, ')');
    }
    if (component && ts.isJsxAttribute(node) && ['aria-label', 'placeholder', 'title', 'label', 'kicker'].includes(node.name.getText(tree)) && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) add(node.initializer.getStart(tree), node.initializer.end, `{t(${JSON.stringify(node.initializer.text)})}`);
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) { const e = node.initializer.expression; add(e.getStart(tree), e.getStart(tree), 't('); add(e.end, e.end, ')'); }
    }
    ts.forEachChild(node, n => visit(n, component));
  }
  visit(tree);
  if (changed && process.argv.includes('--write')) {
    edits.sort((a,b) => b.start-a.start || b.end-a.end);
    let output = source; for (const e of edits) output = output.slice(0,e.start)+e.text+output.slice(e.end);
    let importPath = path.relative(path.dirname(file), 'src/shared/i18n/I18n').replaceAll(path.sep, '/'); if (!importPath.startsWith('.')) importPath = './'+importPath;
    fs.writeFileSync(file, `import { useTranslation } from '${importPath}';\n`+output);
  }
}
console.log(JSON.stringify([...keys].filter(k => /\s/.test(k) || /^[A-Z][a-z]+$/.test(k)).filter(k => !/^\.\.\//.test(k)).sort(), null, 2));
