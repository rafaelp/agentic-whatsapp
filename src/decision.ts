import type { Action, Decision } from './types.js';
import { errorMessage, isRecord } from './util.js';

/** Anything that turns a prompt into a decision: Antigravity CLI, Gemini CLI, or a test fake. */
export interface DecisionMaker {
  decide(prompt: string): Promise<Decision>;
}

const MAX_ACTIONS = 5;
const MAX_TEXT_LENGTH = 4_000;
const MAX_INSTRUCTIONS_LENGTH = 20_000;

/** JSON Schema of the decision, for engines that can enforce structured output. */
export const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['notify', 'reply', 'update_instructions'] },
          text: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['type'],
      },
    },
  },
  required: ['actions'],
};

/** Parses the model's answer as text, tolerating code fences or prose around the JSON. */
export function parseDecision(text: string): Decision {
  const json = extractJsonObject(text);
  if (json === null) throw new Error('The model did not answer with a JSON object');
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`The model answered with invalid JSON: ${errorMessage(error)}`);
  }
  return decisionFromValue(value);
}

/** Validates a parsed answer, dropping anything outside the action schema. */
export function decisionFromValue(value: unknown): Decision {
  if (!isRecord(value) || !Array.isArray(value.actions)) {
    throw new Error('The model answered without an "actions" list');
  }

  const actions: Action[] = [];
  const warnings: string[] = [];
  for (const raw of value.actions) {
    if (actions.length === MAX_ACTIONS) {
      warnings.push(`ignored actions after the first ${MAX_ACTIONS}`);
      break;
    }
    if (!isRecord(raw)) {
      warnings.push('ignored an action that is not an object');
      continue;
    }
    if (raw.type === 'notify' || raw.type === 'reply') {
      const text = cleanText(raw.text, MAX_TEXT_LENGTH);
      if (text === '') warnings.push(`ignored a ${raw.type} action without text`);
      else actions.push({ type: raw.type, text });
    } else if (raw.type === 'update_instructions') {
      const content = cleanText(raw.content, MAX_INSTRUCTIONS_LENGTH);
      if (content === '') warnings.push('ignored an update_instructions action without content');
      else actions.push({ type: 'update_instructions', content });
    } else {
      warnings.push(`ignored an action of unknown type ${JSON.stringify(raw.type)}`);
    }
  }
  return { actions, warnings };
}

/** The outermost {...} in a text. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start === -1 || end < start ? null : text.slice(start, end + 1);
}

function cleanText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
