import { basename, isAbsolute } from 'node:path';

/**
 * One rule of [cli] allow or deny: a program, by name or full path, then the arguments a command
 * must start with. "gh" covers every gh command, "gh issue list" only that one.
 */
export interface CommandRule {
  /** The rule as the owner wrote it. */
  text: string;
  program: string;
  args: string[];
}

export type CommandCheck = { allowed: true; rule: CommandRule } | { allowed: false; reason: string };

/** Splits a rule on spaces. There are no quotes: a rule names a program and its first words. */
export function parseCommandRule(text: string): CommandRule | string {
  const [program = '', ...args] = text.trim().split(/\s+/).filter((token) => token !== '');
  if (program === '') return 'a rule cannot be empty';
  if (program.includes('/') && !isAbsolute(program)) return `${JSON.stringify(program)} must be a program name or a full path`;
  return { text: [program, ...args].join(' '), program, args };
}

/** The name the model uses for a rule's program: "gh" for both "gh" and "/opt/homebrew/bin/gh". */
export function programName(rule: CommandRule): string {
  return isAbsolute(rule.program) ? basename(rule.program) : rule.program;
}

/** Whether a command (the program, then its arguments) starts with the rule's words. */
export function ruleMatches(rule: CommandRule, command: readonly string[]): boolean {
  const [program = '', ...args] = command;
  if (program !== rule.program && program !== programName(rule)) return false;
  return rule.args.every((arg, index) => args[index] === arg);
}

/**
 * Checks a command against the rules: a deny rule always wins, otherwise an allow rule must
 * match. The most specific matching allow rule is the one returned.
 */
export function checkCommand(command: readonly string[], allow: readonly CommandRule[], deny: readonly CommandRule[]): CommandCheck {
  if (command.length === 0 || command[0] === '') return { allowed: false, reason: 'the command is empty' };
  const denied = deny.find((rule) => ruleMatches(rule, command));
  if (denied !== undefined) return { allowed: false, reason: `[cli] deny has "${denied.text}"` };
  const matching = allow.filter((rule) => ruleMatches(rule, command)).sort((a, b) => b.args.length - a.args.length);
  const rule = matching[0];
  if (rule === undefined) {
    const allowed = allow.map((item) => `"${item.text}"`).join(', ') || 'nothing';
    return { allowed: false, reason: `[cli] allow has no rule for it (it allows ${allowed})` };
  }
  return { allowed: true, rule };
}
