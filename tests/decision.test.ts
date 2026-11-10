import { describe, expect, it } from 'vitest';
import { DECISION_SCHEMA, decisionFromValue, extractJsonObject, parseDecision } from '../src/decision.js';

describe('parseDecision', () => {
  it('accepts the documented actions', () => {
    const decision = parseDecision(
      JSON.stringify({
        actions: [
          { type: 'notify', text: ' Bob pediu o endereço ' },
          { type: 'reply', text: 'Já te mando!' },
          { type: 'update_instructions', content: '- Me avise sobre pagamentos' },
        ],
      }),
    );
    expect(decision.actions).toEqual([
      { type: 'notify', text: 'Bob pediu o endereço' },
      { type: 'reply', text: 'Já te mando!' },
      { type: 'update_instructions', content: '- Me avise sobre pagamentos' },
    ]);
    expect(decision.warnings).toEqual([]);
  });

  it('reads JSON wrapped in a code fence', () => {
    expect(parseDecision('```json\n{"actions": []}\n```').actions).toEqual([]);
  });

  it('rejects answers without an actions list', () => {
    expect(() => parseDecision('Não sei')).toThrow(/JSON object/);
    expect(() => parseDecision('{"action": "notify"}')).toThrow(/actions/);
    expect(() => parseDecision('{actions: [}')).toThrow(/invalid JSON/);
  });
});

describe('decisionFromValue', () => {
  it('drops unknown or incomplete actions with a warning', () => {
    const decision = decisionFromValue({
      actions: [{ type: 'run_shell', command: 'rm -rf ~' }, { type: 'notify' }, 'text', { type: 'notify', text: 'ok' }],
    });
    expect(decision.actions).toEqual([{ type: 'notify', text: 'ok' }]);
    expect(decision.warnings).toHaveLength(3);
  });

  it('keeps at most five actions and truncates long texts', () => {
    const many = Array.from({ length: 8 }, () => ({ type: 'notify', text: 'x'.repeat(5_000) }));
    const decision = decisionFromValue({ actions: many });
    expect(decision.actions).toHaveLength(5);
    expect(decision.actions[0]?.type === 'notify' && decision.actions[0].text.length).toBe(4_000);
  });
});

describe('DECISION_SCHEMA', () => {
  it('allows exactly the actions the policy knows', () => {
    expect(DECISION_SCHEMA.properties.actions.items.properties.type.enum).toEqual([
      'notify',
      'reply',
      'update_instructions',
    ]);
  });
});

describe('extractJsonObject', () => {
  it('returns the outermost object', () => {
    expect(extractJsonObject('Aqui: {"a": {"b": 1}} fim')).toBe('{"a": {"b": 1}}');
    expect(extractJsonObject('nada')).toBeNull();
  });
});
