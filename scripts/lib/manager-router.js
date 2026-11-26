'use strict';

const fs = require('fs');
const path = require('path');

function freshState(projectName, projectDir, pipelineConfigRel, firstStageId, managerConfig) {
  return {
    version: 1,
    projectName,
    projectDir,
    pipelineConfigRel,
    status: 'running',
    current: null,
    resumeStageId: firstStageId,
    nextWorkOrder: null,
    completedStages: {},
    invalidatedOutputs: [],
    rework: {
      maxPerStage: managerConfig.maxReworkRounds,
      maxTotal: managerConfig.maxTotalReworks,
      extraApproved: 0,
      byStage: {},
      total: 0,
    },
    history: [],
    pending: null,
    updatedAt: new Date().toISOString(),
  };
}

function loadState(file, expected) {
  if (!fs.existsSync(file)) return null;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`项目经理状态文件损坏：${error.message}`);
  }
  if (!state || state.version !== 1) throw new Error('项目经理状态文件版本不受支持');
  for (const key of ['projectName', 'projectDir', 'pipelineConfigRel']) {
    if (state[key] !== expected[key]) {
      throw new Error(`项目经理状态与当前运行不匹配：${key}`);
    }
  }
  return state;
}

function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temp, file);
}

function invalidateFrom(state, stages, startIdx) {
  for (const stage of stages.slice(startIdx)) {
    if (!stage.output) continue;
    if (!state.invalidatedOutputs.includes(stage.output)) state.invalidatedOutputs.push(stage.output);
    delete state.completedStages[stage.id];
  }
  state.history.push({
    at: new Date().toISOString(),
    action: 'invalidate',
    stageId: stages[startIdx] && stages[startIdx].id,
    outputs: stages.slice(startIdx).map((stage) => stage.output).filter(Boolean),
  });
}

function clearOutput(state, output) {
  state.invalidatedOutputs = state.invalidatedOutputs.filter((item) => item !== output);
}

function beginStage(state, stage) {
  state.status = 'running';
  state.pending = null;
  state.current = {
    stageId: stage.id,
    stageName: stage.name,
    phase: 'specialist',
    attempt: (state.current && state.current.stageId === stage.id ? state.current.attempt : 0) + 1,
  };
  state.nextWorkOrder = null;
  state.resumeStageId = stage.id;
}

function recordReport(state, stage, agent, report) {
  if (!state.current || state.current.stageId !== stage.id) beginStage(state, stage);
  state.current.phase = 'manager-review';
  state.current.agent = agent;
  state.current.report = report;
}

function canRework(state, stageId) {
  const usedForStage = state.rework.byStage[stageId] || 0;
  const allowance = state.rework.maxPerStage + state.rework.extraApproved;
  const totalAllowance = state.rework.maxTotal + state.rework.extraApproved;
  return usedForStage < allowance && state.rework.total < totalAllowance;
}

function recordRework(state, stageId, verdict, reason) {
  state.rework.total++;
  state.rework.byStage[stageId] = (state.rework.byStage[stageId] || 0) + 1;
  state.history.push({
    at: new Date().toISOString(),
    action: 'rework',
    stageId,
    verdict,
    reason,
  });
}

function recordProceed(state, stage, nextStageId, workOrder = null) {
  state.completedStages[stage.id] = { status: 'passed', at: new Date().toISOString() };
  clearOutput(state, stage.output);
  state.current = null;
  state.resumeStageId = nextStageId;
  state.nextWorkOrder = nextStageId ? workOrder : null;
  state.status = nextStageId ? 'paused' : 'complete';
  state.pending = null;
}

function setPending(state, pending) {
  state.status = 'awaiting-human';
  state.pending = pending;
  state.resumeStageId = pending.resumeStageId;
  if (state.current) state.current.phase = 'awaiting-human';
}

function approveExtraRework(state) {
  state.rework.extraApproved++;
}

module.exports = {
  freshState,
  loadState,
  saveState,
  invalidateFrom,
  clearOutput,
  beginStage,
  recordReport,
  canRework,
  recordRework,
  recordProceed,
  setPending,
  approveExtraRework,
};
