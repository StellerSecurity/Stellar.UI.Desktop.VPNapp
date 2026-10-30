import ts from 'typescript';
import fs from 'node:fs';
const source = ['messages','details','onboarding','accessibility','errors','notices','connection'].filter(name=>fs.existsSync(`src/shared/i18n/${name}.ts`)).map(name=>fs.readFileSync(`src/shared/i18n/${name}.ts`,'utf8')).join('\n');
const known = new Set(source.split('\n').filter(line=>line.includes('|')).map(line=>line.split('|')[0]));
const candidates = new Set();
for (const file of fs.readdirSync('src',{recursive:true}).filter(f=>f.endsWith('.tsx')&&!f.includes('i18n'))) {
 const root=ts.createSourceFile(file,fs.readFileSync('src/'+file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 function visit(n) {
  if(ts.isStringLiteral(n) && (/^[A-Z][A-Za-z]+(?: [A-Za-z].*)?[.!?…]?$/.test(n.text)||/^✓ /.test(n.text)) && !known.has(n.text)&&!n.text.includes('/')) candidates.add(n.text);
  ts.forEachChild(n,visit);
 } visit(root);
}
console.log([...candidates].sort().join('\n'));
