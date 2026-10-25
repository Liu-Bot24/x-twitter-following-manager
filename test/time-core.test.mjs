import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../stats-core.js';
const core = globalThis.XFollowStatsCore;

test('city hints distinguish fixed offsets, standard time and American Samoa', () => {
  assert.match(core.formatUtcOffsetOptionLabel(5, 'en'), /Almaty/);
  assert.doesNotMatch(core.formatUtcOffsetOptionLabel(6, 'en'), /Almaty/);
  assert.match(core.formatUtcOffsetOptionLabel(-11, 'en'), /American Samoa/);
  assert.match(core.formatUtcOffsetOptionLabel(-11, 'zh-CN'), /美属萨摩亚/);
  assert.match(core.formatUtcOffsetOptionLabel(-5, 'en'), /standard/i);
  assert.match(core.formatUtcOffsetOptionLabel(10, 'zh-CN'), /标准时/);
  const summer = Date.parse('2026-07-01T12:00:00Z');
  const winter = Date.parse('2026-01-01T12:00:00Z');
  assert.match(core.formatTimestampInOffset(summer, -5, 'en'), /^7:00 AM/);
  assert.match(core.formatTimestampInOffset(winter, -5, 'en'), /^7:00 AM/);
});
