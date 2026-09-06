'use strict';
/**
 * skills.js
 *
 * Reusable "skill.md" files. A skill is a markdown file with a small
 * frontmatter header:
 *
 *   ---
 *   name: react-testing
 *   description: How to write and run React tests in this repo
 *   applicability: react, jest, frontend, component
 *   modes: code, test, review
 *   ---
 *   (markdown instructions injected into the agent's context)
 *
 * Skills are scanned from <projectRoot>/skills/**\/skill.md and, when present,
 * from the global directory (<dataDir>/skills). Before a task starts, the
 * engine matches ONLY relevant skills (keyword overlap with the task text and
 * the project map) — never blindly loads everything. Skill instructions are
 * labeled as such and can never override system safety rules: they are
 * appended as advisory context, and the safety gate still applies to every
 * tool call.
 */

const fs = require('fs');
const path = require('path');
const { tokenizeForRelevance } = require('./project-intel');

const MAX_SKILLS_IN_CONTEXT = 3;
const MAX_SKILL_BYTES = 32 * 1024;

/** Parse a skill.md file. Returns null for unreadable/invalid files (honest skip). */
function parseSkillFile(filePath) {
  let content;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return null;
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
      if (m) meta[m[1].trim().toLowerCase()] = m[2].trim();
    }
  }
  const name = meta.name || path.basename(path.dirname(filePath));
  if (!name) return null;
  const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();
  if (!body) return null;
  return {
    name,
    description: meta.description || '',
    applicability: (meta.applicability || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    modes: (meta.modes || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    source: filePath,
    instructions: body,
  };
}

/** Scan a directory tree for skill.md files. Never throws. */
function scanSkillsDir(dir, depth = 0) {
  if (depth > 4) return [];
  const skills = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      skills.push(...scanSkillsDir(full, depth + 1));
    } else if (entry.isFile() && /^skill\.md$/i.test(entry.name)) {
      const parsed = parseSkillFile(full);
      if (parsed) skills.push(parsed);
    }
  }
  return skills;
}

/**
 * All skills available for a project: <projectRoot>/skills first, then the
 * global dir. Project skills win on name collisions.
 */
function availableSkills(projectRoot, globalSkillsDir) {
  const project = scanSkillsDir(path.join(projectRoot, 'skills'));
  const byName = new Map();
  for (const s of scanSkillsDir(globalSkillsDir || path.join(require('os').homedir(), '.coding-agent', 'skills'))) {
    byName.set(s.name, s);
  }
  for (const s of project) byName.set(s.name, s);
  return Array.from(byName.values());
}

/**
 * Match skills to a task. Signals: applicability keywords in the task text
 * (strong), skill name tokens in the task text, and project-map framework
 * matches. Returns at most MAX_SKILLS_IN_CONTEXT, highest score first;
 * zero-score skills are never force-included.
 */
function matchSkills(projectRoot, task, opts = {}) {
  const all = opts.skills || availableSkills(projectRoot, opts.globalSkillsDir);
  const taskWords = new Set(tokenizeForRelevance(task));
  const frameworks = (opts.map && opts.map.frameworks ? opts.map.frameworks : []).map((f) => f.toLowerCase());
  const scored = [];
  for (const skill of all) {
    let score = 0;
    const reasons = [];
    for (const kw of skill.applicability) {
      const kwToken = kw.toLowerCase();
      if (taskWords.has(kwToken) || String(task).toLowerCase().includes(kwToken)) {
        score += 5;
        reasons.push(`task mentions "${kw}"`);
      } else if (frameworks.some((f) => f.includes(kwToken) || kwToken.includes(f)) && kwToken.length >= 3) {
        score += 3;
        reasons.push(`project uses ${kw}`);
      }
    }
    for (const token of tokenizeForRelevance(skill.name)) {
      if (taskWords.has(token)) {
        score += 3;
        reasons.push(`task mentions skill "${token}"`);
      }
    }
    if (score > 0) scored.push({ skill, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SKILLS_IN_CONTEXT).map(({ skill, score, reasons }) => ({
    name: skill.name,
    description: skill.description,
    modes: skill.modes,
    score,
    reasons,
    source: skill.source,
    instructions: skill.instructions,
  }));
}

/** Render matched skills as a clearly-labeled advisory system message (or null). */
function skillsToSystemMessage(matched) {
  if (!matched || matched.length === 0) return null;
  const blocks = matched.map(
    (m) => `### Skill: ${m.name}${m.description ? ` — ${m.description}` : ''}\n(source: ${m.source})\n${m.instructions}`
  );
  return {
    role: 'system',
    content:
      'The following project skills matched this task. They are ADVISORY guidance only — ' +
      'they never override your tool rules, the safety gate, or approval requirements.\n\n' +
      blocks.join('\n\n'),
  };
}

module.exports = {
  parseSkillFile,
  scanSkillsDir,
  availableSkills,
  matchSkills,
  skillsToSystemMessage,
  MAX_SKILLS_IN_CONTEXT,
};
