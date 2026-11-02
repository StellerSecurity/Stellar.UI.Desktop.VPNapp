// First-party metadata guard. Does not import PHP code, install, deploy or approve anything.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

export function checkStagingLock(original, proposed, candidates, approvedSettings = {}) {
  const allowed = new Map(candidates.map(p => [p.name, p]));
  const errors = [];
  const originalPackages = new Map([...original.packages, ...original['packages-dev']].map(p => [p.name, p]));
  const proposedPackages = new Map([...proposed.packages, ...proposed['packages-dev']].map(p => [p.name, p]));
  for (const section of ['packages', 'packages-dev']) {
    const beforeNames = original[section].map(p => p.name).sort();
    const afterNames = proposed[section].map(p => p.name).sort();
    if (JSON.stringify(beforeNames) !== JSON.stringify(afterNames)) errors.push(`Package membership changed: ${section}`);
  }
  if (originalPackages.size !== proposedPackages.size) errors.push('Package count changed');
  for (const [name, previous] of originalPackages) {
    const next = proposedPackages.get(name);
    if (!next) { errors.push(`Missing package: ${name}`); continue; }
    const candidate = allowed.get(name);
    if (!candidate) {
      if (JSON.stringify(next) !== JSON.stringify(previous)) errors.push(`Unapproved change: ${name}`);
      continue;
    }
    if (next.version !== candidate.version) errors.push(`Unapproved version: ${name}`);
    if (next.source?.url !== candidate.repository || next.source?.reference !== candidate.reference) {
      errors.push(`Source mismatch: ${name}`);
    }
    const expectedArchive = candidate.repository.replace('https://github.com/', 'https://api.github.com/repos/').replace(/\.git$/, '') + '/zipball/' + candidate.reference;
    if (next.dist?.type !== 'zip' || next.dist?.reference !== candidate.reference || next.dist?.url !== expectedArchive) {
      errors.push(`Archive metadata mismatch: ${name}`);
    }
    if (next.type === 'composer-plugin' || next.type === 'composer-installer') errors.push(`Executable plugin type: ${name}`);
    if ((next.autoload?.files?.length || 0) > (previous.autoload?.files?.length || 0)) {
      errors.push(`New auto-executed files need review: ${name}`);
    }
  }
  for (const name of proposedPackages.keys()) if (!originalPackages.has(name)) errors.push(`New package: ${name}`);
  for (const [name] of allowed) if (!proposedPackages.has(name)) errors.push(`Candidate missing: ${name}`);
  for (const key of new Set([...Object.keys(original), ...Object.keys(proposed)])) {
    if (['packages', 'packages-dev', '_readme', 'content-hash'].includes(key)) continue;
    const exception = approvedSettings[key];
    if (exception && JSON.stringify(original[key]) === JSON.stringify(exception.before)
      && JSON.stringify(proposed[key]) === JSON.stringify(exception.after)) continue;
    if (JSON.stringify(original[key]) !== JSON.stringify(proposed[key])) errors.push(`Unapproved lock setting: ${key}`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [originalPath, proposedPath] = process.argv.slice(2);
  if (!originalPath || !proposedPath) throw new Error('Usage: node scripts/check-staging-lock.mjs ORIGINAL PROPOSED');
  const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));
  const policy = read('.security-review/laravel-approved-candidates.pending.json');
  const errors = checkStagingLock(read(originalPath), read(proposedPath), policy.packages, policy.approvedSettings);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Only the ${policy.packages.length} expected package changes and explicitly approved metadata found. This is NOT install or deployment approval.`);
}
