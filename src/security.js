'use strict';
/**
 * security.js
 *
 * The project root is the hard filesystem boundary. Every tool that touches
 * the filesystem must resolve paths through resolveInProject() so that:
 *  - relative traversal ("../../etc/passwd") is rejected
 *  - absolute paths outside the root are rejected
 *  - symlinks that point outside the root are rejected (checked via
 *    realpath on the resolved path's existing ancestor)
 */

const path = require('path');
const fs = require('fs');

class PathSecurityError extends Error {}

function resolveInProject(projectRoot, relPath) {
  if (typeof relPath !== 'string') {
    throw new PathSecurityError('Path must be a string');
  }
  const rootReal = fs.realpathSync(projectRoot);
  const candidate = path.resolve(rootReal, relPath);

  if (candidate !== rootReal && !candidate.startsWith(rootReal + path.sep)) {
    throw new PathSecurityError(`Path escapes project root: ${relPath}`);
  }

  // Resolve symlinks on the deepest existing ancestor to catch symlink escapes,
  // without requiring the final path itself to exist (e.g. write_file targets).
  let existing = candidate;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (fs.existsSync(existing)) {
    const existingReal = fs.realpathSync(existing);
    if (existingReal !== rootReal && !existingReal.startsWith(rootReal + path.sep)) {
      throw new PathSecurityError(`Path escapes project root via symlink: ${relPath}`);
    }
  }

  return candidate;
}

module.exports = { resolveInProject, PathSecurityError };
