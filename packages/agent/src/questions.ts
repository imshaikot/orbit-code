// Claude Code's AskUserQuestion: Claude asks the user a few multiple-choice questions. The call reaches Orbit as a
// can_use_tool request like any gated tool, and is answered the way Claude Code's own dialog answers it: an allow
// whose updatedInput is the input plus `answers`, question text → the picked option's label (several labels,
// comma-separated, for a multi-select question) or the user's own text. A deny skips the questions. Shapes as of
// Claude Code 2.1.267. Pure.

import type { Question, QuestionOption } from '@orbit-code/protocol';
import { oneLine } from './tools';

export const ASK_USER_QUESTION = 'AskUserQuestion';

/** More than Claude Code asks at once (four); only bounds what a malformed request could put on the card. */
const MAX_QUESTIONS = 12;
const MAX_ANSWER = 2000;

/** The questions of an AskUserQuestion request; undefined for any other tool, or when none is well formed. */
export function parseQuestions(tool: string, input: Record<string, unknown>): Question[] | undefined {
  if (tool !== ASK_USER_QUESTION || !Array.isArray(input.questions)) return undefined;
  const questions: Question[] = [];
  for (const item of input.questions) {
    // Answers are keyed by question text, so a repeated question could not be told apart.
    if (!isObject(item) || typeof item.question !== 'string' || !item.question.trim() || questions.some((q) => q.question === item.question)) continue;
    const options: QuestionOption[] = Array.isArray(item.options)
      ? item.options.flatMap((option) =>
          isObject(option) && typeof option.label === 'string' && option.label.trim()
            ? [{ label: option.label, ...(typeof option.description === 'string' && option.description ? { description: option.description } : {}) }]
            : [],
        )
      : [];
    questions.push({ question: item.question, ...(typeof item.header === 'string' && item.header ? { header: item.header } : {}), options, multiSelect: item.multiSelect === true });
    if (questions.length === MAX_QUESTIONS) break;
  }
  return questions.length > 0 ? questions : undefined;
}

/** `answers` as the CLI takes them, if it answers every question with some text; undefined otherwise. Other keys are dropped. */
export function checkAnswers(questions: readonly Question[], answers: unknown): Record<string, string> | undefined {
  if (!isObject(answers)) return undefined;
  const checked: Record<string, string> = {};
  for (const { question } of questions) {
    const value = Object.prototype.hasOwnProperty.call(answers, question) ? answers[question] : undefined;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    checked[question] = value.trim().slice(0, MAX_ANSWER);
  }
  return checked;
}

/** "Scope → Everything · Checks → Typecheck, Harness": the answers on one line, for the transcript. */
export function describeAnswers(questions: readonly Question[], answers: Readonly<Record<string, string>>): string {
  return questions.map(({ question, header }) => `${header ?? oneLine(question, 60)} → ${oneLine(answers[question] ?? '', 120)}`).join(' · ');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
