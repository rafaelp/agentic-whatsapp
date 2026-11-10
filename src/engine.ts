import { AntigravityCli } from './antigravity.js';
import type { EngineConfig, EngineKind } from './config.js';
import type { DecisionMaker } from './decision.js';
import { GeminiCli } from './gemini.js';
import type { MediaReader } from './media.js';

export interface Engine extends DecisionMaker {
  /** Writes the files the engine needs (workspace, settings, prompts). */
  prepare(): Promise<void>;
}

export function createEngine(config: EngineConfig, stateDir: string, systemPrompt: string): Engine {
  return config.kind === 'antigravity'
    ? new AntigravityCli(config, stateDir, systemPrompt)
    : new GeminiCli(config, stateDir, systemPrompt);
}

/** The engine as a reader of images and audio, when it can be one. */
export function mediaReaderOf(engine: Engine): MediaReader | undefined {
  return engine instanceof AntigravityCli ? engine : undefined;
}

export function engineLabel(kind: EngineKind): string {
  return kind === 'antigravity' ? 'Antigravity CLI' : 'Gemini CLI';
}
