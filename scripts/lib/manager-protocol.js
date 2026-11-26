'use strict';

const REPORT_START = '===== REPORT =====';
const REPORT_END = '===== REPORT END =====';
const DECISION_START = '===== DECISION =====';
const DECISION_END = '===== DECISION END =====';

function extractJsonBlock(text, start, end, label) {
  const pattern = new RegExp(`${start}\\r?\\n([\\s\\S]*?)\\r?\\n${end}`, 'g');
  const matches = [...text.matchAll(pattern)];
  if (matches.length > 1) throw new Error(`${label} 标记块只能出现一次`);
  if (!matches.length) return { body: text, data: null };
  let data;
  try {
    data = JSON.parse(matches[0][1].trim());
  } catch (error) {
    throw new Error(`${label} 标记块不是合法 JSON：${error.message}`);
  }
  return { body: text.replace(pattern, '').trimEnd(), data };
}

function requireString(value, field, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}.${field} 必须是非空字符串`);
}

function requireStringArray(value, field, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label}.${field} 必须是非空字符串数组`);
  }
}

function parseSpecialistReport(text) {
  const extracted = extractJsonBlock(text, REPORT_START, REPORT_END, 'REPORT');
  if (!extracted.data) return { body: extracted.body, report: null };
  const report = extracted.data;
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('REPORT 必须是 JSON 对象');
  requireString(report.status, 'status', 'REPORT');
  if (!['done', 'partial', 'blocked', 'needs-decision'].includes(report.status)) {
    throw new Error(`REPORT.status 不支持：${report.status}`);
  }
  requireString(report.summary, 'summary', 'REPORT');
  requireStringArray(report.completedTasks, 'completedTasks', 'REPORT');
  requireStringArray(report.evidence, 'evidence', 'REPORT');
  requireStringArray(report.issues, 'issues', 'REPORT');
  requireStringArray(report.unverified, 'unverified', 'REPORT');
  requireStringArray(report.decisionsNeeded, 'decisionsNeeded', 'REPORT');
  if (report.recommendedNextRole !== undefined) requireString(report.recommendedNextRole, 'recommendedNextRole', 'REPORT');
  return { body: extracted.body, report };
}

function validateWorkOrder(workOrder, label) {
  if (!workOrder || typeof workOrder !== 'object' || Array.isArray(workOrder)) {
    throw new Error(`${label}.workOrder 必须是对象`);
  }
  requireString(workOrder.objective, 'objective', `${label}.workOrder`);
  requireStringArray(workOrder.requiredChanges, 'requiredChanges', `${label}.workOrder`);
  requireStringArray(workOrder.acceptanceChecks, 'acceptanceChecks', `${label}.workOrder`);
  requireStringArray(workOrder.constraints, 'constraints', `${label}.workOrder`);
  requireStringArray(workOrder.outOfScope, 'outOfScope', `${label}.workOrder`);
}

function validateEscalation(escalation, label, stages, currentStageId) {
  if (!escalation || typeof escalation !== 'object' || Array.isArray(escalation)) {
    throw new Error(`${label}.escalation 必须是对象`);
  }
  requireString(escalation.question, 'question', `${label}.escalation`);
  requireString(escalation.whyCannotDecide, 'whyCannotDecide', `${label}.escalation`);
  requireStringArray(escalation.options, 'options', `${label}.escalation`);
  if (!escalation.options.length) throw new Error(`${label}.escalation.options 至少需要一项`);
  requireString(escalation.recommendation, 'recommendation', `${label}.escalation`);
  requireString(escalation.impact, 'impact', `${label}.escalation`);
  requireStringArray(escalation.evidence, 'evidence', `${label}.escalation`);
  requireString(escalation.resumeStageId, 'resumeStageId', `${label}.escalation`);
  requireString(escalation.recommendedAmend, 'recommendedAmend', `${label}.escalation`);
  const currentIdx = stages.findIndex((stage) => stage.id === currentStageId);
  const resumeIdx = stages.findIndex((stage) => stage.id === escalation.resumeStageId);
  if (resumeIdx === -1 || resumeIdx > currentIdx) {
    throw new Error(`${label}.escalation.resumeStageId 必须是当前阶段或更早的有效阶段`);
  }
  if (escalation.workOrder !== undefined && escalation.workOrder !== null) {
    validateWorkOrder(escalation.workOrder, `${label}.escalation`);
  }
}

