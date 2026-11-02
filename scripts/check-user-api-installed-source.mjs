// First-party, standard-library-only verifier. Never imports/executes vendor PHP.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const review = JSON.parse(fs.readFileSync('.security-review/user-api-upgrade-lock-review.json'));
const planning = process.argv.includes('--plan');
const root = planning ? '.security-review/user-api-upgrade-resolution' : '.security-review/user-api';
const lock = JSON.parse(fs.readFileSync(path.join(root, 'composer.lock')));
const packages = [...lock.packages.map(p => ({...p, dev:false})), ...lock['packages-dev'].map(p => ({...p, dev:true}))];
const entries = packages.map(p => ({name:p.name,version:p.version,source:p.source,dist:p.dist,dev:p.dev}))
    .sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const graphSha256 = hash(JSON.stringify({packages:entries}));
const approvedGraph = 'd0b1ad86c56812768951242f29c2840b682e743cd7ebdc795e1406970b505621';
if (graphSha256 !== approvedGraph) throw Error('Exact reviewed package graph changed: STOP before execution.');
if (review.errors.length || packages.length !== 117) throw Error('Incomplete source review.');
if (planning) {
    console.log(JSON.stringify({mode:'metadata-only',graphSha256,packages:packages.length,vendorExecuted:false}));
    process.exit(0);
}
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
}
const failures = [];
const artifactChecks = [];
let sourceFiles = 0;
for (const pkg of packages) {
    const expected = review.packages.find(p => p.name === pkg.name && p.source.reference === pkg.source.reference);
    if (!expected) { failures.push({package:pkg.name,error:'No matching reviewed source'}); continue; }
    const directory = path.resolve(root, 'vendor', pkg.name);
    try {
        if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Unexpected package symlink');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'composer.json')));
        if (JSON.stringify(canonical(manifest)) !== JSON.stringify(canonical(expected.manifest))) {
            failures.push({package:pkg.name,error:'Installed manifest differs from reviewed upstream source'});
        }
        // This exact official Pint archive export-ignores /app. It distributes
        // a PHAR instead; compare its Git object against the pinned upstream
        // tree. This verifies provenance, not PHAR safety. Never execute Pint.
        const pintArchive = pkg.name === 'laravel/pint'
            && pkg.source.reference === 'a19bd99c91b158f33a4c5ffe9653d17a921424de';
        if (pintArchive) {
            const binaryPath = path.join(directory, 'builds/pint');
            if (fs.lstatSync(binaryPath).isSymbolicLink()) throw Error('Unexpected Pint PHAR symlink');
            const binary = fs.readFileSync(binaryPath);
            const gitBlob = crypto.createHash('sha1').update(Buffer.from(`blob ${binary.length}\0`)).update(binary).digest('hex');
            const expectedBlob = '6ebe64321f0a653083dec00244d21b564e0dce87';
            artifactChecks.push({package:pkg.name,path:'builds/pint',gitBlob,expectedBlob,sha256:hash(binary),executed:false});
            if (gitBlob !== expectedBlob) throw Error('Pint archive blob differs from pinned official tree');
        }
        for (const file of expected.files.filter(f => typeof f.source === 'string')) {
            if (pintArchive && file.path.startsWith('app/')) continue;
            const target = path.resolve(directory, file.path);
            if (!target.startsWith(directory + path.sep)) throw Error('Unsafe reviewed source path');
            let component = directory;
            for (const segment of file.path.split('/')) {
                component = path.join(component, segment);
                if (fs.lstatSync(component).isSymbolicLink()) throw Error('Unexpected source symlink');
            }
            const actual = fs.readFileSync(target);
            if (hash(actual) !== hash(file.source)) failures.push({package:pkg.name,path:file.path,error:'Source content mismatch'});
            sourceFiles++;
        }
    } catch (error) { failures.push({package:pkg.name,error:error.message}); }
}
const result = {date:new Date().toISOString(),graphSha256,packages:packages.length,sourceFiles,artifactChecks,failures,
    limitation:'Manifest/autoload/representative-file check only; not complete artifact or binary certification',vendorExecuted:false};
fs.writeFileSync('.security-review/user-api-installed-source-verification.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
if (failures.length) process.exitCode = 1;
