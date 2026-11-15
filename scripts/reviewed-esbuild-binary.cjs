'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const review = require('../binary-review.json');

module.exports = function reviewedBinaryPath() {
  const filename = process.env.ESBUILD_BINARY_PATH;
  const target = review.targets[`${process.platform}-${process.arch}`];

  if (!target || !filename || !path.isAbsolute(filename)) {
    throw new Error('Build the reviewed esbuild runtime and set ESBUILD_BINARY_PATH to its absolute path.');
  }

  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== target.bytes) {
    throw new Error('The configured esbuild runtime is not the reviewed regular file.');
  }

  const digest = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  if (digest !== target.sha256) {
    throw new Error('The configured esbuild runtime does not match the reviewed source build.');
  }

  return filename;
};