function validateDecision(decision, context) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('DECISION 必须是 JSON 对象');
  requireString(decision.verdict, 'verdict', 'DECISION');
  requireString(decision.reason, 'reason', 'DECISION');
  const { verdict } = decision;
  const currentIdx = context.stages.findIndex((stage) => stage.id === context.currentStageId);
  if (currentIdx === -1) throw new Error('DECISION 上下文缺少有效当前阶段');

  if (context.mode === 'dispatch') {
    if (!['PROCEED', 'ESCALATE'].includes(verdict)) {
      throw new Error('启动派活只允许 PROCEED 或 ESCALATE');
    }
    if (verdict === 'PROCEED') {
      if (decision.nextStageId !== context.targetStageId) {
        throw new Error(`启动派活必须指定 nextStageId=${context.targetStageId}`);
      }
      validateWorkOrder(decision.workOrder, 'DECISION');
    }
  } else {
    if (decision.nextStageId !== undefined && decision.nextStageId !== null) {
      const nextIdx = context.stages.findIndex((stage) => stage.id === decision.nextStageId);
      if (nextIdx === -1) throw new Error(`DECISION.nextStageId 不存在：${decision.nextStageId}`);
    }
    if (verdict === 'PROCEED') {
      if (context.isFinalFull) throw new Error('最后一个专业阶段必须使用 COMPLETE 完成验收');
      const expectedNext = context.stages[currentIdx + 1] && context.stages[currentIdx + 1].id;
      if (decision.nextStageId !== expectedNext) {
        throw new Error(`PROCEED 必须进入紧邻的下一阶段：${expectedNext}`);
      }
      validateWorkOrder(decision.workOrder, 'DECISION');
    } else if (verdict === 'REWORK') {
      if (decision.nextStageId !== undefined && decision.nextStageId !== null && decision.nextStageId !== context.currentStageId) {
        throw new Error('REWORK 只能重跑当前阶段');
      }
      validateWorkOrder(decision.workOrder, 'DECISION');
    } else if (verdict === 'RETURN_UPSTREAM') {
      const targetIdx = context.stages.findIndex((stage) => stage.id === decision.nextStageId);
      if (targetIdx === -1 || targetIdx >= currentIdx) {
        throw new Error('RETURN_UPSTREAM 必须指定当前阶段之前的有效阶段');
      }
      validateWorkOrder(decision.workOrder, 'DECISION');
    } else if (verdict === 'COMPLETE') {
      if (!context.isFinalFull) throw new Error('只有完整流水线的最后阶段可以 COMPLETE');
      if (decision.nextStageId !== undefined && decision.nextStageId !== null) {
        throw new Error('COMPLETE 不能指定下一阶段');
      }
      const acceptance = decision.acceptance;
      if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
        throw new Error('DECISION.acceptance 必须是对象');
      }
      requireString(acceptance.summary, 'summary', 'DECISION.acceptance');
      requireStringArray(acceptance.remainingRisks, 'remainingRisks', 'DECISION.acceptance');
    } else if (verdict !== 'ESCALATE') {
      throw new Error(`不支持的 DECISION.verdict：${verdict}`);
    }
  }

  if (verdict === 'ESCALATE') {
    validateEscalation(decision.escalation, 'DECISION', context.stages, context.currentStageId);
  }
  if (context.mode === 'review' && !context.report && ['PROCEED', 'COMPLETE'].includes(verdict)) {
    throw new Error('专业阶段缺少有效 REPORT，不能放行或完成');
  }
  return decision;
}

function parseManagerDecision(text, context) {
  const extracted = extractJsonBlock(text, DECISION_START, DECISION_END, 'DECISION');
  if (!extracted.data) throw new Error('项目经理回复缺少 DECISION 标记块');
  const decision = validateDecision(extracted.data, context);
  return { body: extracted.body, decision };
}

function formatWorkOrder(workOrder) {
  if (!workOrder) return '（无）';
  return [
    `目标：${workOrder.objective}`,
    '',
    '必须完成：',
    ...workOrder.requiredChanges.map((item) => `- ${item}`),
    '',
    '验收检查：',
    ...workOrder.acceptanceChecks.map((item) => `- ${item}`),
    '',
    '约束：',
    ...workOrder.constraints.map((item) => `- ${item}`),
    '',
    '明确不做：',
    ...workOrder.outOfScope.map((item) => `- ${item}`),
  ].join('\n');
}

function formatEscalation(escalation) {
  return [
    `问题：${escalation.question}`,
    `项目经理无法决策的原因：${escalation.whyCannotDecide}`,
    '',
    '候选方案：',
    ...escalation.options.map((item, index) => `${index + 1}. ${item}`),
    '',
    `推荐：${escalation.recommendation}`,
    `影响：${escalation.impact}`,
    '',
    '证据：',
    ...escalation.evidence.map((item) => `- ${item}`),
    '',
    `建议续跑阶段：${escalation.resumeStageId}`,
  ].join('\n');
}

module.exports = {
  parseSpecialistReport,
  parseManagerDecision,
  formatWorkOrder,
  formatEscalation,
};
