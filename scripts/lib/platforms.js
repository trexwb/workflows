#!/usr/bin/env node
/**
 * 宿主安装位置定义 —— 供 install.js 与 version.js 共用，避免两处路径表漂移。
 * 零 npm 依赖，Node >= 18。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_NAME = 'agent-pipeline';
const CORE_PLATFORMS = ['workbuddy', 'codebuddy', 'zcode', 'marvis', 'qoder'];

/**
 * user：相对 HOME 的候选目录；detect 为判断该宿主是否安装的标记目录（相对 HOME）。
 * project：相对项目根的候选目录（Marvis 无项目级）。
 */
const PLATFORMS = {
  workbuddy: {
    label: 'WorkBuddy',
    user: [{ dir: '.workbuddy/skills', detect: '.workbuddy' }],
    project: ['.workbuddy/skills'],
  },
  codebuddy: {
    label: 'CodeBuddy',
    user: [{ dir: '.codebuddy/skills', detect: '.codebuddy' }],
    project: ['.codebuddy/skills'],
  },
  zcode: {
    label: 'zCode',
    user: [{ dir: '.zcode/skills', detect: '.zcode' }],
    project: ['.zcode/skills'],
  },
  marvis: {
    label: 'Marvis',
    // Marvis 自建 skill 只发现 skills/custom/，skills/market/ 留给市场包
    user: [{ dir: '.marvis/skills/custom', detect: '.marvis' }],
    project: [],
  },
  qoder: {
    label: 'Qoder',
    // 国内版配置目录为 ~/.qoder-cn，国际版为 ~/.qoder
    user: [
      { dir: '.qoder/skills', detect: '.qoder' },
      { dir: '.qoder-cn/skills', detect: '.qoder-cn' },
    ],
    project: ['.qoder/skills'],
  },
  common: {
    label: '通用 .agents（zCode / Codex / Cursor 等）',
    user: [{ dir: '.agents/skills', detect: '.agents' }],
    project: ['.agents/skills'],
  },
};

// 复制安装时排除：版本库、运行时产物、本机垃圾文件、宿主配置残留
const EXCLUDE = new Set([
  '.git', '.gitignore', '.DS_Store', 'Thumbs.db', 'node_modules',
  'artifacts', 'logs', 'data', 'dist', '.confirm-state.json', '.req-state.json',
  '.agents', '.claude', '.codebuddy', '.workbuddy', '.zcode', '.qoder', '.qoder-cn', '.marvis',
]);

function detectedPlatforms(home) {
  const h = home || os.homedir();
  return Object.keys(PLATFORMS).filter((k) => PLATFORMS[k].user.some((u) =>
    fs.existsSync(path.join(h, u.detect))));
}

/** 枚举所有可能的用户级安装位置（含未检测到的候选），用于版本盘点。 */
function userTargets(home) {
  const h = home || os.homedir();
  const out = [];
  for (const [key, def] of Object.entries(PLATFORMS)) {
    for (const u of def.user) {
      out.push({ platform: key, label: def.label, scope: 'user', dir: path.join(h, u.dir, SKILL_NAME) });
    }
  }
  return out;
}

/** 枚举所有可能的项目级安装位置，用于版本盘点。 */
function projectTargets(projectRoot) {
  const r = projectRoot || process.cwd();
  const out = [];
  for (const [key, def] of Object.entries(PLATFORMS)) {
    for (const p of def.project) {
      out.push({ platform: key, label: def.label, scope: 'project', dir: path.join(r, p, SKILL_NAME) });
    }
  }
  return out;
}

module.exports = {
  SKILL_NAME, CORE_PLATFORMS, PLATFORMS, EXCLUDE,
  detectedPlatforms, userTargets, projectTargets,
};
