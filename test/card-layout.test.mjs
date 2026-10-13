import test from 'node:test';
import assert from 'node:assert/strict';
import { cardSamples } from '../scripts/card-samples.mjs';
import { completionCard, effectiveStatus, queueCard, taskListCard } from '../src/cards.mjs';

function nodes(value, ancestors = [], result = []) {
  if (Array.isArray(value)) for (const child of value) nodes(child, ancestors, result);
  else if (value && typeof value === 'object') {
    result.push({ value, ancestors });
    for (const child of Object.values(value)) nodes(child, [...ancestors, value], result);
  }
  return result;
}

test('every card state has one large full-width primary and at most two secondary buttons per row', () => {
  for (const [name, card] of cardSamples()) {
    const all = nodes(card);
    const primary = all.filter(({ value }) => value.tag === 'button' && ['primary_filled', 'danger_filled'].includes(value.type));
    assert.equal(primary.length, 1, `${name}: one primary action`);
    assert.equal(primary[0].value.size, 'large', name);
    assert.equal(primary[0].value.width, 'fill', name);
    const row = primary[0].ancestors.findLast((node) => node.tag === 'column_set');
    if (row) assert.equal(row.columns.length, 1, `${name}: primary has its own row`);
    for (const { value, ancestors } of all.filter(({ value }) => value.tag === 'button')) {
      if (!['primary_filled', 'danger_filled'].includes(value.type)) assert.equal(value.size, 'medium', name);
      if (value.form_action_type) assert.equal(value.behaviors, undefined, `${name}: submit uses form semantics`);
      if (['danger', 'danger_filled'].includes(value.type)) assert.ok(value.confirm, `${name}: destructive actions retain confirmation`);
      const buttonRow = ancestors.findLast((node) => node.tag === 'column_set');
      if (buttonRow) assert.ok(buttonRow.columns.length <= 2, `${name}: no crowded action rows`);
    }
    assert.ok(all.filter(({ value }) => value.tag).length <= 200, `${name}: Card 2.0 element budget`);
  }
});

test('completed cards continue the exact task and do not offer a meaningless follow action', () => {
  const card = completionCard({ id: 'target', name: '整理记录', cwd: '/tmp/project' }, 'completed', '已整理');
  const buttons = nodes(card).map(({ value }) => value).filter((node) => node.tag === 'button');
  assert.equal(buttons[0].behaviors[0].value.action, 'send_form');
  assert.equal(buttons[0].behaviors[0].value.threadId, 'target');
  assert.equal(buttons.some((node) => node.behaviors?.[0].value.action === 'watch'), false);
});

test('grouping and filtering preserve the task numbers used by precise commands', () => {
  const threads = [
    { id: 'done', name: '已完成事项', status: { type: 'completed' } },
    { id: 'active', name: '正在做的事项', status: { type: 'active' } }
  ];
  const encoded = JSON.stringify(taskListCard(threads, { filter: 'active' }));
  assert.match(encoded, /2\. 正在做的事项/);
  assert.doesNotMatch(encoded, /1\. 正在做的事项/);
});

test('idle is not proof of successful completion', () => {
  assert.notEqual(effectiveStatus({ status: { type: 'idle' }, turns: [] }).label, '已完成');
  assert.equal(effectiveStatus({ status: { type: 'idle' }, turns: [{ status: 'failed' }] }).label, '执行失败');
});

test('uncertain submissions show a task lookup, never retry or cancel-as-unsent controls', () => {
  const card = queueCard([{ threadId: 'target', text: '补充', dispatchPaused: true, submissionUncertain: true }]);
  const actions = nodes(card).map(({ value }) => value).filter((node) => node.type === 'callback').map((node) => node.value.action);
  assert.ok(actions.includes('progress'));
  assert.equal(actions.includes('queue_retry'), false);
  assert.equal(actions.includes('queue_cancel'), false);
});
