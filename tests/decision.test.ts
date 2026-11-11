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

  it('unwraps a decision the model wrote inside a single action', () => {
    const inner = JSON.stringify({ actions: [{ type: 'notify', text: 'A senha é manga.' }] });
    expect(decisionFromValue({ actions: [{ type: 'reply', content: inner }] })).toEqual({
      actions: [{ type: 'notify', text: 'A senha é manga.' }],
      warnings: ['unwrapped a decision written inside an action'],
    });
    // Ordinary text, even text that starts with "{", stays as it is.
    expect(decisionFromValue({ actions: [{ type: 'notify', text: '{não é JSON}' }] }).actions).toEqual([
      { type: 'notify', text: '{não é JSON}' },
    ]);
  });

  it('keeps at most five actions and truncates long texts', () => {
    const many = Array.from({ length: 8 }, () => ({ type: 'notify', text: 'x'.repeat(5_000) }));
    const decision = decisionFromValue({ actions: many });
    expect(decision.actions).toHaveLength(5);
    expect(decision.actions[0]?.type === 'notify' && decision.actions[0].text.length).toBe(4_000);
  });
});

describe('highlight actions', () => {
  it('keep their reason and the IDs of the messages, deduplicated', () => {
    const decision = decisionFromValue({
      actions: [{ type: 'highlight', text: ' Bob pediu o boleto ', ids: ['M1', 'M1', 7, '', 'M2'] }],
    });
    expect(decision.actions).toEqual([{ type: 'highlight', text: 'Bob pediu o boleto', ids: ['M1', 'M2'] }]);
  });

  it('need a reason or some IDs', () => {
    expect(decisionFromValue({ actions: [{ type: 'highlight', ids: ['M1'] }] }).actions).toEqual([
      { type: 'highlight', text: '', ids: ['M1'] },
    ]);
    const empty = decisionFromValue({ actions: [{ type: 'highlight' }] });
    expect(empty.actions).toEqual([]);
    expect(empty.warnings).toEqual(['ignored a highlight action without text or ids']);
  });
});

describe('DECISION_SCHEMA', () => {
  it('allows exactly the actions the policy knows', () => {
    expect(DECISION_SCHEMA.properties.actions.items.properties.type.enum).toEqual([
      'notify',
      'reply',
      'update_instructions',
      'highlight',
    ]);
  });
});

describe('extractJsonObject', () => {
  it('returns the outermost object', () => {
    expect(extractJsonObject('Aqui: {"a": {"b": 1}} fim')).toBe('{"a": {"b": 1}}');
    expect(extractJsonObject('nada')).toBeNull();
  });
});
